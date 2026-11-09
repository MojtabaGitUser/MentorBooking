# Demo script (maximum 5 minutes)

Start with the stack healthy and seeded. Keep a terminal beside the browser.

## Before recording

```sh
docker compose up --build -d --wait
npm run seed
docker compose ps
```

Use Alex Chen, a mentor, and Demo Admin. Ensure the mentor has future availability. For payment, create a pending order and keep its provider payment ID ready.

## 0:00–0:40 — architecture and health

- Show the account picker and healthy services.
- State: Next.js, NestJS, PostgreSQL as correctness boundary, separate worker.
- Briefly show `docs/design.md` and `docs/erd.md`.

## 0:40–1:30 — wallet and payment

- Enter as Alex, open Wallet, and create the four-credit pack. Point out that pending does not change balance.
- Run `npm run payment:simulate -- --payment <provider-payment-id> --event succeeded`.
- Refresh and show one grant/history. Mention signed durable receipt, replay safety, refund reversal/debt, and recovery.

## 1:30–2:45 — timezone booking and cancellation

- Browse mentors; point out viewer timezone and UTC offset.
- Book a future slot; show the session and debit.
- Open cancellation and read the preview: more than 24 hours refunds; exactly 24 does not.
- Cancel a distant session and show refund in session history and wallet.
- Explain mentee→mentor locks, transactional recheck, and exclusion constraints.

## 2:45–3:35 — mentor workflow

- Switch to a mentor; show local weekly availability and an absolute blockout.
- Show sessions/attendance. Explain DST gap labels are skipped and folds have one documented occurrence.
- Mention mentor cancellation atomically creates full refund and outbox event.

## 3:35–4:15 — admin and audit

- Switch to Demo Admin, search Alex, and show balance/append-only ledger.
- Grant or revoke with a reason and show the receipt/history.

## 4:15–5:00 — reliability and limits

- Show `docs/system-tests.md`: real Postgres races, DST, webhook recovery, and book→cancel→wallet E2E.
- Close honestly: auth, payment, video, and notification delivery are demos; external delivery is at-least-once; production needs OIDC, hardening, observability, provider contracts, and load tests.

Do not rebuild or run the full suite during recording. Run it beforehand and show the recorded evidence.
