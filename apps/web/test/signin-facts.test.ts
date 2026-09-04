/* ============================================================================
 * signin facts suite — the post-sign-in landing map is PURE and TOTAL, and
 * the one-door discipline holds (no second rotation path invented here).
 *
 * Zero-install, zero-db, zero-clock: the map decides from the login
 * response's principal alone. Every test is named after the requirement
 * it pins (delivery spec §5.1 — the name is the traceability link).
 * ==========================================================================*/
import assert from "node:assert/strict"

import { landingFor, type LoginPrincipal } from "../src/lib/signin.ts"

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.error(e)
  }
}

function principal(over: Partial<LoginPrincipal> = {}): LoginPrincipal {
  return {
    userId: "u-1",
    tenantId: "t-1",
    tenantCode: "BahrainMP",
    role: "SCM",
    mfaOk: false,
    mustChange: false,
    ...over,
  }
}

test("the origin (role O — the bootstrap's founder grant, by the door) lands on the wizard", () => {
  assert.equal(landingFor(principal({ role: "O" })), "/setup")
})

test("a must_change origin still lands on the wizard — the rotation interstitial lives there (§14.28 clause 2)", () => {
  assert.equal(landingFor(principal({ role: "O", mustChange: true })), "/setup")
})

test("a non-origin principal lands on home — the wizard is the Origin's desk", () => {
  assert.equal(landingFor(principal({ role: "SCM" })), "/")
  assert.equal(landingFor(principal({ role: "SBR" })), "/")
})

test("must_change does not divert a non-origin principal — one rotation door, not two", () => {
  assert.equal(landingFor(principal({ role: "SCM", mustChange: true })), "/")
})

test("the map is total — any unknown role still resolves, never strands the session", () => {
  assert.equal(landingFor(principal({ role: "" })), "/")
  assert.equal(landingFor(principal({ role: "X" })), "/")
})

test("determinism: identical principals produce identical landings", () => {
  assert.equal(landingFor(principal({ role: "O" })), landingFor(principal({ role: "O" })))
})

console.log(`\n  signin facts: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
