# Live SendGrid UAT Runbook

Implements requirements **UAT-01** and the `delivered` leg of **UAT-02**
(`.planning/phases/16-live-sendgrid-verification/16-CONTEXT.md`), decisions
**D-01** through **D-04**, **D-13** and **D-15**. This is the single
operator document for Phase 16's live verification: every mechanism this
phase exercises was already verified against a mock in Phases 8-15 —
`v1.0`'s accepted tech debt was precisely deferred live UAT against the
real SendGrid account, the real deployed VPS, and a real inbox. Later plans
in this phase (16-02 through 16-06) append their own sections below this
one; this document is never duplicated into a second file.

## 1. Scope and safety

- This runbook operates on the **production VPS**, against `docker/docker-compose.prod.yml`'s already-deployed release — there is no staging environment (D-03). Every command below is written to run from the same repo checkout `docs/runbooks/deploy-and-rollback.md`'s `./scripts/deploy.sh` is run from.
- Every UAT step in this phase runs against **one dedicated UAT workspace**, created specifically for this purpose. It is **retained afterwards as a standing canary** (D-15) — do not delete it once UAT-01 passes.
- **No UAT step may ever target a mailbox the operator does not personally control** (D-02). Never address a UAT contact, campaign, or test send at a real customer's or third party's mailbox.
- Every command below is copy-pasteable with placeholders (`<like-this>`) clearly marked. **No credential, key, or token value appears anywhere in this file.**

## 2. Prerequisites checklist

Confirm every item below before starting. None of them is created by this runbook itself — Task 1/2 of plan 16-01 build the verification tooling; the items below are real-account, real-VPS state an operator must set up first.

- [ ] **A second SendGrid API key**, scoped to **Mail Send** only, created on the **same** SendGrid account the Phase 14 verified sender already lives on (D-01 — this project does not provision a second SendGrid account). Create it at SendGrid Dashboard → Settings → API Keys → Create API Key.
- [ ] **A UAT Dynamic Template**, created at SendGrid Dashboard → Email API → Dynamic Templates, with **at least two handlebars substitutions** (e.g. `{{first_name}}`, `{{offer_code}}`) and **one visible, clickable link** in the template body (D-04 — the link is what plan 16-02's `clicked` leg depends on later; do not click it during this plan's own procedure). Record its **template id** (`d-...`) below:

  ```
  UAT_TEMPLATE_ID = <fill in>
  ```

