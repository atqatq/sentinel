'use strict';
/* ============================================================================
 * ledger/blocks.js — the §16.2 required-fields gate and payload hygiene.
 *
 * EVERY block, every class (build spec §16.2 — normative):
 *   class(W|A|N|S|D) · tenantId · actor(userId|'system') · onBehalfOf(null) ·
 *   role · sourceIp · sessionId · entity · entityId · action ·
 *   outcome(success|denied|error) · before · after · reason ·
 *   engineVersion · schemaVersion · at(UTC, RFC 3339)
 * plus seq · prevHash · hash, which the append path owns (seq is allocated
 * at write time and concatenated into the hash input, never hidden inside
 * the payload — §11's formula).
 *
 * Fail-closed discipline (the house rule): a missing field, an unknown class
 * or outcome, an undefined value (undefined DROPS silently from a JSON
 * serialization — an explicit null is the honest absence), a denial without
 * a reason (§16.2: reason is required for denials and overrides), a payload
 * carrying a forbidden field (§16.3 rule 3: no secrets or PII — credentials,
 * banking fields; the ingestion boundary discards banking fields already, so
 * this is the last-line scan), and a non-canonical instant all REFUSE with a
 * named code. Nothing ambiguous is hashed.
 *
 * canonicalInstant: the at-field contract. Canonical UTC, millisecond
 * precision, rendered `YYYY-MM-DDTHH:MM:SS.sssZ` (H4: canonical UTC; the
 * tenant timezone is a display concern). Sub-millisecond input REFUSES —
 * TIMESTAMPTZ(6) storage would round-trip microseconds that the hashed
 * string cannot carry, and a hash that cannot be recomputed from the stored
 * row is worse than no hash. Date inputs are inherently millisecond-precise.
 * ==========================================================================*/

const CLASSES = ['W', 'A', 'N', 'S', 'D'];
const OUTCOMES = ['success', 'denied', 'error'];

/* §16.2 payload fields — the exact key set of the hashed payload (seq, the
 * hashes and the DB identity columns are outside it). Order never matters
 * (canonicalJson sorts), but the SET is exact: a field missing or extra
 * shifts every future hash. */
const PAYLOAD_FIELDS = [
  'class', 'tenantId', 'actor', 'onBehalfOf', 'role', 'sourceIp', 'sessionId',
  'entity', 'entityId', 'action', 'outcome', 'before', 'after', 'reason',
  'engineVersion', 'schemaVersion', 'at',
];

/* §16.3 rule 3 — no secrets or PII in payloads. Field-NAME blocklist applied
 * case-insensitively at any depth of before/after (the stance is
 * refuse-known-bad-names, not pattern-guess content: a false positive would
 * poison a real audit trail, and the ingestion boundary discards banking
 * fields before anything reaches here — D-030). */
const FORBIDDEN_FIELDS = [
  'password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'api_key', 'authorization', 'cookie', 'sessionkey',
  'iban', 'cardnumber', 'card_number', 'cardno', 'cvv', 'cvc', 'pin',
  'bankaccount', 'bank_account', 'routingnumber', 'routing_number', 'ssn',
];

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/;

function fail(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  throw e;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function scanForbidden(value, path) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
        fail('LEDGER_PAYLOAD_FORBIDDEN_FIELD', `"${key}" at ${path} — no secrets or PII in payloads (§16.3 rule 3)`);
      }
      scanForbidden(value[key], `${path}.${key}`);
    }
  }
}

/* Canonical UTC instant, millisecond precision — the only `at` form that
 * exists in a ledger payload or a hash input. Accepts a Date or an RFC 3339
 * UTC string (Z or +00:00); sub-millisecond fractions REFUSE. */
function canonicalInstant(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) fail('LEDGER_AT_INVALID', 'not a valid Date');
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${input.getUTCFullYear()}-${pad(input.getUTCMonth() + 1, 2)}-${pad(input.getUTCDate(), 2)}`
      + `T${pad(input.getUTCHours(), 2)}:${pad(input.getUTCMinutes(), 2)}:${pad(input.getUTCSeconds(), 2)}`
      + `.${pad(input.getUTCMilliseconds(), 3)}Z`;
  }
  if (typeof input !== 'string') fail('LEDGER_AT_INVALID', 'at must be a Date or an RFC 3339 UTC string');
  const m = AT_RE.exec(input);
  if (!m) fail('LEDGER_AT_INVALID', 'at must be an RFC 3339 UTC instant (…T…Z or …+00:00) — naive and non-UTC datetimes refuse (H4)');
  const [, y, mo, d, h, mi, s, frac] = m;
  if (frac && frac.length > 3) {
    fail('LEDGER_AT_SUB_MILLISECOND', 'the hash covers millisecond precision — sub-ms instants would not round-trip from TIMESTAMPTZ(6) storage');
  }
  const Y = +y, MO = +mo, D = +d, H = +h, MI = +mi, S = +s;
  if (MO < 1 || MO > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 59) {
    fail('LEDGER_AT_INVALID', 'calendar ranges violated');
  }
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${pad(ms, 3)}Z`;
}

