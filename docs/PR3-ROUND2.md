# PR #3 — round-two corrections and rollout gate

Reviewed starting head: `050cf3d50a0b609d3c974f82ad0a3f4ff2482ad2`.
This branch remains a draft pending verification and independent re-review.
Nothing in this change authorizes merging, production migration or live clearance.

## Findings addressed

| Finding | Correction |
| --- | --- |
| P1-01 | One shared invoice/credit-note submission service, atomic claim and durable attempt; expected attempt/state predicates on completion; no automatic retry after transport starts. |
| P1-02 | Managed integration principals carry explicit site ownership; silo/truck queries constrain the site, as do report requests including plant overrides. Unassigned keys fail closed. |
| P1-03 | Central finite/nonnegative parsing, integer ordered thresholds and role catalog; PostgreSQL row-local CHECKs and unique catch-all; serialized policy writes and locked overlap checks; transactional audits. |
| P1-04 | Session-free transaction audit writer; billing business records, journals and audits commit together. ZATCA generation audits are in generation transactions; external submission has durable attempts and transactional claim/completion audits. |
| P2-01 | Normal and reversal journal creation use one global advisory-lock allocator. Unique errors are never retried inside the failed transaction. |
| P2-02 | Typed expected billing errors rendered via a client `useActionState` form. Unexpected failures are logged without payloads and rethrown. |
| P2-03 | Leave → employee → plant lock order; fresh employee site under lock for attendance and leave create/approve/reject/cancel; same-transaction audit. |

## Migration and key rollout

Apply migrations before deploying code. Test both an empty database and an
upgrade from base `1d0dac3133d2b84d02dc6add89dd76b3353e6ee0` first.

1. Retain the additive TOTP migration.
2. `integration_site_scope`: existing keys intentionally receive `siteId=NULL`
   and `global=false`. **They are disabled by authentication**, not guessed
   into a site. An administrator must inventory gateways and explicitly map
   each existing key to a verified site, or revoke it and provision a new
   site-owned key through Integrations. No new secret is displayed in logs.
3. A global managed key is a deliberate ADMIN choice: select "All sites" and
   leave the site selector empty. Capability `ALL` alone is not global access.
4. Legacy environment authentication is disabled unless
   `ALLOW_LEGACY_GLOBAL_INTEGRATION_KEY=true`; each use emits a key-free warning.
   Enable only during a supervised transition, monitor warnings, and remove
   the flag/key after gateway rollout. Rollout changes availability and needs
   an operator-coordinated maintenance window.
5. `zatca_submission_attempts`: old `FAILED` documents become `UNKNOWN`, since
   they may have been accepted externally. Their existing UUID/XML/hash and
   error metadata remain available; migration never retransmits a document.
6. `incentive_invariants` deliberately fails if historical rows violate the
   new CHECKs or duplicate catch-all uniqueness. Inventory invalid values and
   overlapping ranges by policy before deployment. Have the payroll owner
   approve corrected thresholds/rates/ranges; do not silently rewrite them.
   Reach ranges remain **closed at both ends** to preserve payout semantics;
   a shared endpoint is an overlap and is rejected. Non-overlap of additions
   is enforced by an overlap query under the owning policy row lock.

## ZATCA unknown/stale recovery (no blind retry)

`GENERATED → SUBMITTING → CLEARED | UNKNOWN` is the normal path. A preparation
failure before any transport is attempted becomes `FAILED` and can retry.
Once transport starts, every timeout, non-success or malformed response is
conservatively `UNKNOWN`, never treated as evidence of rejection. Even an
HTTP success must carry `clearanceStatus=CLEARED` before local clearance.

The attempt stores the document kind/id, UUID, signed XML, hash, start/end
times, HTTP status and a bounded response. It never stores authentication
headers, CSID secrets or private keys. Restrict operational access to this
financial data. Responses are capped at 16,000 characters in storage.

Operations must monitor `SUBMITTING` older than five minutes and all
`UNKNOWN` documents. A new submission invocation detects stale `SUBMITTING`
and moves it to `UNKNOWN` transactionally; it does not resend. Process death
between claim and network is also treated as ambiguous: no lease-based retry.
The UI does not offer a resend button for pending/unknown states.

