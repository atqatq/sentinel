"use client"

import * as React from "react"

/*
 * SetupWizard — the client half of the §14.28 setup screen (D-049).
 * Transport concerns only: fetches, form state, verbatim refusals. Every
 * DECISION lives in the pure setup module (the remainingSteps derivation,
 * the command validators) and in the adapters — this file never invents a
 * rule, never coerces a refusal into a success, never hides a reason.
 *
 * The flow: /api/setup/overview on mount → 401 (sign in) → 403
 * SETUP_NOT_ORIGIN (the refusal IS the screen) → 403 SESSION_MUST_CHANGE
 * (the rotation interstitial — POST /api/auth/password clears it) → the
 * wizard: the remaining steps render first (§14.10: gaps, never
 * confirmations), each with its command form.
 */

type Overview = {
  hasOrigin: boolean
  tenantCount: number
  userCount: number
  hasApprovalLimits: boolean
  tenants: Array<{
    id: string
    code: string
    name: string
    currencyCode: string
    timezone: string
    myRole: string | null
    users: Array<{ id: string; email: string; displayName: string; role: string }>
    hasApprovalLimits: boolean
    approvalConfig: { currencyCode: string; dualThresholdAmount: number } | null
    approvalLimits: Array<{ role: string; maxSingleAmount: number | null }>
    hasFirstIngestion: boolean
  }>
}

type Step = { step: string; label: string; detail: string }

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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={`${SURFACE} p-4`}>
      <h2 className="mb-3 font-sans text-[14px] font-semibold leading-[20px] text-text">{title}</h2>
      {children}
    </section>
  )
}

/* The forced-change interstitial — the ONE screen a must-change session
 * sees before any setup (§14.28 clause 2). The rotation re-authenticates. */
function MustChangeInterstitial({ onCleared }: { onCleared: () => void }) {
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok && body.verdict === "OK") {
      onCleared()
      return
    }
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  return (
    <Card title="Rotate your password first">
      <p className="mb-3 max-w-[64ch] font-sans text-[12.5px] leading-[18px] text-text-2">
        This account&rsquo;s password was provisioned for you — it was never chosen. Choose a new
        one before anything else: a password the account has never chosen must not govern a
        setup. Every other session of yours is signed out by the rotation.
      </p>
      <form onSubmit={submit} className="flex max-w-[420px] flex-col gap-3">
        <Field label="Current password">
          <input className={INPUT} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="New password (12+ characters, 3+ character classes)">
          <input className={INPUT} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
        <div><Button busy={busy}>Rotate and continue</Button></div>
      </form>
    </Card>
  )
}

function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = React.useState({ code: "", name: "", currencyCode: "", timezone: "" })
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    const res = await fetch("/api/setup/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok && body.verdict === "OK") {
      setForm({ code: "", name: "", currencyCode: "", timezone: "" })
      onDone()
      return
    }
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  return (
    <form onSubmit={submit} className="flex max-w-[560px] flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tenant code (2–32 chars; letters, digits, dash, underscore)">
          <input className={INPUT} value={form.code} onChange={set("code")} placeholder="QatarMP" required />
        </Field>
        <Field label="Name">
          <input className={INPUT} value={form.name} onChange={set("name")} placeholder="Qatar MP" required />
        </Field>
        <Field label="Currency (ISO 4217)">
          <input className={INPUT} value={form.currencyCode} onChange={set("currencyCode")} placeholder="QAR" required />
        </Field>
        <Field label="Timezone (IANA)">
          <input className={INPUT} value={form.timezone} onChange={set("timezone")} placeholder="Asia/Qatar" required />
        </Field>
      </div>
      {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
      <div><Button busy={busy}>Create tenant (founder door)</Button></div>
    </form>
  )
}

