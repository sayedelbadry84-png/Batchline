@AGENTS.md

# Batchline project conventions

## Language
All user-facing prose in chat responses must be in Arabic. Code, code comments, commit messages, and identifiers stay in English.

## Code review response workflow
When responding to a pasted `BATCHLINE_PRODUCTION_LIFECYCLE_REVIEW_ROUND*.md` review document:
- Verify every claim against the actual current code at the exact reviewed head SHA before changing anything — do not trust the review's own description of the code without checking.
- Fix every tractable finding in the same round rather than deferring with a "too large for this round" disclosure; reserve disclosure for genuinely large architectural decisions (e.g., a full transactional outbox with no existing job infrastructure), not for ordinary multi-file fixes.
- Add regression tests for every fix: real PostgreSQL integration tests (`tests/*.test.ts`, guarded by `TEST_DATABASE_URL !== DATABASE_URL`) for domain/DB logic, and rendered-component tests via `jsdom` (`tests/*.test.tsx`) for React/UI behavior.
- Run the full verification sequence before committing: `npx prisma format && npx prisma validate && npx prisma generate`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`, and any test files that don't need a database, run locally via `npx tsx --test <file>`.
- Commit in clean, scoped commits (one logical fix per commit) and push directly to the active review feature branch — never to `main`.
- Never merge, approve, or mark a review "accepted"; the branch always awaits independent re-review.
- Report exact commit SHAs and the final head SHA in the Arabic summary, and explicitly disclose anything not verifiable locally (DB-dependent tests, CI-only checks, PR description updates) rather than claiming success for it.

## Known environment limitations (this workspace)
- No `TEST_DATABASE_URL` / database network access locally — integration tests requiring a real Postgres connection can only be verified in CI, never in this session.
- No `gh` CLI available — GitHub PR description/comment updates need the web UI or the user's own authenticated browser.
- OneDrive syncing this working directory can transiently lock `.next/` mid-build (`EPERM: operation not permitted, unlink ...`) — retry the build, or `rm -rf .next` first, before treating it as a real build failure.

## Git hygiene
- Check `git status` before staging; never sweep unrelated, already-uncommitted work into a commit that's outside the current task's scope.

