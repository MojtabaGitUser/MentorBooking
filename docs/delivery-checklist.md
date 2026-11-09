# Delivery checklist

Checked repository items describe the package; unchecked items require a person or remote service.

## Repository

- [x] Work is on `feature/us-20-documentation-delivery`, based directly on verified US-19 commit `39f07d7`.
- [x] Compose starts database, migrations, API, worker, and web.
- [x] Repeatable seed and demo identities are documented.
- [x] README covers setup, workflows, tests, rules, security, and limitations.
- [x] Design covers ERD, accounting, locks/constraints/isolation, rejected alternatives, webhook recovery, DST, worker, and gaps.
- [x] AI usage is disclosed; demo script fits the five-minute maximum.
- [x] No generated local secrets are committed.

## Verification

- [x] Unit coverage includes refund, slots/DST, lifecycle, credit selection, and signing.
- [x] Real PostgreSQL integration includes same-slot/last-credit concurrency.
- [x] E2E includes book → cancel → refund visible in wallet.
- [x] Runtime audit is clean (`npm audit --omit=dev`).
- [x] Development-only `minimatch` advisory is temporarily accepted: inherited by lint tooling, absent from runtime, and forcing an unsupported major was rejected. Re-evaluate when ESLint supports the patched major.
- [x] Results/scope are recorded in `docs/system-tests.md`.

## Manual pre-submission

- [ ] Confirm `git status --short` is clean after the final delivery commit.
- [ ] Record the final commit hash and verify the branch name before sharing.
- [ ] Run final checks on the exact submitted commit.
- [ ] Record/review a demo no longer than five minutes using `docs/demo-script.md`.
- [ ] Ensure the recording contains no secrets, unrelated tabs, notifications, or personal data.
- [ ] Push the approved branch to the intended remote.
- [ ] Confirm the repository viewer renders Mermaid and can access the commit.
- [ ] Submit repository and video URLs; retain commit history.

## Final commands

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm test
docker compose up --build -d --wait
npm run seed
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm audit --omit=dev
git status --short
git log --oneline --decorate -10
```

`docker compose down` preserves data. `docker compose down -v` intentionally destroys database and secret volumes.