For manual resolution:

1. Freeze any affected submission worker and identify the exact document UUID,
   hash and attempt id. Preserve attempt records, including late responses.
2. Obtain authoritative acceptance/rejection evidence using the regulator's
   supported operator/sandbox process. This repository does not assume a
   reconciliation endpoint or claim that UUID alone makes POST idempotent.
3. If accepted, have an authorized operator record evidence and, in one DB
   transaction, lock the document, compare the expected attempt id and
   `UNKNOWN|SUBMITTING` state, set `CLEARED`, update the matching attempt, and
   insert an AuditEvent naming the operator and evidence reference. Never
   downgrade an already `CLEARED` document.
4. If not conclusively accepted or rejected, leave it `UNKNOWN`. Do not clear
   its attempt id or restore `GENERATED` merely to enable the button.
5. A new send after definitive rejection requires an explicit, reviewed
   operator correction backed by regulator evidence; automatic retry after
   external transport is intentionally unsupported.

Live regulator acceptance is still unverified. Do not enable production
clearance until a sandbox acceptance suite passes.

## Merge order and unchanged design decisions

PR #2 remains a separate unmerged production-lifecycle change. Recommended
order is PR #3 first **after independent acceptance**, then rebase PR #2 onto
the accepted main. Review schema, audit, permissions and package conflicts
explicitly and run the full suite twice again. Neither PR is merged here.

Monetary Float-to-Decimal conversion remains separate pending an agreed scale,
rounding, reconciliation and export policy. Sensor balance authority versus
inventory-ledger reconciliation remains a product decision, not changed here.

## Verification

Passing old CI alone is not acceptance; the new failure-injection and
lock-observed tests must pass on the exact pushed head.

### Record — 2026-09-10

Verified state: working tree on `050cf3d5` with this change set uncommitted
(tracked diff `git hash-object` = `dba03300`, plus the untracked `docs/`, the
three new `prisma/migrations/` directories, `src/components/BillingForm.tsx`,
`src/lib/billingResult.ts`, `src/lib/hrScope.ts`, `src/lib/incentiveValidation.ts`
and `src/lib/zatca/submission.ts`). **This is not yet a pushed head**; the
record must be repeated on the pushed commit before acceptance.

Environment: PostgreSQL 16.14 on `127.0.0.1:55432`, Node v24.19.0,
Prisma CLI 5.22.0, Windows x64.

| Check | Result |
| --- | --- |
| `prisma migrate deploy` on an empty database | 16 migrations applied |
| `prisma migrate deploy` upgrading base `1d0dac3` with legacy rows | 4 pending migrations applied |
| `prisma migrate deploy` upgrading legacy rows that violate the new incentive invariants | Fails as intended, `P3018` / SQLSTATE `23514` |
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test`, fresh-migrated database, two consecutive runs | 144/144 both runs |
| `npm test`, upgrade-migrated database | 144/144 |

Upgrade-path data assertions, checked directly in the upgraded database:

- The pre-existing integration key kept `siteId=NULL` and `global=false`; it is
  denied by authentication rather than mapped to a guessed site.
- `Invoice`/`CreditNote` rows in `FAILED` became `UNKNOWN`; an already
  `CLEARED` invoice was untouched; `zatcaAttemptId` stayed `NULL` and
  `ZatcaSubmissionAttempt` was created empty — the migration retransmits nothing.
- `ApiKey_scope_ownership` and the incentive role/value/method CHECKs exist
  after the upgrade, not only on a fresh install.
- In the deliberately invalid case the migration aborted with the offending
  constraint named, and the invalid thresholds and the duplicate catch-all
  reach bracket were left exactly as found. Nothing was silently rewritten.

One code correction was required to reach a clean typecheck:
`tests/review.integration.test.ts` held `prisma.invoice | prisma.creditNote`
as a single value, and those delegate signatures are not mutually assignable
(TS2349). The shared writes and status reads now branch on the document kind
per call. No application code changed for this.

Still outstanding before merge: an independent re-review, verification on the
actual pushed head, and live regulator sandbox acceptance. Production ZATCA
clearance remains disabled.
