'use strict';
/* ============================================================================
 * intelligence/policy.js — the egress allow-list door (build spec §14.20;
 * audit M13; named proof `intelligence/egress-allowlist`).
 *
 * The closed ecosystem's default-deny posture (§14.18 gate 6) holds; the
 * Intelligence node (screen 27, origin-only) is the ONE governed exception
 * and every outbound request passes THIS door, fail-closed, BEFORE any
 * transport can exist. The transport itself is unwired in this unit — no
 * HTTP client lives in the runtime surface — and when the Intelligence
 * runtime lands, its client goes through this door or does not go out.
 *
 * PURE decision layer (the ledger/auth posture): no IO, no env, no fetch,
 * no credential values — the allow-list carries the credential SLOT NAME,
 * never the secret. The hash composes the ledger module's RFC 8785
 * canonicalization (one canonicalization per system).
 *
 * Refusal order is normative (§14.20): prompt shape → host → role →
 * cross-tenant → fields. Every refusal is loud and named; an allowed request
 * yields the §16.4 log envelope — prompt HASH + field allow-list, never the
 * content.
 * ==========================================================================*/

const crypto = require('crypto');
const { jcs } = require('../../ledger');

/* ---- The explicit outbound set — policy data, not code (§14.20) -----------
 * One entry: the LLM analysis call. The field allow-list encodes the audit's
 * data classification — aggregates and item/ref names only; no prices-per-
 * supplier beyond what the analysis requires; no personnel data, ever.
 * Extending this list is a SPEC AMENDMENT, never a code edit.
 * The host is a hostname (never a URL literal — gate 6's URL-literal rule
 * keeps holding over the runtime surface) and must match EXACTLY. */
const ALLOW_LIST = Object.freeze([
  Object.freeze({
    id: 'llm-analysis',
    purpose: 'LLM analysis of procurement aggregates (screen 27 draft documents)',
    host: 'api.anthropic.com',
    credentialSource: 'SENTINEL_INTELLIGENCE_LLM_KEY',   // slot NAME — never the value
    consolidation: 'origin-explicit',
    fieldAllowList: Object.freeze([
      // item/ref names — the "names" half of the audit's classification
      'refName', 'sku', 'category',
      // period descriptors
      'periodStart', 'periodEnd', 'currencyCode',
      // aggregates — the "aggregates" half; per-supplier PRICES are absent by design
      'activeRefs', 'deliveryCount', 'consumptionTotal', 'consumptionPerDelivery',
      'coverDays', 'runOutDays', 'stockoutCount',
      'openPoCount', 'openPoWaiting', 'overduePoCount', 'partialPoCount',
      'leadTimeP80', 'fillRate', 'onTimeRate', 'savingsTotal',
    ]),
  }),
]);

const HOSTS = new Map(ALLOW_LIST.map((e) => [e.host, e]));

function refusal(reason, detail) {
  return { verdict: 'REFUSED', reason, detail };
}

/* ---- The door — classifyEgress (§14.20, normative verdicts) ---------------
 * request: {
 *   host,          // the resolved target hostname (exact match required)
 *   role,          // the caller's role — 'origin' for the Intelligence surface
 *   tenantScope,   // a tenant id (string) or an explicit array of tenant ids
 *   consolidation, // boolean — the explicit Origin consolidation flag
 *   prompt: {      // the envelope: operator text SEPARATED from ingested data
 *     instructions,
 *     dataFields: [ { name, value }, ... ],
 *   },
 * }
 *
 * → { verdict: 'REFUSED', reason, detail }
 * | { verdict: 'ALLOWED', entry: {id, purpose}, envelope }                  */
