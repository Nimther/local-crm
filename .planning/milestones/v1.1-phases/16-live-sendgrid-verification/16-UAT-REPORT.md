# Phase 16 — Live SendGrid UAT evidence report

**Status: 5/5 live requirements passed on 2026-08-18.** The checks ran against the production VPS and the real SendGrid account, using a dedicated tenant workspace, a second Mail-Send-only BYO API key, a real Dynamic Template, and mailboxes controlled by the operator. No credential, webhook path token, signature, or public key is recorded here.

## Evidence lineage

Plans 16-01 and 16-02 recorded workspace `171285c6-a489-46be-9ee9-ba4ed6964356`. During plan 16-04 the effective production capture setting, endpoint record, tenant-scoped send/contact ownership, recipient hash, and decoded signed body independently identified `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a` as the current dedicated UAT workspace. The earlier identifier is therefore retained below as historical checkpoint evidence, not silently rewritten. The current workspace is the standing canary.

## UAT-01

> Live-отправка с BYO key через Dynamic Template подтверждена

- Verified by plan 16-01, Task 3 human checkpoint; operator approval: the message arrived in the real mailbox, both template substitutions rendered, the visible link was present, and the scripted assertion exited 0.
- Live action: checkpoint date `2026-08-17`. The exact UTC send instant was not retained at approval and is deliberately not reconstructed.
- Historical workspace: `171285c6-a489-46be-9ee9-ba4ed6964356`.
- Send: `d9ac9629-1fb3-5521-9d4b-bdf625d8b9ca`.
- SendGrid message id: `iU2gsMMHQKyB2hMP89dmEQ`.
- Verification command run:

  ```bash
  docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
    -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
    api node scripts/uat-verify.mjs send-attribution \
      --workspace 171285c6-a489-46be-9ee9-ba4ed6964356 \
      --send-id d9ac9629-1fb3-5521-9d4b-bdf625d8b9ca \
      --expect-status sent \
      --expect-events delivered
  ```

- Result: exit `0`; a non-zero event-row count included `delivered` attributed to the send. The real received message supplied the independent rendering/arrival artifact.

## UAT-02

> Live-события delivered / opened / clicked / bounced подтверждены

- Verified by plan 16-02, Task 3 human checkpoint; operator approval: `approved -- UAT-02 passed`.
- Live action: checkpoint date `2026-08-17`. Exact UTC instants for the individual open, click, and bounce events were not retained in the checkpoint summary and are not invented here.
- Historical workspace: `171285c6-a489-46be-9ee9-ba4ed6964356`.
- Flow: `500c77d2-7b6d-4cb7-b262-5d9856618b9f`.
- Hard-bounce campaign: `109811eb-49bb-4bf0-b519-ffbfb56fe7ca`.
- Bounce target: `phase16-hard-bounce-20260817@nimther.com`, an operator-controlled domain confirmed to have no catch-all.
- Verification command run:

  ```bash
  docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
    -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
    api node scripts/uat-verify.mjs event-coverage \
      --workspace 171285c6-a489-46be-9ee9-ba4ed6964356 \
      --since <recorded-session-start-iso8601> \
      --require-campaign \
      --require-flow-step
  ```

- Result: exit `0`; `delivered=3`, `open=4`, `click=1`, `bounce=1`, plus `processed=4`; 13 resolved `send_events` rows. Both `--require-campaign` and `--require-flow-step` passed. The open/click came from the operator's real mail client; the bounce was a real hard rejection.

## UAT-03

> Проверка подписи webhook подтверждена на реальном подписанном payload через полный HTTP-стек