- [ ] **The operator's receiving mailbox is reachable and its domain has NO catch-all.** A catch-all domain silently accepts mail to any local part, which defeats a later bounce test (plan 16-02's `bounce` leg needs an address that genuinely does not exist) — confirm this now even though this plan's own procedure (§8 below) does not yet need a bounce.
- [ ] **SSH access to the production VPS** is confirmed, and the deployed stack is healthy:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/readyz
  ```

  Expect `200`. If it is not, resolve that first — `docs/runbooks/deploy-and-rollback.md`'s "Post-deploy verification" section is the reference.

## 3. UAT workspace creation

Create the workspace through the product's normal sign-up/workspace-creation UI, exactly as any real tenant would, against the production deployment. Record **both** its slug and its workspace id:

```
UAT_WORKSPACE_SLUG = <fill in>
UAT_WORKSPACE_ID   = <fill in — this exact value is what plans 16-03/16-04 set WEBHOOK_RAW_CAPTURE_WORKSPACE_ID to>
```

The workspace id is not shown directly in most UI screens — read it from the API response of any authenticated request against `/api/workspaces/:slug/*` (e.g. the browser's own network inspector while loading the workspace's settings page), or from a direct, tenant-scoped database read if you have operator access. There is no separate lookup script for this — it is a byproduct of any authenticated request the UI already makes.

## 4. BYO key entry

Enter the second SendGrid API key (§2) through the product's own tenant key-entry flow — `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` is the UI this exercises. **Never** as an environment variable, and **never** into `MEGA_CRM_ENV_FILE`: the entire point of D-01 is that this UAT exercises the same BYO code path every real tenant uses, unchanged.

Confirm the UI's own key-check step reports success (a green/connected state) before continuing — a key that fails this check has not actually been accepted by SendGrid and every later step will fail for a reason unrelated to what this UAT is trying to prove.

## 5. Webhook provisioning

Trigger webhook provisioning for the UAT workspace through the product's existing reconnect path — `docs/runbooks/reprovision-webhook-event-types.md` documents the exact mechanism (`POST /api/workspaces/:slug/webhook-reconnect`, or the UI's own "Переподключить"/"check now" actions). Do **not** hand-create a webhook subscription directly in the SendGrid UI — `provisionEventWebhook` is the single chokepoint every tenant-facing path routes through, and this UAT exercises that same path.

Confirm the response reports `"connected": true` and `"provisionStatus": "active"`. If you have direct access to the tenant's SendGrid account, confirm the subscription (named `Mega CRM Delivery Tracking (<workspace prefix>)`) has `processed`, `delivered`, `bounce`, `open`, `click`, `unsubscribe`, `group_unsubscribe`, and `spam_report` all enabled (`apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts`'s `EVENT_FLAGS` — `deferred` is deliberately excluded and must stay excluded).

**Pitfall 6 note:** this SendGrid account is shared across every tenant that has ever connected a key on it. Events for a sibling tenant's sends may transiently reach this platform's webhook endpoint and be discarded — that is expected, correct behavior, not a defect, and is not something this UAT needs to investigate.

## 6. Contact and campaign setup

1. **Create one UAT contact** in the UAT workspace, with its email address set to the operator's own mailbox confirmed in §2.
2. **Create one minimal campaign** referencing the UAT Dynamic Template id (§2) and supplying real values for both of its handlebars substitutions (`apps/web/src/features/campaigns/TemplateSenderPickers.tsx`/`CampaignBuilderPage.tsx` are the UI for this). Address it at the single UAT contact created above — this is a one-recipient send, not a broadcast to any existing audience.

## 7. Running the verification command

`scripts/uat-verify.mjs`'s `send-attribution` subcommand is the scripted assert this whole phase's UAT verdicts route through (D-13 — "verification queries are scripted so 'passed' means a query returned the expected rows, not an eyeball"). Its exit code is: `0` = passed, `1` = a real row was found but an expectation did not match, `2` = a usage error.

**Why this one form and not `npm run uat:verify` from the VPS host directly:** `scripts/` is not copied into the deployed `api`/`worker` runtime images (`docker/Dockerfile.api`'s runtime stage copies only `scripts/migrate-runner.mjs` and `scripts/env-path.mjs`), and the host itself has no direct network path to the `db` service — `docker/docker-compose.prod.yml` publishes only `web`'s ports (T-14-43). The one form below runs the script **inside** the already-running `api` container, on the compose network, bind-mounting in only the one file this plan adds. Run it from the same repo checkout `./scripts/deploy.sh` is run from, with `MEGA_CRM_ENV_FILE`, `GHCR_IMAGE_BASE`, `IMAGE_TAG`, and `SITE_ADDRESS` already exported in your shell (the same pre-deploy checklist `docs/runbooks/deploy-and-rollback.md` documents):

```bash
docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
  -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
  api node scripts/uat-verify.mjs send-attribution \
    --workspace <UAT_WORKSPACE_ID> \
    --message-id <sg_message_id, once known — or --send-id <send_id>> \
    --expect-status sent \
    --expect-events delivered
```

`--no-deps` skips re-starting `db`/`redis` (they are already running as part of the normal `docker compose up` deployment) without disconnecting from the compose network they are reachable on. The `api` image already has plain `node` able to resolve `@mega-crm/tenant-context` — `docker/patch-workspace-mains.mjs`'s own build step compiles every `packages/*` workspace to `dist/` and repoints its `package.json` there specifically so this works inside the image (this is NOT true outside the image — see that script's own header if extending this invocation).

Add `--json` for a machine-parseable single-line report instead of the human-readable multi-line one.

## 8. UAT-01 procedure

1. Launch the campaign created in §6.
2. Wait — SendGrid's `delivered` event typically lands within minutes, not seconds (unlike `processed`).
3. **Confirm arrival in the operator's own mailbox** (§2). Open the message and confirm **both handlebars substitutions rendered as the real values supplied** — no unsubstituted `{{...}}` placeholder text and no empty substitution anywhere in the subject or body. Confirm the visible clickable link (§2) is present; **do not click it yet** — that is plan 16-02's own procedure.
4. Record the send's `sg_message_id` (SendGrid's own message id, visible in the campaign's send log in the UI) — or its internal `send_id` if you have direct database access.
5. Run the §7 command with `--expect-status sent --expect-events delivered`, substituting the values recorded above. It must exit `0` and print a non-zero observed-event-row count together with a `delivered` event line.
6. Record the following — plan 16-07's UAT report cites them:

   ```
   UAT_WORKSPACE_ID = <as recorded in §3>
   SEND_ID           = <fill in>
   SG_MESSAGE_ID      = <fill in>
   UAT01_TIMESTAMP_UTC = <fill in — the UTC time of the live send>
   ```

7. If any step above required a command not documented in this runbook, that is a defect in **this runbook**, to be fixed here — not a note left for the operator to remember next time.

## 9. UAT flow definition (plan 16-02, UAT-02's flow-step leg)

This section defines the **minimal** flow that exercises flow-step attribution — deliberately the smallest shape that still produces a send with a non-null `sends.node_id`: **one trigger event type, one immediate email step, no wait step, no branching.**

1. In the UAT workspace, create a flow with an **event trigger** (not a segment trigger). Name the trigger event exactly:

   ```
   UAT_TRIGGER_EVENT_NAME = uat_flow_trigger
   ```

2. Add exactly **one** node to the canvas: an email-send step referencing the **same UAT Dynamic Template id** recorded in §2 — do not create a second template. Do not add a wait step or any branch/condition node; the flow is one trigger → one send, nothing else.
3. Publish the flow.
4. **Ensure the UAT contact created in §6 exists before firing the trigger** — the event-ingestion endpoint identifies the contact by `email` or `externalId`; it does not create a flow enrollment for an unknown contact on its own.
5. Fire the trigger event by posting to the platform's event-ingestion endpoint (`apps/api/src/modules/events/events-api.routes.ts`), authenticated with an API key scoped to `events:write` (create one at the workspace's API Keys settings page, `apps/web/src/features/api-keys/ApiKeysSettings.tsx`, if one does not already exist for UAT):

   ```bash
   curl -s -X POST "https://<hostname>/v1/events" \
     -H "Authorization: Bearer <UAT_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "uat_flow_trigger",
       "email": "<operator-mailbox-from-section-2>"
     }'
   ```

   Expect a `202` response with `{"results":[{"eventId":"<uuid>","status":"accepted"}]}`. A `202`/`accepted` response means **validated and queued**, not processed (D-24) — the flow-triggered send is dispatched asynchronously by the events-ingest and flow-enrollment workers, same as every other event in this platform.
6. **The flow's recipient is the operator's own mailbox** — the same mailbox §2/§6 already use for the campaign send. Never target any other address from this section.
7. Confirm the flow's run/step actually dispatched: check the flow's detail page (`apps/web/src/features/flows/detail/FlowDetailPage.tsx`'s runs table) for a new run in a terminal state, or query `sends` directly for a row with `kind = 'flow'` and a non-null `node_id` for this workspace/contact.

## 10. Bounce-target selection (D-05)

**Rule:** the bounce-test address MUST be a syntactically valid but definitely nonexistent local part **at a domain the operator personally controls**, confirmed to have live MX records and **no catch-all mailbox**. SendGrid publishes no official bounce-test address (RESEARCH.md Pitfall 5 / A1) — there is no shortcut around this confirmation step.

**Why the no-catch-all check is a precondition, not a formality:** a catch-all domain silently accepts mail addressed to any local part, including one that was never provisioned. Sending to a nonexistent address on a catch-all domain produces **no bounce event at all** — the mail is accepted and vanishes, and the UAT-02 checkpoint would wait indefinitely for an event that SendGrid will never fire. Confirm this BEFORE sending, not after waiting and wondering why nothing arrived.

**MUST NOT:** use a third party's mail infrastructure, a public/shared bounce-test address, or any domain the operator does not personally control to induce this bounce.

Fill in before proceeding to §11:

```
BOUNCE_TARGET_ADDRESS = <fill in — e.g. definitely-nonexistent-local-part@a-domain-you-control.example>
NO_CATCH_ALL_CONFIRMED_HOW = <fill in — e.g. "sent a probe to a second, separately-nonexistent local part at the same domain and confirmed it also hard-bounced" / "domain admin console shows no catch-all/wildcard rule configured">
```

## 11. UAT-02 procedure

Ordered procedure — complete every step before running the final verification command:

1. **Fire the flow trigger** (§9 step 5) and confirm a flow-step send was dispatched (§9 step 7).
2. **Open the received mail in the operator's real mail client** — not a preview pane with images blocked; enable images for this message if that client blocks them by default. This is what produces the `open` event; no automated step can substitute for it.
3. **Click the UAT Dynamic Template's visible link** (§2) and confirm it resolves. This is what produces the `click` event.
4. **Send to the chosen bounce address through the platform, not directly from SendGrid or a mail client** — `event-coverage`'s query only sees `send_events` rows that resolve to a `sends` row (`JOIN sends` + `send_id IS NOT NULL`); a bounce induced outside the platform has no `send_id` and will never appear in the report, silently failing as "missing: bounce" for a reason this runbook would otherwise never explain. Create a second UAT contact whose email is the chosen bounce address (§10) and address a one-recipient campaign at it, same shape as §6 step 2 (reusing the UAT Dynamic Template). Launch that campaign and wait for SendGrid's delivery outcome.
5. Run the verification command (§7's invocation form) with the `event-coverage` subcommand:

   ```bash
   docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
     -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
     api node scripts/uat-verify.mjs event-coverage \
       --workspace <UAT_WORKSPACE_ID> \
       --since <session-start-iso8601> \
       --require-campaign \
       --require-flow-step
   ```

   It must exit `0`, with a report showing all four event types observed, at least one event attributed to a campaign send, and at least one attributed to a flow-step send with a non-null `node_id`.
6. **If the bounce arrives as a soft bounce or a deferral rather than a hard bounce (a 550-class rejection), stop and record that outcome.** This does NOT satisfy UAT-02 — do not retry blindly against another domain. Record it as a gap-closure item under D-16 for a later pass at this checkpoint.

**Note:** this SendGrid account is shared across every tenant that has ever connected a key on it. Events for a sibling tenant's sends may transiently reach this platform's webhook endpoint during this procedure and be discarded by the existing sibling-drop path — that is expected, correct behavior (RESEARCH.md Pitfall 6), not a defect, and `event-coverage`'s tenant-scoped query never counts a discarded sibling event as UAT-02 evidence.

## 12. Capturing the signed payload (plan 16-04, D-09)

**Precondition:** plan 16-03's seams (`SENDGRID_BASE_URL`, `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`) must already be deployed to the production VPS via `scripts/deploy.sh`, and `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` must be set to the UAT workspace id (§3) in `MEGA_CRM_ENV_FILE`, with the `api` container restarted so the value is in effect (`process.env` is read directly at the request handler, not through `apps/api/src/env.ts`'s frozen zod schema — see 16-03-SUMMARY.md — but the api container's own process environment is still only refreshed on container start, so a restart is required after editing `MEGA_CRM_ENV_FILE`).

**Do this in the SAME session as the replay (§13)** — the captured signature's timestamp has a limited freshness window (see §13's freshness note below); extracting the capture now and replaying it days later will fail for a reason that looks identical to a broken verifier.

1. **Trigger a fresh webhook event for the UAT workspace.** Any of §8/§9/§11's sends produces one — the simplest is re-opening or re-clicking an already-delivered UAT message (produces `open`/`click`), or launching a fresh one-recipient campaign (produces `delivered`). Any single event type works for the replay's own purposes (D-09/D-11 do not require a specific event type) — reuse whichever is fastest to trigger live.
2. **Extract the capture log line.** The primary path (fastest — no external round trip, and the operator is already on the host) is grepping the `api` container's own log buffer for plan 16-03's marker literal, exported as `WEBHOOK_RAW_CAPTURE_LOG_MARKER` (`apps/api/src/modules/webhooks/webhooks.routes.ts`):

   ```bash
   docker compose -f docker/docker-compose.prod.yml logs --no-color --tail 500 api | grep 'UAT16_WEBHOOK_RAW_CAPTURE'
   ```

   **Fallback**, if the line has already rotated past the container's local log buffer: run the same LogQL query pattern this project's own log-shipping runbook documents (`docs/runbooks/log-shipping-and-backstop-alerts.md`), scoped to the marker literal, in Grafana Cloud → Explore:

   ```logql
   {service="api"} |= "UAT16_WEBHOOK_RAW_CAPTURE"
   ```

3. **Parse the JSON log line** (both paths above emit one structured Pino line) and read off its three capture fields — named `rawBodyBase64`, `signatureHeaderValue` and `timestampHeaderValue` (16-03-SUMMARY.md; these names deliberately differ from the four-key fixture format below, chosen to bypass Pino's path-based redaction, not to obscure anything).
4. **Assemble the four-key capture file** the replay harness (§13) and plan 16-05's committed fixture both read, mapping the log's field names onto the fixture's own key names, plus the endpoint's stored public key (read from the `webhook_endpoints` table for the UAT workspace, or from wherever the operator originally recorded it at provisioning time — §5):

   ```json
   {
     "rawBodyBase64": "<rawBodyBase64 from the log line>",
     "signature": "<signatureHeaderValue from the log line>",
     "timestamp": "<timestampHeaderValue from the log line>",
     "publicKey": "<the UAT workspace's webhook endpoint public key>"
   }
   ```

   Prepare a host scratch directory owned by the image's runtime UID (`node`, UID 1000) and save the capture there as `/tmp/mega-crm-uat16/capture.json`:

   ```bash
   install -d -m 0700 -o 1000 -g 1000 /tmp/mega-crm-uat16
   ```

   **Do not** write directly to the repository fixture path yet. §13 step 10 below is the only point at which this file is saved into the repository, and only after the decode-and-inspect gate has passed.

## 13. UAT-03/UAT-04 procedure — the freshness choreography (plan 16-04, D-11/D-12)

**State the freshness window plainly before starting:** `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (default 600 seconds, `apps/api/src/env.ts`) bounds how old the signature's own timestamp header may be, in EITHER direction, before the endpoint rejects the request. A stale replay is rejected with the **exact same** fail-closed 400 response as a bad signature (`apps/api/src/modules/webhooks/webhooks.routes.ts` — `isValid`/`isFresh` are combined into one indistinguishable rejection) — so a session that runs long between capture and replay looks **identical** to a genuinely broken verifier. Keep capture and replay inside one sitting, well within the window, and have the fallback below staged in advance rather than discovered mid-session.

Ordered procedure — complete every step in sequence, without a long pause between steps 3 and 6:

Before resuming Phase 16 after the file-KEK cutover, record only these
non-secret facts: the pre-cutover `workspace_sendgrid_keys` row count was
zero, the host validator exited 0, api and worker are healthy, and there are
no AWS-credential errors in their logs. Through the product UI, the operator
then enters the Mail-Send-only UAT key (never chat or an environment
variable). Connect/recheck must succeed without the former HTTP 500; verify
the database row contains only encrypted fields/key mask, then run one
worker-driven test send to prove the worker can decrypt the same key. Only
after those checks pass continue the capture/replay procedure below.

1. **Trigger the fresh event and extract the capture** (§12 steps 1-4 above), assembling `/tmp/mega-crm-uat16/capture.json`. Identify its `send_id`, `event_type`, and `occurred_at` with `send-attribution`/`event-coverage`.
2. **Take the dedup snapshot BEFORE the replay.** The journal count is scoped to the capture's decoded `rawBodyBase64`, not to every journal row in the workspace. This is required because the documented shared SendGrid account can receive unrelated live traffic during the test. Run:

   ```bash
   docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
     -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
     -v /tmp/mega-crm-uat16:/uat16 \
     api node scripts/uat-verify.mjs dedup \
       --workspace <UAT_WORKSPACE_ID> \
       --mode snapshot \
       --snapshot /uat16/dedup-before.json \
       --capture /uat16/capture.json \
       --send-id <send_id> \
       --event-type <event_type> \
       --occurred-at <occurred_at, ISO-8601>
   ```

3. **Replay byte-exactly**, from the same repo checkout `./scripts/deploy.sh` is run from, against the real public HTTPS endpoint (never localhost/loopback — D-09 requires the full stack: Caddy, the raw-body route, and ECDSA verification):

   ```bash
   npm run uat:replay -- --capture /tmp/mega-crm-uat16/capture.json --url https://<hostname>/webhooks/sendgrid/<pathToken>
   ```

   Expect a 2xx. `--flip-byte` is deferred to step 6 below — do not run it here; running the mutation first would journal a REJECTED delivery, which is not itself a problem, but keeps this ordering matched to the compare step's own expectation (exactly one accepted replay between the two snapshots).
4. **Take the dedup snapshot AFTER the accepted replay and compare:**

   ```bash
   docker compose -f docker/docker-compose.prod.yml run --rm --no-deps \
     -v "$(pwd)/scripts/uat-verify.mjs:/app/scripts/uat-verify.mjs:ro" \
     -v /tmp/mega-crm-uat16:/uat16 \
     api node scripts/uat-verify.mjs dedup \
       --workspace <UAT_WORKSPACE_ID> \
       --mode compare \
       --snapshot /uat16/dedup-before.json \
       --capture /uat16/capture.json \
       --send-id <send_id> \
       --event-type <event_type> \
       --occurred-at <occurred_at, ISO-8601>
   ```

   Must exit `0`: `send_events` count for the dedup key is exactly 1, the `ingress_journal` count for this exact captured `raw_batch` increased by exactly 1 (the replay WAS journaled again — that is correct, not a defect, per RESEARCH.md Pitfall 4), and every `workspace_daily_rollup`/campaign counter is unchanged. Unrelated journal rows from the shared SendGrid account are intentionally excluded.
5. **Confirm the replay was accepted, not merely journaled** — re-read step 3's HTTP status: it must be a genuine 2xx from the public endpoint, not a client-side timeout or a locally-cached response.
6. **Run the flipped-byte replay** (D-11's negative check) against the SAME capture file:

   ```bash
   npm run uat:replay -- --capture /tmp/mega-crm-uat16/capture.json --url https://<hostname>/webhooks/sendgrid/<pathToken> --flip-byte 0
   ```

   Expect the endpoint's fail-closed response (400) — not a 2xx. Re-run step 4's compare command again: the `send_events` count for the SAME dedup key must still be exactly 1 (the rejected mutated body produced no new row), and the `ingress_journal` count must NOT have grown a second time (a rejected request never reaches `writeIngressJournal` — the route returns 400 before that point).
7. **If any step above required widening the freshness tolerance** (the session ran long, or step 3's replay was rejected as stale rather than as a genuine signature failure):
   1. Edit `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` in `MEGA_CRM_ENV_FILE` to a larger value (e.g. `3600`).
   2. Restart the `api` container — required, because `apps/api/src/env.ts` parses this value once at process start into a frozen `env` object (`export const env = parsed.data`), not per-request; a running process never observes an edited env file until it restarts:
      ```bash
      docker compose -f docker/docker-compose.prod.yml up -d --force-recreate api
      ```
   3. Re-run steps 1-6 above.
   4. **Restore the original tolerance value in `MEGA_CRM_ENV_FILE` and restart the `api` container again** — this is a required numbered step, not a closing remark:
      ```bash
      docker compose -f docker/docker-compose.prod.yml up -d --force-recreate api
      ```
   5. Confirm the restore took effect by reading the value back — e.g. `docker compose -f docker/docker-compose.prod.yml exec api node -e "console.log(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS)"` should print the original value (or nothing, if it was unset before), never the widened one.
8. **Decode and read the captured batch before saving it anywhere in the repository.** Confirm it contains only events belonging to the UAT workspace's own sends, addressed to the designated throwaway UAT recipient (§2/§6) — no sibling-workspace event, no platform system-mail event, no third party's address (this SendGrid account is shared and fans events out across every connected tenant, RESEARCH.md Pitfall 6 — this inspection is a real gate, not a formality). If the batch contains anything else, discard it and capture an isolated batch during a quiet window instead — do not proceed to step 10 with an uninspected or mixed-tenant capture.
9. **Record the following** — plan 16-07's UAT report cites them:

   ```
   UAT03_04_SEND_ID       = <fill in>
   UAT03_04_EVENT_TYPE    = <fill in>
   UAT03_04_OCCURRED_AT   = <fill in, ISO-8601>
   UAT03_04_REPLAY_HTTP_STATUS       = <fill in — step 3's status, expect 2xx>
   UAT03_04_FLIP_BYTE_HTTP_STATUS    = <fill in — step 6's status, expect 400>
   UAT03_04_DEDUP_COMPARE_EXIT_CODE  = <fill in — step 4's re-run after step 6, expect 0>
   UAT03_04_TOLERANCE_FALLBACK_USED  = <yes/no>
   ```

10. **Only after step 8's inspection has passed**, save the capture file to the repository fixture path with exactly its four keys:

    ```bash
    cp /tmp/mega-crm-uat16/capture.json apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json
    ```

    This file is what makes plan 16-05 autonomous — without it, that plan cannot run.
