"use client"

import * as React from "react"

import { landingFor, type LoginPrincipal } from "../../lib/signin"

/*
 * SignInForm — the client half of the sign-in door. Transport concerns
 * only: the fetch, the form state, the verbatim verdicts. The landing
 * decision is the pure map (lib/signin); this file never invents a rule,
 * never coerces a refusal into a success, never hides a reason.
 *
 * The two-step challenge is stateless server-side (D-031): MFA_REQUIRED
 * means the SAME route answers to the same credentials plus the code —
 * the form keeps them; the server keeps no challenge state.
 */

const SURFACE = "rounded-md border border-line bg-surface"
const LABEL = "block font-sans text-[12px] font-medium leading-[16px] text-text-2"
const INPUT =
  "h-[32px] w-full rounded-sm border border-line-strong bg-canvas px-2.5 font-sans text-[13px] leading-none text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-info"

function Refusal({ reason, detail }: { reason: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-[11px] leading-[16px]" style={{ color: "var(--critical)" }}>
        {reason}
      </p>
      {detail ? <p className="font-mono text-[10.5px] leading-[15px] text-text-3">{detail}</p> : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  )
}

function Button({ children, busy, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy === true}
      className="inline-flex h-[32px] items-center rounded-sm bg-[var(--text)] px-3 font-sans text-[13px] font-medium leading-none text-[var(--inv)] transition-opacity hover:opacity-90 disabled:opacity-50"
      {...rest}
    >
      {busy ? "Working…" : children}
    </button>
  )
}

export function SignInForm() {
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [code, setCode] = React.useState("")
  const [mfaRequired, setMfaRequired] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mfaRequired ? { email, password, code } : { email, password }),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)

    if (res.ok && body.verdict === "OK") {
      /* ISSUE — the cookie is already set (httpOnly); the landing is the
       * pure map's decision, not this file's. */
      window.location.assign(landingFor(body.principal as LoginPrincipal))
      return
    }
    if (res.ok && body.verdict === "MFA_REQUIRED") {
      /* CHALLENGE_MFA — the same form grows its code step; the credentials
       * stay in state because the route re-verifies them (stateless). */
      setMfaRequired(true)
      return
    }
    /* REFUSED (401; 423 AUTH_LOCKED) · INVALID_REQUEST (400) · ERROR (500)
     * — verbatim, never softened. */
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  return (
    <section className={`${SURFACE} max-w-[420px] p-4`}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Email">
          <input
            className={INPUT}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password">
          <input
            className={INPUT}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {mfaRequired ? (
          <Field label="Authenticator code">
            <input
              className={INPUT}
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              required
            />
            <span className="font-mono text-[10.5px] leading-[15px] text-text-3">
              MFA_REQUIRED — the account carries a verified TOTP enrolment; the challenge rides
              this same route as its second step.
            </span>
          </Field>
        ) : null}
        <div>
          <Button busy={busy}>Sign in</Button>
        </div>
        {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
      </form>
    </section>
  )
}
