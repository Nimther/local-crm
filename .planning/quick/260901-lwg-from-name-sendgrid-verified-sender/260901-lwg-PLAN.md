---
phase: quick-260901-lwg
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/db/src/schema/campaigns.ts
  - packages/db/migrations/0071_campaign_from_name.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/migrations/meta/0071_snapshot.json
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - packages/shared-schemas/src/sendgrid-key.ts
  - apps/api/src/modules/campaigns/sender-resolver.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - packages/shared-schemas/src/queues.ts
  - apps/worker/src/queues/send-dispatch.ts
  - packages/delivery-core/src/send-mail.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
  - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
  - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
  - apps/worker/src/queues/__tests__/test-send-template-snapshot.test.ts
  - packages/delivery-core/src/__tests__/send-mail.test.ts
autonomous: true
requirements: [QT-260901-lwg]

must_haves:
  truths:
    - "A SendGrid verified sender's real `from_name` value (not its UI-only `nickname`) is resolved with `from_email` and persisted on the campaign during launch, schedule, and test-send preparation."
    - "Both ordinary campaign dispatch and test-send dispatch build SendGrid `from` as `{ email, name }` when a non-empty From Name exists; manual-email or legacy rows without a name continue to send as `{ email }`."
    - "The test-send queue's `fromName` snapshot is optional and additive: new workers accept old queued jobs without it and fall back to the campaign row, while old workers can ignore jobs produced with it during a rolling deploy."
    - "Regression tests observe the final SendGrid request for both test and ordinary campaign sends, and explicitly cover the legacy no-name fallback."
  artifacts:
    - "packages/db/migrations/0071_campaign_from_name.sql adds nullable `campaigns.from_name` with generated Drizzle metadata."
    - "packages/delivery-core/src/send-mail.ts supports an optional From Name in the exact SendGrid v3 payload."
    - "packages/shared-schemas/src/queues.ts carries optional `fromName` only as a backward-compatible test-send snapshot field."
  key_links:
    - "SendGrid `/v3/verified_senders` `from_name` -> sender resolver -> locked campaign persistence: scheduled campaigns retain the selected sender's display name until the scheduler eventually fans them out."
    - "campaigns.from_name -> worker `readSendPrereqs`/campaign claim -> `buildMailSendRequest`: ordinary broadcasts use the persisted name without one verified-sender API request per recipient."
    - "test-send route `fromName` snapshot -> optional queue field -> override-first worker prereqs -> SendGrid payload: an edit after enqueue cannot redirect the queued test send, while absent fields retain rolling-deploy compatibility."
---

<objective>
Send the selected SendGrid verified sender's From Name on test and ordinary campaign email,
without changing flow sends or breaking legacy campaigns and already-queued test jobs.

Purpose: inboxes currently receive only `from.email`, so they display the raw address even when
the selected verified sender has a configured From Name.

Output: durable campaign From Name capture, backward-compatible queue propagation, exact
SendGrid payload support, and regression coverage at API, worker, and delivery-core seams.
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@AGENTS.md
@apps/api/src/modules/tenancy/sendgrid-client.ts
@apps/api/src/modules/campaigns/sender-resolver.ts
@apps/api/src/modules/campaigns/campaign.repository.ts
@apps/api/src/modules/campaigns/campaigns.routes.ts
@packages/shared-schemas/src/queues.ts
@apps/worker/src/queues/send-dispatch.ts
@packages/delivery-core/src/send-mail.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Capture the verified sender's From Name and persist it atomically</name>
  <files>packages/db/src/schema/campaigns.ts, packages/db/migrations/0071_campaign_from_name.sql, packages/db/migrations/meta/_journal.json, packages/db/migrations/meta/0071_snapshot.json, apps/api/src/modules/tenancy/sendgrid-client.ts, packages/shared-schemas/src/sendgrid-key.ts, apps/api/src/modules/campaigns/sender-resolver.ts, apps/api/src/modules/campaigns/campaign.repository.ts, apps/api/src/modules/campaigns/campaigns.routes.ts, apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts, apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts, apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts</files>
  <action>
Add a nullable `campaigns.from_name` column through the normal Drizzle schema/migration flow.
Extend the verified-sender response mapping to preserve SendGrid's `from_name` separately from
`nickname`; `nickname` remains only the account/UI label and must never be substituted for an
absent `from_name`.

Change the campaign sender resolver to return the matched email plus optional From Name. Thread
both values through launch, schedule, and test-send preparation, persisting them in the same
locked UPDATE that already persists `from_email` and performs the version bump. Preserve manual
`fromEmail` fallback behavior with no name. For test-send preparation, include `from_name` in the
conditional `IS DISTINCT FROM` write so a changed name is captured, but a true no-op still does
not bump the campaign version. Copy/duplicate the persisted name consistently with the existing
sender fields; do not expose a required name in campaign create/edit schemas.

