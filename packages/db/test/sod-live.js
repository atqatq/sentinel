'use strict';
/* ============================================================================
 * SOD live proof — the C3 financial controls against REAL PostgreSQL.
 *
 * Requires a reachable PostgreSQL. Runs in CI (db-rls job, postgres:16).
 * The three A4 named proofs are exercised THROUGH THE REAL WIRING — the
 * pure approval module decides, the procure adapter writes, the database
 * re-proves (policies + triggers) — plus the fail-closed GUC lifecycle and
 * the cross-tenant fence on every new table:
 *
 *   sod/raisers-cannot-approve (API+DB): the module refuses the raiser;
 *     the RESTRICTIVE sod_binding policy refuses the same INSERT issued
 *     directly — and refuses identity forging (an approval row for anyone
 *     but the authenticated actor) and ineligible roles.
 *   sod/dual-control-above-threshold: one vote above the threshold leaves
 *     the proposal OPEN; the state guard refuses a premature APPROVED;
 *     a second distinct eligible vote completes it; the UNIQUE constraint
 *     makes a double vote structurally impossible.
 *   sod/supplier-change-freeze: a direct identity change is refused; the
 *     stored identity keeps serving; only a verified hold (app.hold_apply_id
 *     + exact delta) moves the row; mismatches and orphan GUCs refuse.
 *
 * Any unexpected outcome exits non-zero.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const { reviewApproval } = require(path.join(REPO, 'packages', 'core', 'modules', 'approval', 'src', 'decide'));
const { classifySupplierChange, verifySupplierHold } = require(path.join(REPO, 'packages', 'core', 'modules', 'approval', 'src', 'freeze'));

const ADMIN_URL = process.env.DATABASE_URL_ADMIN || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LIVE_DB = 'sentinel_sod_live';
const MIGRATION = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter((d) => /^\d{4}_/.test(d)).sort()
  .map((d) => fs.readFileSync(path.join(__dirname, '..', 'migrations', d, 'migration.sql'), 'utf8'))
  .join('\n');

const NEW_TABLES = ['tenant_role', 'approval_config', 'approval_limit', 'proposal', 'proposal_line',
  'approval', 'purchase_order', 'po_line', 'supplier_change_hold'];

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }

function probeUrl() {
  const u = new URL(ADMIN_URL.replace(/^postgres:\/\//, 'http://'));
  return `postgres://sod_probe:probe@${u.hostname}:${u.port || 5432}/${LIVE_DB}`;
}

/* Every check runs in its own transaction with the tenant+actor GUCs set.
 * A refused statement aborts the transaction — expected-error helpers always
 * ROLLBACK before returning, so later checks start clean. */
async function withCtx(probe, tenantId, actorId, fn) {
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  if (actorId) await probe.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
  try {
    return await fn();
  } finally {
    await probe.query('COMMIT').catch(() => probe.query('ROLLBACK'));
  }
}

async function expectPgError(name, probe, tenantId, actorId, fn, { code, message }) {
  await probe.query('BEGIN');
  await probe.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  if (actorId) await probe.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
  try {
    await fn();
    bad(name, `expected ${code || message} but the statement succeeded`);
  } catch (e) {
    if (code && e.code === code) ok(name + ` (code ${e.code})`);
    else if (message && String(e.message).includes(message)) ok(name + ` (${message})`);
    else bad(name, `expected ${code || message}, got ${e.code || 'none'}: ${e.message}`);
  } finally {
    await probe.query('ROLLBACK');
  }
}