function classifyEgress(request) {
  const req = (request && typeof request === 'object') ? request : null;

  /* 1 · the prompt envelope — the injection stance's structural core. The
   * separation of operator-authored instructions from ingested data fields
   * is not stylistic: a merged blob refuses before anything else is judged. */
  const prompt = req && req.prompt;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
    return refusal('EGRESS_PROMPT_MALFORMED', 'prompt envelope must separate instructions from dataFields');
  }
  if (typeof prompt.instructions !== 'string') {
    return refusal('EGRESS_PROMPT_MALFORMED', 'instructions must be a string');
  }
  const dataFields = prompt.dataFields;
  if (!Array.isArray(dataFields)) {
    return refusal('EGRESS_PROMPT_MALFORMED', 'dataFields must be an array of {name, value}');
  }
  for (const df of dataFields) {
    if (!df || typeof df !== 'object' || Array.isArray(df)
      || typeof df.name !== 'string' || df.name === '') {
      return refusal('EGRESS_PROMPT_MALFORMED', 'every dataField carries a non-empty string name');
    }
    /* The honest absence is null (the §16.2 canon): canonicalizeJson drops
     * undefined silently, so an undefined value would hash over a payload
     * that is not what the caller believes is leaving. Refuse, never drop. */
    if (df.value === undefined) {
      return refusal('EGRESS_PROMPT_MALFORMED', 'the honest absence is null — an undefined dataField value would drop silently from the hashed payload');
    }
  }

  /* 2 · the host — exact match against the allow-list; a lookalike refuses. */
  const entry = req && typeof req.host === 'string' ? HOSTS.get(req.host) : undefined;
  if (!entry) {
    return refusal('EGRESS_HOST_NOT_ALLOW_LISTED',
      `host ${(req && req.host) || '(absent)'} is not on the explicit outbound set`);
  }

  /* 3 · the role — screen 27 is origin-only; the permission matrix holds at
   * the egress boundary too (checked BEFORE the cross-tenant verdict so a
   * non-origin caller learns nothing about consolidation policy). */
  if (req.role !== 'origin') {
    return refusal('EGRESS_ORIGIN_ONLY', `role ${(req.role) || '(absent)'} cannot egress; the Intelligence view is origin-only`);
  }

  /* 4 · the tenant scope — tenant-scoped by default; consolidation is an
   * explicit, logged act and never a silent aggregate. */
  const scope = req.tenantScope;
  const multi = Array.isArray(scope) && scope.length > 1;
  if (multi && req.consolidation !== true) {
    return refusal('EGRESS_CROSS_TENANT_REFUSED',
      'a multi-tenant request requires the explicit Origin consolidation flag');
  }

  /* 5 · the fields — ANY disallowed field refuses the whole request (the
   * audit's acceptance scenario: rejected before the API call, never
   * redacted-after-the-fact). */
  const allowed = new Set(entry.fieldAllowList);
  const seen = new Set();
  for (const df of dataFields) {
    if (seen.has(df.name)) continue;
    seen.add(df.name);
    if (!allowed.has(df.name)) {
      return refusal('EGRESS_FIELD_NOT_ALLOW_LISTED',
        `field "${df.name}" is not on the "${entry.id}" allow-list — one disallowed field refuses the request`);
    }
  }

  /* The §16.4 log envelope — prompt HASH + field allow-list, NEVER the
   * content: the text and the values never enter the envelope, the log, or
   * the ledger. The hash covers the exact payload that would leave, in RFC
   * 8785 canonical form (the H5 chain's JCS — one canonicalization). */
  const fields = Array.from(seen).sort();
  const promptHash = crypto
    .createHash('sha256')
    .update(jcs.canonicalizeJson({ instructions: prompt.instructions, dataFields }))
    .digest('hex');

  return {
    verdict: 'ALLOWED',
    entry: { id: entry.id, purpose: entry.purpose },
    envelope: {
      host: entry.host,
      purpose: entry.purpose,
      fields,
      promptHash,
      tenantScope: Array.isArray(scope) ? [...scope].sort() : scope,
      consolidation: req.consolidation === true,
    },
  };
}

module.exports = { ALLOW_LIST, classifyEgress };