Update API tests so the SendGrid fixture returns distinct `nickname` and `from_name` strings,
then prove launch, schedule, and test-send persist the real `from_name`. Prove the queued test job
contains that resolved name, not the nickname.
  </action>
  <verify>
    <automated>npm run test:migrations &amp;&amp; npm run test -w apps/api -- src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts src/modules/campaigns/__tests__/sender-resolution.test.ts src/modules/campaigns/__tests__/campaigns-routes.test.ts</automated>
  </verify>
  <done>The migration is reproducible, the API maps `from_name` correctly, all three campaign send entry points persist it under their existing lock/version rules, and the test-send enqueue snapshot contains it.</done>
</task>

<task type="auto">
  <name>Task 2: Carry From Name through dispatch and build the exact SendGrid payload</name>
  <files>packages/shared-schemas/src/queues.ts, apps/worker/src/queues/send-dispatch.ts, packages/delivery-core/src/send-mail.ts, packages/delivery-core/src/__tests__/send-mail.test.ts, apps/worker/src/queues/__tests__/test-send-template-snapshot.test.ts</files>
  <action>
Add optional `fromName` to `BuildMailSendRequestParams` and to the SendGrid request type, emitting
`from: { email, name }` only for a non-empty name and otherwise retaining `{ email }`. Do not
change flow callers: their omitted name must remain valid.

Extend the campaign worker's prerequisite row/result with nullable From Name. Ordinary
`kind='campaign'` jobs must ignore any payload attempt to override sender data and use the
persisted campaign email/name. Add `fromName` as an OPTIONAL, purely additive field to the flat
email-broadcast job schema for `kind='test'`; do not add or bump `schemaVersion`. For test sends,
resolve each snapshot field independently, override-first and row-second, exactly like the
existing template/email compatibility path. Thus a pre-change job without `fromName` still
validates and reads the row, and an old worker safely ignores a new producer's extra field.

At the recording `sendMail` seam, add regressions proving: (1) a test snapshot reaches
`payload.from.name`; (2) an already-enqueued test keeps its captured name across a later row edit;
(3) an old-shaped test job without the field falls back to `campaigns.from_name`; (4) ordinary
campaign dispatch reads the persisted name and cannot be redirected by queue payload fields;
and (5) a null/blank name produces the legacy email-only payload. Add a focused delivery-core
unit assertion for the exact `from` object with and without a name.
  </action>
  <verify>
    <automated>npm run test -w packages/delivery-core -- src/__tests__/send-mail.test.ts &amp;&amp; npm run test -w apps/worker -- src/queues/__tests__/test-send-template-snapshot.test.ts</automated>
  </verify>
  <done>Both test and ordinary campaign sends pass the selected verified sender's real From Name to SendGrid, legacy/no-name sends remain valid, and optional queue-field compatibility is executable in tests.</done>
</task>

<task type="auto">
  <name>Task 3: Run cross-package type and regression gates</name>
  <files>No source changes expected; fix only defects directly caused by Tasks 1-2 in the files already listed above.</files>
  <action>
Run the focused migration/API/worker/delivery tests again as one final gate, then run the
workspace TypeScript builds and lint. Inspect the diff to confirm there is no nickname-as-From-Name fallback,
no required queue-field change, no per-recipient SendGrid verified-sender lookup, and no unrelated
source changes.
  </action>
  <verify>
    <automated>npm run test:migrations &amp;&amp; npm run test -w packages/delivery-core -- src/__tests__/send-mail.test.ts &amp;&amp; npm run test -w apps/api -- src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts src/modules/campaigns/__tests__/sender-resolution.test.ts src/modules/campaigns/__tests__/campaigns-routes.test.ts &amp;&amp; npm run test -w apps/worker -- src/queues/__tests__/test-send-template-snapshot.test.ts &amp;&amp; npm run build &amp;&amp; npm run lint</automated>
  </verify>
  <done>All focused regressions, migration tests, type checks, and lint pass; the diff is limited to the declared From Name path.</done>
</task>

</tasks>

<verification>
- SendGrid's verified-sender `from_name` is preserved distinctly from `nickname`.
- Immediate launch, scheduled launch, and test-send preparation durably retain the selected From Name.
- Final recorded provider payloads contain `from.name` for both `kind='campaign'` and `kind='test'`.
- Old test jobs without `fromName`, legacy rows without `from_name`, manual-email campaigns, and flow sends remain valid.
- Migration, focused regression, workspace build, and lint gates pass.
</verification>

<success_criteria>
- Inbox-visible sender identity is emitted as `From Name &lt;email&gt;` whenever the chosen SendGrid verified sender supplies `from_name`.
- Test and ordinary campaign paths are both covered at the final payload seam.
- Rolling deploys do not reject, defer, or drop old/new mixed-version queue jobs because `fromName` is optional and additive.
</success_criteria>

<output>
Create `.planning/quick/260901-lwg-from-name-sendgrid-verified-sender/260901-lwg-SUMMARY.md` when done.
</output>