async function main() {
  /* ---- 1. scratch database + migrations ---- */
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${LIVE_DB};`);
  await admin.query(`CREATE DATABASE ${LIVE_DB};`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, '/' + LIVE_DB) });
  await db.connect();
  await db.query(MIGRATION);

  /* ---- 2. catalog: the C3 tables are RLS-armed ---- */
  console.log('\nCatalog: RLS armed on the C3 tables');
  for (const t of NEW_TABLES) {
    const r = await db.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, [t]);
    const row = r.rows[0];
    if (row && row.relrowsecurity && row.relforcerowsecurity) ok(`${t}: ENABLE + FORCE`);
    else bad(`${t}: relrowsecurity=${row && row.relrowsecurity} relforcerowsecurity=${row && row.relforcerowsecurity}`);
  }

  /* ---- 3. seed two tenants + principals (superuser bootstrap; the first O
   *       cannot self-grant through the Origin-only policy — D-029) ---- */
  const T1 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('tenant-alpha','Tenant Alpha (synthetic)','BHD','Asia/Bahrain') RETURNING id`)).rows[0].id;
  const T2 = (await db.query(`INSERT INTO tenant (code, name, currency_code, timezone) VALUES ('tenant-beta','Tenant Beta (synthetic)','AED','Asia/Dubai') RETURNING id`)).rows[0].id;

  const USERS = {};
  for (const [key, email] of Object.entries({
    origin: 'origin@live.synthetic', manager: 'manager@live.synthetic', senior: 'senior@live.synthetic',
    buyer: 'buyer@live.synthetic', analyst: 'analyst@live.synthetic',
  })) {
    USERS[key] = (await db.query(`INSERT INTO app_user (email, display_name) VALUES ($1,$2) RETURNING id`, [email, key])).rows[0].id;
  }
  /* Seed as the superuser bootstrap (the first O cannot self-grant); each
   * tenant's rows ride one explicit transaction with its tenant GUC set. */
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
  for (const [key, role] of [['origin', 'O'], ['manager', 'SCM'], ['senior', 'SBR'], ['buyer', 'BYR'], ['analyst', 'DTA']]) {
    await db.query(`INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4)`, [T1, USERS[key], role, USERS.origin]);
  }
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [T2]);
  await db.query(`INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES ($1,$2,'O',$2)`, [T2, USERS.origin]);
  await db.query(`INSERT INTO approval_config (tenant_id, currency_code, dual_threshold_amount, updated_by) VALUES ($1,'BHD',1000,$2), ($3,'AED',10000,$2)`, [T1, USERS.origin, T2]);
  await db.query(`INSERT INTO approval_limit (tenant_id, role, max_single_amount, updated_by) VALUES ($1,'SBR',5000,$3), ($1,'SCM',50000,$3), ($1,'O',NULL,$3), ($2,'O',NULL,$3)`, [T1, T2, USERS.origin]);
  const S1 = (await db.query(
    `INSERT INTO supplier (tenant_id, external_id, name, is_active, payment_term_days, payment_terms_text, currency_code)
     VALUES ($1,'S-100','Old Name',true,45,'SOA +45 Days','BHD') RETURNING id`, [T1])).rows[0].id;
  await db.query('COMMIT');

  /* ---- 4. the probe (non-superuser, NOBYPASSRLS, member of sentinel_app) ---- */
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sod_probe') THEN
      CREATE ROLE sod_probe LOGIN PASSWORD 'probe';
    END IF;
  END $$;`);
  await db.query(`GRANT sentinel_app TO sod_probe;`);
  const probe = new Client({ connectionString: probeUrl() });
  await probe.connect();
  const who = await probe.query('SELECT current_user');
  if (who.rows[0].current_user !== 'sod_probe') {
    bad('probe identity', `connected as ${who.rows[0].current_user} — connection config regression`);
    process.exit(1);
  }

  const A1 = DB.makeProcureAdapter(probe, T1);
  const A2 = DB.makeProcureAdapter(probe, T2);

  /* ---- 5. fail-closed reads ---- */
  console.log('\nFail-closed reads (no GUC, no rows — the ADR-0002 construction)');
  const bare = await probe.query('SELECT count(*)::int AS n FROM proposal');
  if (bare.rows[0].n === 0) ok('probe with no GUC sees zero proposals');
  else bad('probe with no GUC sees zero proposals', `got ${bare.rows[0].n}`);

  await withCtx(probe, T1, USERS.buyer, async () => {
    const ctl = await A1.loadControls();
    if (ctl.config && Number(ctl.config.dualThresholdAmount) === 1000 && ctl.limits.length === 3) ok('controls load: config + the three role limits');
    else bad('controls load', JSON.stringify(ctl));
    const none = await A1.loadProposalByCode('PR-1');
    if (none === null) ok('an empty tenant reads no proposals');
    else bad('an empty tenant reads no proposals');
  });

  await withCtx(probe, T2, USERS.origin, async () => {
    const ctl = await A2.loadControls();
    if (ctl.config && Number(ctl.config.dualThresholdAmount) === 10000) ok('tenant beta reads its OWN config (10000 AED)');
    else bad('tenant beta reads its OWN config', JSON.stringify(ctl.config));
  });

  /* ---- 6. the raise path ---- */
  console.log('\nRaise: any authenticated member may raise — the invariant binds APPROVAL');
  await withCtx(probe, T1, USERS.buyer, async () => {
    await A1.raiseProposal({ code: 'PR-1', raisedBy: USERS.buyer, currencyCode: 'BHD', totalAmount: 500,
      lines: [{ sku: 'SKU-1', qty: 10, unitCode: 'CTN', unitPrice: 50 }] });
    await A1.raiseProposal({ code: 'PR-2', raisedBy: USERS.buyer, supplierId: S1, currencyCode: 'BHD', totalAmount: 4000,
      lines: [{ sku: 'SKU-2', qty: 1, unitCode: 'CTN', unitPrice: 4000 }] });
    await A1.raiseProposal({ code: 'PR-3', raisedBy: USERS.buyer, currencyCode: 'BHD', totalAmount: 6000,
      lines: [{ sku: 'SKU-3', qty: 1, unitCode: 'CTN', unitPrice: 6000 }] });
    await A1.raiseProposal({ code: 'PR-FX', raisedBy: USERS.buyer, currencyCode: 'AED', totalAmount: 500,
      lines: [{ sku: 'SKU-4', qty: 1, unitCode: 'CTN', unitPrice: 500 }] });
    await A1.raiseProposal({ code: 'PR-4', raisedBy: USERS.buyer, currencyCode: 'BHD', totalAmount: 100,
      lines: [{ sku: 'SKU-5', qty: 1, unitCode: 'CTN', unitPrice: 100 }] });
    ok('buyer raised five proposals (PR-1 500 / PR-2 4000 / PR-3 6000 / PR-FX AED / PR-4 100)');
  });

  await withCtx(probe, T2, USERS.origin, async () => {
    const leak = await A2.loadProposalByCode('PR-1');
    if (leak === null) ok('cross-tenant read denied: tenant beta cannot read tenant alpha\'s proposals');
    else bad('cross-tenant read denied', 'PR-1 leaked across tenants');
  });

  /* ---- 7. NAMED PROOF: sod/raisers-cannot-approve (API + DB) ---- */
  console.log('\nNAMED PROOF sod/raisers-cannot-approve (API+DB)');
  await withCtx(probe, T1, USERS.buyer, async () => {
    const p = await A1.loadProposalByCode('PR-1');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.buyer, role: 'BYR' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) },
      limits: ctl.limits, prior: p.approvals,
      decision: 'APPROVED', reason: 'self', tenantCurrency: 'BHD',
    });
    if (verdict.ok === false && verdict.denial.reason === 'SOD_SELF_APPROVAL') ok('API layer: the raiser\'s approval refuses SOD_SELF_APPROVAL');
    else bad('API layer: the raiser\'s approval refuses', JSON.stringify(verdict));
    const r = await probe.query('SELECT count(*)::int AS n FROM approval');
    if (r.rows[0].n === 0) ok('a refusal writes NOTHING — the denial record travels to the caller, not the database');
    else bad('a refusal writes NOTHING', `${r.rows[0].n} approval rows exist`);
  });

  await expectPgError('DB layer: the same INSERT issued directly is refused by the RESTRICTIVE policy (42501)',
    probe, T1, USERS.buyer,
    () => probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, id, $2, 'APPROVED', 'bypass attempt' FROM proposal WHERE tenant_id = $1 AND code = 'PR-1'`, [T1, USERS.buyer]),
    { code: '42501' });
  await expectPgError('DB layer: identity forging is dead — an approval for someone ELSE than the authenticated actor refuses',
    probe, T1, USERS.manager,
    () => probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, $2, 'APPROVED', 'forged' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-1'`, [T1, USERS.senior]),
    { code: '42501' });
  await expectPgError('DB layer: an ineligible role (DTA) can never insert an approval',
    probe, T1, USERS.analyst,
    () => probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, $2, 'APPROVED', 'analyst tries' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-1'`, [T1, USERS.analyst]),
    { code: '42501' });

  await withCtx(probe, T1, USERS.manager, async () => {
    const p = await A1.loadProposalByCode('PR-1');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.manager, role: 'SCM' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'within budget', tenantCurrency: 'BHD',
    });
    if (verdict.ok && verdict.outcome === 'APPROVED') {
      await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.manager, decision: 'APPROVED', reason: 'within budget' });
      const done = await A1.advanceProposal({ proposalId: p.proposal.id, from: 'OPEN', to: 'APPROVED' });
      if (done.state === 'APPROVED') ok('happy path: a distinct eligible approver completes a below-threshold proposal');
      else bad('happy path', done.state);
    } else bad('happy path: a distinct eligible approver approves', JSON.stringify(verdict));
  });

  /* ---- 8. NAMED PROOF: sod/dual-control-above-threshold ---- */
  console.log('\nNAMED PROOF sod/dual-control-above-threshold');
  await withCtx(probe, T1, USERS.senior, async () => {
    const p = await A1.loadProposalByCode('PR-2');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.senior, role: 'SBR' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'first vote', tenantCurrency: 'BHD',
    });
    if (verdict.ok && verdict.outcome === 'RECORDED_OPEN') {
      await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.senior, decision: 'APPROVED', reason: 'first vote' });
      const still = await A1.loadProposalByCode('PR-2');
      if (still.proposal.state === 'OPEN') ok('one vote above the threshold leaves the proposal OPEN (need 2, votes 1)');
      else bad('one vote above the threshold leaves OPEN', still.proposal.state);
    } else bad('first vote records', JSON.stringify(verdict));
  });

  await expectPgError('the state guard refuses a premature APPROVED with one vote (DUAL_CONTROL_NOT_SATISFIED)',
    probe, T1, USERS.senior,
    () => probe.query(`UPDATE proposal SET state = 'APPROVED' WHERE tenant_id = $1 AND code = 'PR-2'`, [T1]),
    { message: 'DUAL_CONTROL_NOT_SATISFIED' });

  await expectPgError('the same approver cannot vote twice — the UNIQUE constraint is structural',
    probe, T1, USERS.senior,
    () => probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, $2, 'APPROVED', 'double vote' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-2'`, [T1, USERS.senior]),
    { code: '23505' });

  await withCtx(probe, T1, USERS.manager, async () => {
    const p = await A1.loadProposalByCode('PR-2');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.manager, role: 'SCM' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'second vote', tenantCurrency: 'BHD',
    });
    if (verdict.ok && verdict.outcome === 'APPROVED') {
      await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.manager, decision: 'APPROVED', reason: 'second vote' });
      const done = await A1.advanceProposal({ proposalId: p.proposal.id, from: 'OPEN', to: 'APPROVED' });
      if (done.state === 'APPROVED') ok('a second DISTINCT eligible vote completes the proposal');
      else bad('a second DISTINCT eligible vote completes', done.state);
    } else bad('second vote', JSON.stringify(verdict));
  });

  /* ---- 9. value-tiered limits (API refuses; the DB guard is the backstop) ---- */
  console.log('\nValue-tiered limits: the API refuses; the state guard re-proves at the DB');
  await withCtx(probe, T1, USERS.senior, async () => {
    const p = await A1.loadProposalByCode('PR-3');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.senior, role: 'SBR' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'over my ceiling', tenantCurrency: 'BHD',
    });
    if (verdict.ok === false && verdict.denial.reason === 'LIMIT_EXCEEDED') ok('API: SBR cannot approve 6000 — the 5000 ceiling refuses (LIMIT_EXCEEDED)');
    else bad('API: SBR ceiling refuses', JSON.stringify(verdict));
  });
  await withCtx(probe, T1, USERS.senior, async () => {
    /* the INSERT itself is legal (the policy binds identity+role, not value) —
     * the state guard is where the ceiling is re-proven */
    await probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, $2, 'APPROVED', 'raw vote over limit' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-3'`, [T1, USERS.senior]);
    await probe.query(`UPDATE proposal SET state = 'APPROVED' WHERE tenant_id = $1 AND code = 'PR-3'`, [T1]);
    bad('DB: the state guard refuses an over-limit vote (APPROVAL_LIMIT_EXCEEDED)', 'the advance succeeded');
  }).catch((e) => {
    if (String(e.message).includes('APPROVAL_LIMIT_EXCEEDED')) ok('DB: the state guard refuses an over-limit vote (APPROVAL_LIMIT_EXCEEDED)');
    else bad('DB: the state guard refuses an over-limit vote', e.message);
  });
  await withCtx(probe, T1, USERS.origin, async () => {
    const p = await A1.loadProposalByCode('PR-3');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.origin, role: 'O' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'origin ceiling is unlimited', tenantCurrency: 'BHD',
    });
    if (verdict.ok && verdict.outcome === 'RECORDED_OPEN') {
      await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.origin, decision: 'APPROVED', reason: 'origin ceiling is unlimited' });
      ok('Origin\'s NULL ceiling is unlimited — the vote records, dual still pending');
    } else bad('Origin unlimited', JSON.stringify(verdict));
  });
  await withCtx(probe, T1, USERS.manager, async () => {
    const p = await A1.loadProposalByCode('PR-3');
    await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.manager, decision: 'APPROVED', reason: 'second vote' });
    const done = await A1.advanceProposal({ proposalId: p.proposal.id, from: 'OPEN', to: 'APPROVED' });
    if (done.state === 'APPROVED') ok('PR-3 completes with Origin + SCM votes');
    else bad('PR-3 completes', done.state);
  });

  /* ---- 10. currency discipline ---- */
  console.log('\nCurrency: the tier arithmetic only exists in the tenant currency');
  await withCtx(probe, T1, USERS.manager, async () => {
    const p = await A1.loadProposalByCode('PR-FX');
    const ctl = await A1.loadControls();
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.manager, role: 'SCM' },
      config: { dualThresholdAmount: Number(ctl.config.dualThresholdAmount) }, limits: ctl.limits,
      prior: p.approvals, decision: 'APPROVED', reason: 'foreign currency', tenantCurrency: 'BHD',
    });
    if (verdict.ok === false && verdict.denial.reason === 'CURRENCY_NOT_TENANT_CURRENCY') ok('API: an AED proposal on a BHD tenant refuses');
    else bad('API: foreign currency refuses', JSON.stringify(verdict));
  });
  await withCtx(probe, T1, USERS.manager, async () => {
    await probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, $2, 'APPROVED', 'raw foreign vote' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-FX'`, [T1, USERS.manager]);
    await probe.query(`UPDATE proposal SET state = 'APPROVED' WHERE tenant_id = $1 AND code = 'PR-FX'`, [T1]);
    bad('DB: the state guard refuses a foreign-currency advance', 'the advance succeeded');
  }).catch((e) => {
    if (String(e.message).includes('CURRENCY_NOT_TENANT_CURRENCY')) ok('DB: the state guard refuses a foreign-currency advance (CURRENCY_NOT_TENANT_CURRENCY)');
    else bad('DB: foreign-currency advance', e.message);
  });

  /* ---- 11. rejection is terminal; conversion ---- */
  console.log('\nRejection dismisses; conversion issues the document');
  await withCtx(probe, T1, USERS.manager, async () => {
    const p = await A1.loadProposalByCode('PR-4');
    const verdict = reviewApproval({
      proposal: p.proposal, actor: { userId: USERS.manager, role: 'SCM' },
      config: { dualThresholdAmount: 1000 }, limits: [], prior: p.approvals,
      decision: 'REJECTED', reason: 'no budget line', tenantCurrency: 'BHD',
    });
    if (verdict.ok && verdict.outcome === 'DISMISSED') {
      await A1.recordApproval({ proposalId: p.proposal.id, approverId: USERS.manager, decision: 'REJECTED', reason: 'no budget line' });
      const after = await A1.loadProposalByCode('PR-4');
      if (after.proposal.state === 'DISMISSED') ok('a REJECTED decision dismisses the proposal in the same statement (trigger)');
      else bad('REJECTED dismisses', after.proposal.state);
    } else bad('rejection verdict', JSON.stringify(verdict));
  });

  await withCtx(probe, T1, USERS.senior, async () => {
    const p = await A1.loadProposalByCode('PR-2');
    const po = await A1.convertProposal({
      proposalId: p.proposal.id, poCode: 'PO-100', convertedBy: USERS.senior,
      lines: p.lines.map((l) => ({ sku: l.sku, qty: Number(l.qty), unitCode: l.unitCode, unitPrice: Number(l.unitPrice) })),
    });
    const after = await A1.loadProposalByCode('PR-2');
    if (po.code === 'PO-100' && after.proposal.state === 'CONVERTED') ok('an APPROVED proposal converts — the PO document lands, state CONVERTED');
    else bad('conversion', JSON.stringify({ po: po.code, state: after.proposal.state }));
  });
  await expectPgError('a second conversion of the same proposal is structurally impossible (UNIQUE proposal_id)',
    probe, T1, USERS.senior,
    () => probe.query(`INSERT INTO purchase_order (tenant_id, code, proposal_id, supplier_id, currency_code, total_amount, converted_by)
                       SELECT $1, 'PO-999', p.id, p.supplier_id, p.currency_code, p.total_amount, $2
                         FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-2'`, [T1, USERS.senior]),
    { code: '23505' });
  await withCtx(probe, T1, USERS.senior, async () => {
    /* PR-4 is DISMISSED — conversion refuses anything but APPROVED */
    const p = await A1.loadProposalByCode('PR-4');
    try {
      await A1.convertProposal({ proposalId: p.proposal.id, poCode: 'PO-X', convertedBy: USERS.senior, lines: [] });
      bad('conversion refuses a non-APPROVED proposal', 'succeeded');
    } catch (e) {
      if (String(e.message).includes('PROPOSAL_NOT_APPROVED')) ok('conversion refuses a non-APPROVED proposal (a DISMISSED one is not convertible)');
      else bad('conversion state refusal', e.message);
    }
  });

  /* ---- 12. NAMED PROOF: sod/supplier-change-freeze ---- */
  console.log('\nNAMED PROOF sod/supplier-change-freeze');
  await withCtx(probe, T1, USERS.manager, async () => {
    await probe.query(`UPDATE supplier SET name = 'Sneaky Rename' WHERE id = $1`, [S1]);
    bad('a direct identity change is refused', 'the UPDATE succeeded');
  }).catch(async (e) => {
    if (String(e.message).includes('SUPPLIER_IDENTITY_FROZEN')) ok('a direct identity change is refused outright (SUPPLIER_IDENTITY_FROZEN)');
    else bad('direct identity change', e.message);
  });
  await withCtx(probe, T1, USERS.manager, async () => {
    const stored = (await probe.query(`SELECT name FROM supplier WHERE id = $1`, [S1])).rows[0];
    if (stored.name === 'Old Name') ok('the stored identity keeps serving after the refused change (cooling-off semantics)');
    else bad('the stored identity keeps serving', stored.name);
  });

  await withCtx(probe, T1, USERS.manager, async () => {
    await probe.query(`UPDATE supplier SET is_active = false WHERE id = $1`, [S1]);
    await probe.query(`UPDATE supplier SET is_active = true WHERE id = $1`, [S1]);
    ok('non-frozen fields ride freely — operations are not frozen');
  });

  await withCtx(probe, T1, USERS.manager, async () => {
    const stored = (await probe.query(`SELECT external_id, name, payment_term_days, payment_terms_text, currency_code FROM supplier WHERE id = $1`, [S1])).rows[0];
    const incoming = { external_id: 'S-100', name: 'New Name', payment_term_days: 30, payment_terms_text: 'SOA +45 Days', currency_code: 'BHD' };
    const cls = classifySupplierChange(
      { external_id: stored.external_id, name: stored.name, payment_term_days: stored.payment_term_days, payment_terms_text: stored.payment_terms_text, currency_code: stored.currency_code },
      incoming);
    if (!cls.frozen) { bad('an identity delta stages a hold', 'classifier says frozen=false'); return; }
    const hold = await A1.stageSupplierHold({ supplierId: S1, changedFields: cls.delta, requestedBy: null });
    if (hold.state === 'COOLING_OFF') ok('the identity delta stages a COOLING_OFF hold (pipeline-originated, NULL requester)');
    else bad('hold staged', JSON.stringify(hold));
  });

  await withCtx(probe, T1, USERS.manager, async () => {
    const hold = await A1.loadActiveHold(S1);
    const verdict = verifySupplierHold({ hold, actor: { userId: USERS.manager, role: 'SCM' }, reference: '' });
    if (verdict.ok === false && verdict.denial.reason === 'MISSING_VERIFICATION_REFERENCE') ok('out-of-band gate: without a reference there is no apply');
    else bad('missing reference gate', JSON.stringify(verdict));
  });

  await expectPgError('a mismatched apply is refused — the row must move EXACTLY to the held delta',
    probe, T1, USERS.manager, async () => {
      const hold = await A1.loadActiveHold(S1);
      await probe.query(`SELECT set_config('app.hold_apply_id', $1, true)`, [hold.id]);
      await probe.query(`UPDATE supplier SET name = 'Sneaky Name' WHERE id = $1`, [S1]);
    }, { message: 'SUPPLIER_HOLD_MISMATCH' });
  await expectPgError('an orphan GUC (no COOLING_OFF hold behind it) refuses — the freeze has no bypass',
    probe, T1, USERS.manager, async () => {
      await probe.query(`SELECT set_config('app.hold_apply_id', gen_random_uuid()::text, true)`);
      await probe.query(`UPDATE supplier SET name = 'New Name' WHERE id = $1`, [S1]);
    }, { message: 'SUPPLIER_HOLD_MISMATCH' });

  await withCtx(probe, T1, USERS.manager, async () => {
    const hold = await A1.loadActiveHold(S1);
    const verdict = verifySupplierHold({ hold, actor: { userId: USERS.manager, role: 'SCM' }, reference: 'OBV-2026-014 (bank letter on file)' });
    if (verdict.ok && verdict.outcome === 'APPLY') {
      await A1.resolveHold({ holdId: hold.id, supplierId: S1, changedFields: hold.changedFields, verifiedBy: USERS.manager, reference: 'OBV-2026-014 (bank letter on file)', decision: 'APPLY' });
      const row = (await probe.query(`SELECT name, payment_term_days FROM supplier WHERE id = $1`, [S1])).rows[0];
      if (row.name === 'New Name' && Number(row.payment_term_days) === 30) ok('the verified hold moves the row to the held delta — the ONLY door through the freeze');
      else bad('verified hold applies', JSON.stringify(row));
    } else bad('verification verdict', JSON.stringify(verdict));
  });
  await withCtx(probe, T1, USERS.manager, async () => {
    const hold = await A1.loadActiveHold(S1);
    if (hold === null) ok('the applied hold leaves the queue — no second apply through the same door');
    else bad('applied hold leaves the queue', JSON.stringify(hold));
  });

  await withCtx(probe, T1, USERS.manager, async () => {
    /* a user-requested hold: the requester can never self-verify. The delta
     * is the REMITTANCE text this time — the row already carries the first
     * applied change, and a frozen-field change to it must stage again. */
    const stored = (await probe.query(`SELECT external_id, name, payment_term_days, payment_terms_text, currency_code FROM supplier WHERE id = $1`, [S1])).rows[0];
    const incoming = { external_id: stored.external_id, name: stored.name, payment_term_days: stored.payment_term_days, payment_terms_text: 'NET +30 Days', currency_code: stored.currency_code };
    const cls = classifySupplierChange(
      { external_id: stored.external_id, name: stored.name, payment_term_days: stored.payment_term_days, payment_terms_text: stored.payment_terms_text, currency_code: stored.currency_code },
      incoming);
    if (!cls.frozen) { bad('a second hold stages', 'classifier says no delta — the remittance text change must freeze'); return; }
    const hold = await A1.stageSupplierHold({ supplierId: S1, changedFields: cls.delta, requestedBy: USERS.senior });
    const verdict = verifySupplierHold({ hold, actor: { userId: USERS.senior, role: 'SBR' }, reference: 'self' });
    if (verdict.ok === false && verdict.denial.reason === 'SOD_VERIFIER_IS_REQUESTER') ok('a user-requested hold is never verified by its requester (the SoD spine holds on the freeze)');
    else bad('self-verification gate', JSON.stringify(verdict));
    const verdict2 = verifySupplierHold({ hold, actor: { userId: USERS.buyer, role: 'BYR' }, reference: 'x' });
    if (verdict2.ok === false && verdict2.denial.reason === 'NOT_ELIGIBLE_VERIFIER') ok('verification is approval-capable — BYR cannot verify');
    else bad('verifier eligibility', JSON.stringify(verdict2));
    await A1.resolveHold({ holdId: hold.id, supplierId: S1, changedFields: cls.delta, verifiedBy: USERS.manager, reference: 'declined by phone', decision: 'REJECT' });
    const after = (await probe.query(`SELECT state FROM supplier_change_hold WHERE id = $1`, [hold.id])).rows[0];
    if (after.state === 'REJECTED') ok('a rejected hold lands REJECTED — the stored identity simply keeps serving');
    else bad('rejected hold', after.state);
  });

  /* ---- 13. Origin-only authority on the control rows ---- */
  console.log('\nOrigin-only authority on roles, config and limits');
  await expectPgError('a non-Origin cannot grant roles (controls_origin_only)',
    probe, T1, USERS.manager,
    () => probe.query(`INSERT INTO tenant_role (tenant_id, user_id, role, granted_by) VALUES ($1,$2,'DTA',$3)`, [T1, USERS.buyer, USERS.manager]),
    { code: '42501' });
  await withCtx(probe, T1, USERS.origin, async () => {
    const r = await A1.grantRole({ userId: USERS.analyst, role: 'DTA', grantedBy: USERS.origin });
    if (r.role === 'DTA') ok('Origin grants roles — the matrix is Origin\'s to edit');
    else bad('Origin grants roles', JSON.stringify(r));
  });
  await expectPgError('a non-Origin cannot amend the dual threshold',
    probe, T1, USERS.manager,
    () => probe.query(`UPDATE approval_config SET dual_threshold_amount = 1 WHERE tenant_id = $1`, [T1]),
    { code: '42501' });
  await withCtx(probe, T1, USERS.origin, async () => {
    await probe.query(`UPDATE approval_config SET dual_threshold_amount = 1000 WHERE tenant_id = $1`, [T1]);
    ok('Origin amends the threshold — tiers are data, tenant-amendable');
  });

  /* ---- 14. the actor GUC lifecycle (ADR-0002 discipline, second GUC) ---- */
  console.log('\nThe app.actor_id fence is fail-closed by the same construction');
  await expectPgError('approval INSERT with NO actor GUC refuses (NULL → denied)',
    probe, T1, null,
    () => probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                       SELECT $1, p.id, p.raised_by, 'APPROVED', 'no actor' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-1'`, [T1]),
    { code: '42501' });
  await expectPgError('approval INSERT after SET then RESET refuses loudly (\'\' → 22P02 cast error)',
    probe, T1, USERS.manager,
    async () => {
      await probe.query(`RESET app.actor_id`);
      await probe.query(`INSERT INTO approval (tenant_id, proposal_id, approver_id, decision, reason)
                         SELECT $1, p.id, $2, 'APPROVED', 'reset actor' FROM proposal p WHERE p.tenant_id = $1 AND p.code = 'PR-1'`, [T1, USERS.manager]);
    },
    { code: '22P02' });

  /* ---- cleanup ---- */
  await probe.end();
  await db.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('sod-live failed to run:', e.message); process.exit(1); });