function checkString(value, name, { allowEmpty = false } = {}) {
  if (value === undefined) fail('LEDGER_FIELD_UNDEFINED', `${name} must be an explicit value (null when absent) — undefined drops silently from JSON`);
  if (value === null || typeof value !== 'string' || (!allowEmpty && value === '')) {
    fail('LEDGER_FIELD_INVALID', `${name} must be a non-empty string`);
  }
}

function checkOptionalString(value, name) {
  if (value === undefined) fail('LEDGER_FIELD_UNDEFINED', `${name} must be an explicit value (null when absent)`);
  if (value !== null && (typeof value !== 'string' || value === '')) {
    fail('LEDGER_FIELD_INVALID', `${name} must be null or a non-empty string`);
  }
}

/* Validates the §16.2 payload fields and returns the payload in the exact
 * canonical key set. Refuses, never coerces. `tenantId` is the fence uuid
 * (uuid-checked at the SQL boundary; format-checked loosely here so a stub
 * caller cannot hash a structurally impossible row). */
function buildBlock(input) {
  if (!isPlainObject(input)) fail('LEDGER_BLOCK_INVALID', 'the block must be a plain object');

  const out = {};
  for (const f of PAYLOAD_FIELDS) {
    if (input[f] === undefined) fail('LEDGER_FIELD_UNDEFINED', `${f} is required by §16.2 (explicit null when absent)`);
    out[f] = input[f];
  }
  for (const f of Object.keys(input)) {
    if (!PAYLOAD_FIELDS.includes(f)) fail('LEDGER_FIELD_UNKNOWN', `"${f}" is not a §16.2 payload field — a foreign key shifts every future hash`);
  }

  if (!CLASSES.includes(out.class)) fail('LEDGER_CLASS_INVALID', `"${out.class}" — class is one of W/A/N/S/D (§16.1)`);
  if (!OUTCOMES.includes(out.outcome)) fail('LEDGER_OUTCOME_INVALID', `"${out.outcome}" — outcome is success|denied|error (§16.2)`);

  checkString(out.tenantId, 'tenantId');
  if (!/^[0-9a-fA-F-]{36}$/.test(out.tenantId)) fail('LEDGER_TENANT_INVALID', 'tenantId must be the fence uuid');

  checkString(out.actor, 'actor'); // a userId or the literal 'system'
  checkOptionalString(out.onBehalfOf, 'onBehalfOf');
  checkOptionalString(out.role, 'role');
  checkOptionalString(out.sourceIp, 'sourceIp');
  checkOptionalString(out.sessionId, 'sessionId');

  if (out.actor !== 'system' && out.role === null) {
    fail('LEDGER_ROLE_REQUIRED', "a human principal carries its role — only actor 'system' may leave it null (§16.1 Class S)");
  }

  checkString(out.entity, 'entity');
  checkOptionalString(out.entityId, 'entityId');
  checkString(out.action, 'action');

  if (out.outcome === 'denied' && (out.reason === null || (typeof out.reason === 'string' && out.reason.trim() === ''))) {
    fail('LEDGER_REASON_REQUIRED', 'a denial carries its reason — §16.2');
  }
  checkOptionalString(out.reason, 'reason');

  if (out.before !== null && !isPlainObject(out.before) && !Array.isArray(out.before)) {
    fail('LEDGER_BEFORE_INVALID', 'before must be null or a JSON object/array (a diff, never "updated" — §16.1 Class W)');
  }
  if (out.after !== null && !isPlainObject(out.after) && !Array.isArray(out.after)) {
    fail('LEDGER_AFTER_INVALID', 'after must be null or a JSON object/array');
  }
  scanForbidden(out.before, 'before');
  scanForbidden(out.after, 'after');

  checkString(out.engineVersion, 'engineVersion');
  checkString(out.schemaVersion, 'schemaVersion');
  out.at = canonicalInstant(out.at);

  return out;
}

module.exports = {
  CLASSES, OUTCOMES, PAYLOAD_FIELDS, FORBIDDEN_FIELDS,
  buildBlock, canonicalInstant,
};