- Verified live by plan 16-04, Task 3 checkpoint, and retained as an 8-case CI regression by plan 16-05.
- Live signed header timestamp: `2026-08-18T05:58:49Z`; captured click occurred at `2026-08-18T05:58:36Z`.
- Current workspace: `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a`.
- Send: `bf8355a4-6df3-5cbd-884e-385d46534d16` (this send id is recorded in 16-04-SUMMARY.md's Accomplishments).
- Provider message id `rN8VRikURB6t62euaBu16w` (base portion; the fixture's raw `sg_message_id` field carries an additional `.recvd-...` receiving-MTA suffix, dropped here as it is not the stable identifier).
- **Provenance of the fields above not spelled out in any SUMMARY:** the provider message id and both timestamps were decoded directly from the committed, inspected fixture `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` (663-byte body, base64-decoded event JSON) — the same artifact 16-04's SUMMARY reports "decoded and inspected... committed it only after confirming one event, one UAT workspace, one UAT send" and 16-05's CI suite guards for absence/tampering. This is the inspected artifact itself, not a re-narration of SUMMARY prose; the send id it carries (`bf8355a4-...`) matches 16-04-SUMMARY's own text exactly, corroborating that this is the same live delivery.
- Capture digest: `5c4d12413c3f9b80bf2d81857c36a13a18e0a27e9ca26432de1c99516086450f`.
- Exact live replay commands (the secret endpoint path is intentionally redacted):

  ```bash
  npm run uat:replay -- \
    --capture /tmp/mega-crm-uat16/capture.json \
    --url https://crm.nimther.com/webhooks/sendgrid/<redacted-path-token>

  npm run uat:replay -- \
    --capture /tmp/mega-crm-uat16/capture.json \
    --url https://crm.nimther.com/webhooks/sendgrid/<redacted-path-token> \
    --flip-byte 0
  ```

- Result: byte-exact replay returned a genuine `2xx` through public HTTPS/Caddy/Fastify (the exact accepted code was not retained); the one-byte mutation returned `400` before parsing, journaling, or enqueue. The checkpoint accepted both directions. The 663-byte, one-event fixture was decoded and inspected before commit.

## UAT-04

> Дедупликация повторно доставленных событий подтверждена live

- Verified by plan 16-04, Task 3 checkpoint; plan 16-05 replays the same signed delivery twice through the HTTP route and production worker in CI.
- Live timestamp/key: click at `2026-08-18T05:58:36Z`, send `bf8355a4-6df3-5cbd-884e-385d46534d16`, workspace `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a`.
- Verification command run after the accepted replay and repeated after the mutated replay:

  ```bash
  docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
    -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
    -v /tmp/mega-crm-uat16:/uat16 \
    api node scripts/uat-verify.mjs dedup \
      --workspace fe8fbbc6-6b25-490b-b3f5-7c739e325c9a \
      --mode compare \
      --snapshot /uat16/dedup-before.json \
      --capture /uat16/capture.json \
      --send-id bf8355a4-6df3-5cbd-884e-385d46534d16 \
      --event-type click \
      --occurred-at 2026-08-18T05:58:36Z
  ```

- Result: exit `0`; `sendEventsCount=1`, `ingressJournalBefore=2`, `ingressJournalAfter=3`, `ingressJournalDelta=1`, `rollupUnchanged=true`, `campaignCountersUnchanged=true`, `captureDigestMatches=true`, `passed=true`. The valid replay was journaled but the domain event and aggregates remained exactly-once; the rejected mutation added nothing.

## UAT-05

> Поведение при 429 и временных ошибках SendGrid подтверждено live

- Verified by plan 16-06's live checkpoint on `2026-08-18`; the operator had approved exactly two UAT-05 messages, and the mailbox thread grew by exactly two, one per successful leg.
- Current workspace: `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a`.

### 429 leg

- Campaign `17e3a2bb-ddff-44af-9e32-e62852caf016`; send `0eb4edb8-94aa-5778-98bf-2fa4cd42c2cb`; provider message id `ylr4opSWRTWRB1oWDbpkOA`.
- First claim `2026-08-18T09:57:07.461Z`; injected 429/provider-backoff log `09:57:07.609Z`; second attempt began `09:57:09.636Z`; `processed` at `09:57:10Z`; `delivered` at `09:57:11Z`.
- Terminal verification command:

  ```bash
  docker compose -f docker/docker-compose.prod.yml \
    -f docker/docker-compose.uat-proxy.yml run --rm --no-deps \
    -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
    api node scripts/uat-verify.mjs uat05-state \
      --workspace fe8fbbc6-6b25-490b-b3f5-7c739e325c9a \
      --send-id 0eb4edb8-94aa-5778-98bf-2fa4cd42c2cb \
      --expect-status sent
  ```

- Result: exit `0`; queue `completed`, ledger `sent`, `attemptCount=2`, real `processed` and `delivered` events, exactly one mailbox copy. The synthetic 429 made zero upstream calls.

### Ambiguous-timeout leg

- First prepared campaign `cbbd761c-7978-495b-8786-8a720bdefaed`, send `2ceb98e8-1aa3-5a82-a952-12afee677867`, was correctly excluded by `frequency_cap`; it made no provider call and no mailbox copy.
- Passing replacement campaign `0c9095c2-4d4f-4117-9a41-e33fc857fcad`; send `150e82da-ca35-5b57-b0e9-3444c83f863e`.
- Queued `2026-08-18T10:02:18.657Z`; claimed `10:02:18.682Z`; `processed` at `10:02:19Z`; `delivered` at `10:02:20Z`; `reconciling` from `10:02:38.688Z`. Scheduled reconciliation at `10:06:13.691Z` reported `scanned=1`, `resolvedSent=1`, `markedUnknown=0`.
- Terminal verification command:

  ```bash
  docker compose -f docker/docker-compose.prod.yml \
    -f docker/docker-compose.uat-proxy.yml run --rm --no-deps \
    -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
    api node scripts/uat-verify.mjs uat05-state \
      --workspace fe8fbbc6-6b25-490b-b3f5-7c739e325c9a \
      --send-id 150e82da-ca35-5b57-b0e9-3444c83f863e \
      --expect-status sent
  ```

- Result: exit `0`; `attemptCount=1`, final status `sent`, real event evidence present, exactly one mailbox copy. The ambiguous send was not retried and became terminal only through the scheduled reconciler.

## Assumptions tested live

- **A1 — confirmed.** The nonexistent local part at the operator-controlled, non-catch-all `nimther.com` domain produced a genuine hard `bounce`, not a deferral or silent accept.
- **A2 — refuted.** The signed capture was not completed inside the default 600-second freshness window; the staged tolerance fallback was needed. After replay, `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` was removed and the effective production default returned to 600 seconds.
- **A3 — confirmed.** The dependency-free `node:http`/`fetch` proxy was sufficient for one-shot 429 and response-delay injection while preserving request bytes/headers, scoping consumption to the UAT workspace, and keeping port 4180 private.

## First-attempt failures and closures

1. The early workspace identifier recorded by plans 16-01/16-02 did not match current production state. Plan 16-04 quarantined the capture, established the current workspace from five independent ownership/configuration signals, and only then accepted and committed the inspected fixture.
2. The plan 16-04 fixture was missing from the local checkout at its checkpoint. It was recovered from the production VPS, decoded and inspected (663 bytes, one owned UAT event), then committed without editing or re-signing.
3. The default webhook freshness window expired before replay. Plan 16-04 used the documented temporary tolerance fallback, reran the valid and mutated replays successfully, then removed the override and read back the default 600-second behavior.
4. UAT-05's first timeout campaign was pre-gated by the contact's frequency cap. Plan 16-06 proved there was no provider call, temporarily raised only this UAT workspace's cap from 3 to 10, ran a replacement campaign successfully, and restored/read back 3.
5. The cold one-shot reporter missed the short 429 deferred window because BullMQ retried after about two seconds. Plan 16-06 retained the first-attempt provider-backoff log and required the terminal `attemptCount=2`; the rerun passed with one delivery.
6. An initial worker restart command allowed Compose to recreate DB and Redis containers. Persistent volumes retained all data; the DB was immediately recreated with the correct production environment and health/data were verified. The runbook was corrected to use `--no-deps` for all later service-only restarts.

## Task 3 checkpoint — teardown verification and canary confirmation

**Approved 2026-08-19.** Operator's verbatim approval: "approved — teardown 5/5 verified; canary delivered 1/1; cap restored 5→3; send id 6fadec0b-79ee-5c40-b71f-c49ab99cc306; provider id oIDnKGNTSO-MRqMTEtpvdQ; retained flow 4589ac55-91e9-479e-b31b-91a6623adb7d; retained campaign fe373109-9cae-4a85-baad-c3af6ae7d5e6."

- All five items of the runbook §16 teardown verification checklist were verified by observation: 5/5.
- The runbook §15 standing-canary smoke procedure was run once, end to end: exactly one canary message delivered (1/1). Canary send id `6fadec0b-79ee-5c40-b71f-c49ab99cc306`; SendGrid provider message id `oIDnKGNTSO-MRqMTEtpvdQ`.
- The workspace frequency cap was temporarily raised for the canary slot per runbook §15 step 2, then restored (operator-reported "cap restored 5→3") and read back.
- Teardown checklist item 2 (raw-capture variable) was covered by the 5/5 teardown observation: no capture line appeared for the fresh canary delivery. See resolution of claim 1 below.
- The retained flow id `4589ac55-91e9-479e-b31b-91a6623adb7d` and retained campaign id `fe373109-9cae-4a85-baad-c3af6ae7d5e6` are confirmed by direct operator observation at this checkpoint (runbook §16 final integrity confirmation).

## Unverified claims carried from an earlier, interrupted 16-07 session — resolution

An earlier attempt at this plan's Task 1 was interrupted before its work was committed. Its draft contained the operational claims below. They were listed unresolved specifically so Task 3's checkpoint would verify each one by direct observation. Task 3 has now run; each claim is resolved below against what the operator actually observed, not against the original draft's wording.

1. **Raw-capture variable cleanup — confirmed.** Teardown checklist item 2 was part of the operator's "teardown 5/5 verified" observation: the effective `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` reads back absent and no capture line appeared for the fresh canary delivery. The operator did not additionally quote the literal env value beyond this observation.
2. **Historical workspace absence — still not independently confirmed.** The draft claimed the 16-01/16-02 workspace (`171285c6-a489-46be-9ee9-ba4ed6964356`) is absent from the current production database. The Task 3 checkpoint approval did not address this specific claim (it is not one of the runbook §16 checklist items). It remains unasserted as fact — plausible given 16-04's finding that `fe8fbbc6-6b25-490b-b3f5-7c739e325c9a` is the current workspace, but not independently checked.
3. **Retained draft flow and campaign — confirmed.** The operator's Task 3 approval names both ids directly: retained flow `4589ac55-91e9-479e-b31b-91a6623adb7d` and retained campaign `fe373109-9cae-4a85-baad-c3af6ae7d5e6`, matching the ids this draft claim originally carried. These are now confirmed by direct operator observation at the 16-07 Task 3 checkpoint, per runbook §16's final integrity confirmation step.
4. **Flow-editor error boundary — unresolved, residual.** The operator's Task 3 approval did not address this claim. It remains an unconfirmed UI observation with no evidence artifact, out of this phase's evidence-only scope, and is not asserted as a Phase 16 finding. Carried to Residual items below.

## Residual items

- Exact per-event UTC timestamps for the historical UAT-01/UAT-02 checkpoints were not captured. Their dates, identifiers, scripted results, and operator artifacts are retained; no timestamps were inferred after the fact.
- The full parallel test aggregate exposed pre-existing shared-Redis timing races; the affected files passed in isolation, and all Phase 16 targeted suites passed. This does not weaken any live verdict above.
- The historical 16-01/16-02 workspace's (`171285c6-a489-46be-9ee9-ba4ed6964356`) presence or absence in the current production database was not independently checked and is not asserted as fact (see claim 2 above).
- An unconfirmed flow-editor UI error-boundary observation from an earlier interrupted session remains unresolved and out of this phase's evidence-only scope (see claim 4 above). Not fixed here; noted for the milestone's own record.