function CreateUserForm({ tenants }: { tenants: Overview["tenants"] }) {
  const [form, setForm] = React.useState({ email: "", displayName: "", password: "", role: "BYR", tenantCode: tenants[0]?.code ?? "" })
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    const res = await fetch("/api/setup/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok && body.verdict === "OK") {
      setForm((f) => ({ ...f, email: "", displayName: "", password: "" }))
      return
    }
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  return (
    <form onSubmit={submit} className="flex max-w-[560px] flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email">
          <input className={INPUT} type="email" value={form.email} onChange={set("email")} required />
        </Field>
        <Field label="Display name">
          <input className={INPUT} value={form.displayName} onChange={set("displayName")} required />
        </Field>
        <Field label="Initial password (they change it at first sign-in)">
          <input className={INPUT} type="password" value={form.password} onChange={set("password")} autoComplete="new-password" required />
        </Field>
        <Field label="Tenant">
          <select className={INPUT} value={form.tenantCode} onChange={set("tenantCode")}>
            {tenants.map((t) => (
              <option key={t.id} value={t.code}>{t.code}</option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <select className={INPUT} value={form.role} onChange={set("role")}>
            {["O", "SCM", "SBR", "BYR", "DTA", "VWR"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
      </div>
      <p className="font-sans text-[11.5px] leading-[16px] text-text-3">
        The account lands with must_change — its user rotates the password at first sign-in.
        The database re-proves your O in the target tenant on the grant.
      </p>
      {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
      <div><Button busy={busy}>Create account</Button></div>
    </form>
  )
}

function LimitsForm({ tenant }: { tenant: Overview["tenants"][number] }) {
  const [threshold, setThreshold] = React.useState<string>(tenant.approvalConfig ? String(tenant.approvalConfig.dualThresholdAmount) : "")
  const [limits, setLimits] = React.useState<Record<string, string>>(() => {
    const base: Record<string, string> = {}
    for (const r of ["SCM", "SBR", "BYR", "DTA", "VWR"]) {
      const found = tenant.approvalLimits.find((l) => l.role === r)
      base[r] = found ? (found.maxSingleAmount === null ? "" : String(found.maxSingleAmount)) : ""
    }
    return base
  })
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    const payload = {
      dualThresholdAmount: Number(threshold),
      limits: [
        { role: "O", maxSingleAmount: null },
        ...["SCM", "SBR", "BYR", "DTA", "VWR"].map((role) => ({
          role,
          maxSingleAmount: limits[role].trim() === "" ? null : Number(limits[role]),
        })),
      ],
    }
    const res = await fetch("/api/setup/limits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok && body.verdict === "OK") return
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  return (
    <form onSubmit={submit} className="flex max-w-[560px] flex-col gap-3">
      <Field label={`Dual-control threshold (${tenant.currencyCode}, per tenant)`}>
        <input className={INPUT} type="number" min="0" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} required />
      </Field>
      <div className="grid grid-cols-5 gap-2">
        {["SCM", "SBR", "BYR", "DTA", "VWR"].map((role) => (
          <Field key={role} label={role}>
            <input className={INPUT} type="number" min="0" step="any" value={limits[role]} onChange={(e) => setLimits((l) => ({ ...l, [role]: e.target.value }))} placeholder="∞" />
          </Field>
        ))}
      </div>
      <p className="font-sans text-[11.5px] leading-[16px] text-text-3">
        An empty ceiling is unlimited (the O shape — O holds the ladder&rsquo;s widest limit by
        construction). The §16 amendment rides the same Origin-only policies the gate enforces.
      </p>
      {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
      <div><Button busy={busy}>Save approval limits</Button></div>
    </form>
  )
}

export function SetupWizard() {
  const [state, setState] = React.useState<
    | { phase: "loading" }
    | { phase: "unauthorized" }
    | { phase: "refused"; reason: string; detail?: string }
    | { phase: "mustChange" }
    | { phase: "ready"; overview: Overview; steps: Step[] }
  >({ phase: "loading" })

  const load = React.useCallback(async () => {
    const res = await fetch("/api/setup/overview")
    if (res.status === 401) { setState({ phase: "unauthorized" }); return }
    const body = await res.json().catch(() => ({}))
    if (res.status === 403) {
      if (body.reason === "SESSION_MUST_CHANGE") setState({ phase: "mustChange" })
      else setState({ phase: "refused", reason: String(body.reason || "SETUP_NOT_ORIGIN"), detail: body.detail })
      return
    }
    if (res.ok && body.verdict === "OK") setState({ phase: "ready", overview: body.overview, steps: body.remainingSteps })
    else setState({ phase: "refused", reason: String(body.reason || body.verdict || "ERROR"), detail: body.message })
  }, [])

  React.useEffect(() => { void load() }, [load])

  if (state.phase === "loading") {
    return <p className="font-sans text-[13px] leading-[18px] text-text-2">Reading the setup state…</p>
  }
  if (state.phase === "unauthorized") {
    return (
      <section className={`${SURFACE} p-4`}>
        <p className="font-sans text-[13px] leading-[18px] text-text">Sign in first.</p>
        <p className="mt-1 font-mono text-[11px] leading-[16px] text-text-3">SESSION_REQUIRED — the wizard rides the Origin&rsquo;s own session.</p>
        <p className="mt-2 font-sans text-[12.5px] leading-[18px] text-text-2">
          The door is <a className="underline underline-offset-2" href="/signin">/signin</a> — sign
          in there and this wizard resumes where the session lands it.
        </p>
      </section>
    )
  }
  if (state.phase === "refused") {
    return (
      <section className={`${SURFACE} p-4`}>
        <Refusal reason={state.reason} detail={state.detail} />
        <p className="mt-2 font-sans text-[12.5px] leading-[18px] text-text-2">
          The setup layer is the Origin&rsquo;s. The database re-proves every write&rsquo;s authority
          itself — this refusal is the contract, not an error.
        </p>
      </section>
    )
  }
  if (state.phase === "mustChange") {
    return <MustChangeInterstitial onCleared={() => { setState({ phase: "loading" }); void load() }} />
  }

  const o = state.overview
  const steps: Step[] = state.steps
  return (
    <div className="flex flex-col gap-4">
      <Card title="Overview — what exists, what&rsquo;s missing">
        <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-[12px] leading-[17px] text-text-2">
          <span>origin: {o.hasOrigin ? "present" : "MISSING"}</span>
          <span>tenants: {o.tenantCount}</span>
          <span>users: {o.userCount}</span>
          <span>approval limits: {o.hasApprovalLimits ? "set" : "MISSING"}</span>
          <span>first ingestion: {o.tenants.some((t) => t.hasFirstIngestion) ? "done" : "PENDING"}</span>
        </div>
        {steps.length > 0 ? (
          <ol className="mt-3 flex flex-col gap-2">
            {steps.map((s) => (
              <li key={s.step} className="flex flex-col">
                <span className="font-sans text-[13px] font-medium leading-[18px] text-text">{s.label}</span>
                <span className="font-sans text-[12px] leading-[17px] text-text-2">{s.detail}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 font-sans text-[13px] leading-[18px] text-text-2">Setup is complete — the register carries no gaps.</p>
        )}
      </Card>

      <Card title="Tenants — the founder door">
        <div className="mb-3 flex flex-col gap-1">
          {o.tenants.map((t) => (
            <p key={t.id} className="font-mono text-[12px] leading-[17px] text-text-2">
              {t.code} · {t.name} · {t.currencyCode} · {t.timezone} · my role: {t.myRole ?? "—"} · users: {t.users.length} · first ingestion: {t.hasFirstIngestion ? "done" : "pending"}
            </p>
          ))}
        </div>
        <CreateTenantForm onDone={() => { setState({ phase: "loading" }); void load() }} />
      </Card>

      {o.tenants.length > 0 ? (
        <Card title="Users & roles">
          <div className="mb-3 flex flex-col gap-1">
            {o.tenants.flatMap((t) =>
              t.users.map((u) => (
                <p key={`${t.id}-${u.id}`} className="font-mono text-[12px] leading-[17px] text-text-2">
                  {t.code} · {u.email} · {u.displayName} · {u.role}
                </p>
              )),
            )}
          </div>
          <CreateUserForm tenants={o.tenants} />
        </Card>
      ) : null}

      {o.tenants.filter((t) => t.myRole !== null).length > 0 ? (
        <Card title="Approval limits — the §16 amendment">
          {o.tenants.filter((t) => t.myRole !== null).map((t) => (
            <div key={t.id} className="mb-4">
              <p className="mb-2 font-mono text-[12px] leading-[17px] text-text-2">{t.code}</p>
              <LimitsForm key={t.id} tenant={t} />
            </div>
          ))}
        </Card>
      ) : null}

      <Card title="First ingestion">
        <p className="mb-3 max-w-[70ch] font-sans text-[12.5px] leading-[18px] text-text-2">
          Upload the combined template workbook (Mode B) or a raw Precoro export (Mode A) —
          the worker&rsquo;s own pipeline runs in-process under the same fence, so the receipt,
          the register, the fan-out and the holds staging are the daemon&rsquo;s own objects.
          The watched-folder inbox remains the day-to-day transport.
        </p>
        <UploadForm tenants={o.tenants} onDone={() => { setState({ phase: "loading" }); void load() }} />
      </Card>
    </div>
  )
}

/* The §14.28 clause-5 upload — the first ingestion from Origin. The receipt
 * renders verbatim: verdict, counters, disclosures, holds. A pipeline fault
 * is a 500 with the phase named — the transaction rolled back, the register
 * carries no guess. */
function UploadForm({ tenants, onDone }: { tenants: Overview["tenants"]; onDone: () => void }) {
  const [file, setFile] = React.useState<File | null>(null)
  const [mode, setMode] = React.useState<"A" | "B">("A")
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<{ reason: string; detail?: string } | null>(null)
  const [receipt, setReceipt] = React.useState<Record<string, unknown> | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setRefusal(null)
    setReceipt(null)
    const fd = new FormData()
    fd.append("file", file)
    fd.append("mode", mode)
    const res = await fetch("/api/setup/ingest", { method: "POST", body: fd })
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok && body.verdict === "OK") {
      setReceipt(body.receipt || {})
      onDone()
      return
    }
    setRefusal({ reason: String(body.reason || body.verdict || "ERROR"), detail: body.detail || body.message })
  }

  const counters = receipt ? (receipt.counters as Record<string, number> | undefined) : undefined
  const disclosures = receipt ? (receipt.disclosures as string[] | undefined) : undefined
  const holds = receipt ? (receipt.holds as Record<string, number> | undefined) : undefined

  return (
    <form onSubmit={submit} className="flex max-w-[560px] flex-col gap-3">
      <Field label="File (.xlsx workbook or .csv export, ≤ 64 MB)">
        <input
          className={INPUT}
          type="file"
          accept=".xlsx,.csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </Field>
      <Field label="Mode">
        <select className={INPUT} value={mode} onChange={(e) => setMode(e.target.value === "B" ? "B" : "A")}>
          <option value="A">A — raw Precoro export (header-signature auto-detect)</option>
          <option value="B">B — the combined 8-tab template workbook</option>
        </select>
      </Field>
      {refusal ? <Refusal reason={refusal.reason} detail={refusal.detail} /> : null}
      <div><Button busy={busy}>Run the pipeline</Button></div>
      {receipt ? (
        <div className="mt-1 flex flex-col gap-1 rounded-sm border border-line bg-canvas p-3">
          <p className="font-mono text-[12px] leading-[17px] text-text">
            verdict: <span style={{ color: receipt.verdict === "APPLIED" ? "var(--ok)" : receipt.verdict === "QUARANTINED" ? "var(--critical)" : "var(--warn)" }}>{String(receipt.verdict)}</span>
          </p>
          {counters ? (
            <p className="font-mono text-[11px] leading-[16px] text-text-2">
              read {counters.rowsRead} · applied {counters.rowsApplied} · quarantined {counters.rowsQuarantined} · unresolved units {counters.unresolvedUnits}
            </p>
          ) : null}
          {holds && Object.keys(holds).length > 0 ? (
            <p className="font-mono text-[11px] leading-[16px] text-text-2">
              holds: staged {holds.staged} · deduped {holds.deduped} · diverged {holds.diverged} · tasks {holds.tasks}
            </p>
          ) : null}
          {disclosures && disclosures.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {disclosures.map((d, i) => (
                <li key={i} className="font-mono text-[10.5px] leading-[15px] text-text-3">{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
