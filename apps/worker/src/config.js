'use strict';
/* ============================================================================
 * worker — the boot-time configuration (§14.25 clause 1).
 *
 * Configuration rides environment at exec, and a daemon that cannot state
 * its contract refuses at BOOT with a named reason: a missing DATABASE_URL
 * is dead on arrival, and dead on arrival must say so, not idle. Every
 * value is parsed once, here, where the refusal is loud — never lazily,
 * where it would be a 3 a.m. surprise.
 *
 * The env object is injected (main passes process.env) so the proof can
 * boot the same config the daemon boots without touching a real process.
 * ==========================================================================*/

const DEFAULTS = Object.freeze({
  inbox: '/data/inbox',
  pollMs: 15000,
  batchMax: 25,
});

function bootRefused(detail) {
  throw new Error(`WORKER_BOOT_REFUSED: ${detail}`);
}

function positiveInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    bootRefused(`${name} '${raw}' is not a positive integer`);
  }
  return n;
}

/**
 * @param {object} env — the process environment (injectable for the proof).
 * @returns {{ inbox: string, databaseUrl: string, pollMs: number, batchMax: number }}
 */
function loadConfig(env) {
  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    bootRefused('DATABASE_URL is not set — a daemon that cannot reach the database is dead on arrival, and dead on arrival must say so, not idle');
  }
  return {
    inbox: env.SENTINEL_WORKER_INBOX || DEFAULTS.inbox,
    databaseUrl,
    pollMs: positiveInt(env, 'SENTINEL_WORKER_POLL_MS', DEFAULTS.pollMs),
    batchMax: positiveInt(env, 'SENTINEL_WORKER_BATCH_MAX', DEFAULTS.batchMax),
  };
}

module.exports = { loadConfig, DEFAULTS };
