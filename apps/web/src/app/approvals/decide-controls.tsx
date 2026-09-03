"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

/*
 * DecideControls — the client half of the §14.13c approvals tray: one
 * PENDING conversion-factor version's decide actions, riding the
 * POST /api/approvals/cf transport (whose semantics live in
 * procure-service.handleCfDecision — this component owns NO governance
 * arithmetic; it renders the gate's refusals verbatim instead of guessing
 * which the outcome was).
 *
 * Identity is NEVER carried in the body (M11): the session decides whose
 * hand is on the decision — a body-carried tenantId/actor is refused by
 * name at the transport, and this component never sends one.
 *
 * The receipt shape is the gate's own: 200 APPLIED/REJECTED · 400
 * request-shape · 403 gate denial (SoD, eligibility, reason) · 404
 * VERSION_NOT_FOUND · 500 wiring. A refusal re-renders the row with the
 * gate's message; the tray refreshes only on success (the server
 * component re-reads the same reader the transport serves).
 */
export function DecideControls({ versionId }: { versionId: string }) {
  const router = useRouter()
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState<"APPLY" | "REJECT" | null>(null)
  const [feedback, setFeedback] = React.useState<{ ok: boolean; text: string } | null>(null)

  const decide = async (decision: "APPLY" | "REJECT") => {
    setBusy(decision)
    setFeedback(null)
    try {
      const res = await fetch("/api/approvals/cf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId, decision, ...(decision === "REJECT" && reason.trim() !== "" ? { reason: reason.trim() } : {}) }),
      })
      const json = (await res.json().catch(() => null)) as
        | { verdict?: string; reason?: string; detail?: string; message?: string }
        | null
      if (res.ok) {
        setFeedback({ ok: true, text: decision === "APPLY" ? "Applied — the factor froze in and the re-derivation tasks landed." : "Rejected — the reason is on the record." })
        router.refresh()
      } else {
        const text =
          json?.reason === "SOD_DECIDER_IS_REQUESTER"
            ? "The gate refused: the requester cannot decide their own request (SoD spine)."
            : json?.reason === "NOT_ELIGIBLE_VERIFIER"
              ? "The gate refused: your role is not an eligible decider for this tier."
              : json?.reason === "MISSING_REASON"
                ? "The gate refused: a rejection carries its reason — type one and retry."
                : json?.detail || json?.message || `The gate refused (${res.status}).`
        setFeedback({ ok: false, text })
      }
    } catch (e) {
      setFeedback({ ok: false, text: `The decision did not reach the gate: ${(e as Error).message}` })
    } finally {
      setBusy(null)
    }
  }

  const inputId = `reject-reason-${versionId}`

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void decide("APPLY")}
          disabled={busy !== null}
          className="rounded-md border border-line bg-surface px-3 py-1.5 font-sans text-[12.5px] font-semibold leading-[18px] text-text hover:bg-surface-2 disabled:opacity-50"
          style={{ borderColor: "var(--ok)" }}
        >
          {busy === "APPLY" ? "Applying…" : "Approve & apply"}
        </button>
        <button
          type="button"
          onClick={() => void decide("REJECT")}
          disabled={busy !== null}
          className="rounded-md border border-line bg-surface px-3 py-1.5 font-sans text-[12.5px] font-semibold leading-[18px] text-text hover:bg-surface-2 disabled:opacity-50"
          style={{ borderColor: "var(--critical)" }}
        >
          {busy === "REJECT" ? "Rejecting…" : "Reject"}
        </button>
        <label htmlFor={inputId} className="sr-only">
          Rejection reason (required by the gate on reject)
        </label>
        <input
          id={inputId}
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="rejection reason — the gate requires it"
          className="min-w-[220px] flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 font-sans text-[12.5px] leading-[18px] text-text placeholder:text-text-3"
        />
      </div>
      {feedback ? (
        <p
          role="status"
          className="font-sans text-[12px] leading-[17px]"
          style={{ color: feedback.ok ? "var(--ok)" : "var(--critical)" }}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
