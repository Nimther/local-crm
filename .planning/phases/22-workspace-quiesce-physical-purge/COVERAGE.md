# Phase 22 — External API Coverage Matrix

Detector fired (`api-coverage.cjs`: `{"detected":true}`, signal `(surface)/api` on "Events API key auth + webhook ingest path"). That signal is this platform's **own** ingress surface, not an external integration — but one genuine external-API question does sit inside this phase's scope (RESEARCH.md Open Question 2: should the purge call the tenant's SendGrid account before destroying the credential?). It is decided here rather than left to seal time.

The external API in scope is **SendGrid v3** (per-tenant BYO key). Baseline is full coverage; every row below is a deliberate subtraction.

| capability | decision | reason |
|---|---|---|
| `DELETE /v3/user/webhooks/event/settings/{id}` — webhook deprovision | OPT-OUT | Out of scope per CONTEXT.md; orphaned subscription sits in the tenant's own account, 404s harmlessly against the tombstoned pathToken, and the tenant can remove it. Noted in the purge runbook. |
| `DELETE /v3/api_keys/{api_key_id}` — revoke the tenant's own BYO SendGrid key | OPT-OUT | The key is the tenant's property in the tenant's account; the platform destroys only its own stored ciphertext + DEK (D-11). Revoking a customer-owned credential is not ours to do. |
| `POST /v3/mail/send` — transactional send | OPT-OUT | Inverted by this phase: PRG-06 quiesce forbids sending for a soft-deleted workspace. No new call site is added; the dispatch gate removes them. |
| `GET /v3/user/webhooks/event/settings/signed/public-key` — signature public key | OPT-OUT | Already integrated in Phase 5 and untouched here; this phase only refuses inbound webhooks for quiesced workspaces before signature verification is reached. |
| SendGrid Event Webhook (inbound) — receive/verify/journal delivery events | OPT-OUT | Already fully integrated (Phases 5/11/13). This phase narrows it (D-04 drop for deleted workspaces), adds no new event type or endpoint. |

**Net for this phase:** zero new outbound SendGrid calls, zero new inbound event handling. Every row is a decided subtraction, not an undiscovered hole.
