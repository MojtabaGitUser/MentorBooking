# AI usage disclosure

AI coding tools, including Codex and Claude Code where applicable during development, were used as implementation and review assistants. They helped decompose the specification, draft TypeScript/SQL/UI code, identify edge cases, propose test matrices, explain library behavior, and improve documentation. They were also useful for repetitive API DTO, fixture, and first-pass test work.

AI output was not treated as authoritative. Suggestions were checked against the assignment, schema, executed tests, and UI. Important corrections included moving correctness from application-only checks into transactions and constraints; establishing a mentee → mentor → session lock order; preserving exact raw webhook bytes before processing; separating provider-event deduplication from business-transition idempotency; and avoiding claims of exactly-once delivery for an external provider.

Timezone and concurrency suggestions needed the most scrutiny. Naive local-date arithmetic fails at DST gaps/folds, so slot labels are resolved and round-tripped in the mentor's IANA zone before storage as UTC instants. Happy-path mocks were insufficient for spending and booking races, so real PostgreSQL concurrency tests were added. A deliberate mutation removing the mentee lock caused the last-credit test to fail, showing that it detects the race.

AI also tended to overproduce documentation and occasionally describe planned behavior as implemented. The final pass was reconciled with migrations, controllers, Compose, and test commands, then shortened into these deliverables. Final responsibility for the architecture, limitations, evidence, and submitted changes remains with the candidate.
