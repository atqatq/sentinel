'use strict';
/* ============================================================================
 * setup/src/validate.js — the command validators (§14.28 clauses 1, 3, 4).
 *
 * Shape decisions live here BEFORE any statement is built (the
 * statement-first discipline). The unique-key collisions (origin exists,
 * tenant code taken, email taken) are the DATABASE's to surface — a
 * validator cannot know them and must not pretend to; the adapter maps
 * those violations to SETUP_ORIGIN_EXISTS / SETUP_TENANT_CODE_TAKEN /
 * SETUP_EMAIL_TAKEN by name.
 * ==========================================================================*/

/* The user_role enum ladder (0003_controls) — the setup role picker's
 * universe. Granting O is lawful (the DB's own controls_origin_only
 * governs it); this module adds no second opinion. */
const ROLE_LADDER = Object.freeze(['O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR']);

function shapeRefusal(detail) {
  return { ok: false, reason: 'SETUP_SHAPE_INVALID', detail };
}

function asTrimmedString(v) {
  return typeof v === 'string' ? v.trim() : null;
}

/* The tenant command — §14.28 clause 3. The door re-proves every one of
 * these shapes in SQL; this validator is why a malformed command sends
 * ZERO statements. */
function validateTenantCommand(cmd, opts) {
  if (!cmd || typeof cmd !== 'object') return shapeRefusal('the tenant command must be an object');
  const o = opts || {};
  if (!Array.isArray(o.tzList) || o.tzList.length === 0) {
    return shapeRefusal('the timezone allowlist is injected (the boundary passes Intl.supportedValuesOf("timeZone"))');
  }

  const code = asTrimmedString(cmd.code);
  if (code === null || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(code)) {
    return shapeRefusal('code must be 2..32 characters: letters, digits, dash, underscore; starting with a letter or digit');
  }

  const name = asTrimmedString(cmd.name);
  if (name === null || name.length < 1 || name.length > 128) {
    return shapeRefusal('name must be 1..128 characters');
  }

  const currencyCode = asTrimmedString(cmd.currencyCode);
  if (currencyCode === null || !/^[A-Z]{3}$/.test(currencyCode)) {
    return shapeRefusal('currencyCode must be a 3-letter uppercase ISO 4217 code');
  }

  const timezone = asTrimmedString(cmd.timezone);
  if (timezone === null || timezone.length < 1 || timezone.length > 64) {
    return shapeRefusal('timezone must be a non-empty IANA zone name (1..64 characters)');
  }
  if (!o.tzList.includes(timezone)) {
    return shapeRefusal(`timezone '${timezone}' is not a known IANA zone`);
  }

  return { ok: true, value: { code, name, currencyCode, timezone } };
}

/* The user command — §14.28 clause 4. The credential's policy floor runs at
 * the adapter (auth.password.check) and AGAIN at the database's door for
 * the bootstrap; this validator owns the identity + role shapes. */
function validateUserCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return shapeRefusal('the user command must be an object');

  const emailRaw = asTrimmedString(cmd.email);
  if (emailRaw === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) || emailRaw.length > 254) {
    return shapeRefusal('email must be a plausible address (1..254 characters)');
  }

  const displayName = asTrimmedString(cmd.displayName);
  if (displayName === null || displayName.length < 1 || displayName.length > 128) {
    return shapeRefusal('displayName must be 1..128 characters');
  }

  if (typeof cmd.password !== 'string' || cmd.password.length === 0) {
    return shapeRefusal('password is required (the policy floor decides its strength at the adapter)');
  }

  if (!ROLE_LADDER.includes(cmd.role)) {
    return { ok: false, reason: 'SETUP_ROLE_INVALID', detail: `role must be one of ${ROLE_LADDER.join(' | ')}, got ${JSON.stringify(cmd.role)}` };
  }

  return { ok: true, value: { email: emailRaw.toLowerCase(), displayName, password: cmd.password, role: cmd.role } };
}

/* The limits command — §14.28 clause 4 (the §16 amendment seam). A command
 * carries the dual-control threshold and the per-role single-approval
 * ceilings; null means unlimited (the seeded O shape). */
function validateLimitsCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return shapeRefusal('the limits command must be an object');

  const dualThresholdAmount = cmd.dualThresholdAmount;
  if (typeof dualThresholdAmount !== 'number' || !Number.isFinite(dualThresholdAmount) || dualThresholdAmount < 0) {
    return shapeRefusal('dualThresholdAmount must be a finite number >= 0');
  }

  if (!Array.isArray(cmd.limits) || cmd.limits.length === 0) {
    return shapeRefusal('limits must be a non-empty array of {role, maxSingleAmount}');
  }
  const seen = new Set();
  for (const l of cmd.limits) {
    if (!l || typeof l !== 'object') return shapeRefusal('each limit must be an object {role, maxSingleAmount}');
    if (!ROLE_LADDER.includes(l.role)) {
      return { ok: false, reason: 'SETUP_ROLE_INVALID', detail: `limit role must be one of ${ROLE_LADDER.join(' | ')}, got ${JSON.stringify(l.role)}` };
    }
    if (seen.has(l.role)) return shapeRefusal(`duplicate limit for role ${l.role}`);
    seen.add(l.role);
    const a = l.maxSingleAmount;
    if (a !== null && (typeof a !== 'number' || !Number.isFinite(a) || a <= 0)) {
      return shapeRefusal(`maxSingleAmount for ${l.role} must be a positive finite number or null (unlimited)`);
    }
  }

  return { ok: true, value: { dualThresholdAmount, limits: cmd.limits.map((l) => ({ role: l.role, maxSingleAmount: l.maxSingleAmount })) } };
}

module.exports = { ROLE_LADDER, validateTenantCommand, validateUserCommand, validateLimitsCommand };
