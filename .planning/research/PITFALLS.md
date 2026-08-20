# Pitfalls Research

**Domain:** Adding DSR export, physical tenant purge, HMAC secret rotation, and dependency-audit CI gating to a production multi-tenant email-marketing SaaS (v1.2 Data Lifecycle & Delivery Trust)
**Researched:** 2026-08-20
**Confidence:** MEDIUM (generic patterns cross-checked via web search; project-specific interactions reasoned from this codebase's existing decisions in PROJECT.md — tagged per item below)

## Critical Pitfalls

### Pitfall 1: DSR export leaks other data subjects' PII through freeform JSONB fields

**What goes wrong:**
The export walks `events.properties` and `send_events.payload` for the target contact's own rows, but those columns are tenant-defined freeform JSON (Klaviyo-style event model — explicitly a project decision, not an accident). A marketer can put arbitrary data in an event payload, including another contact's email, order ID, or referrer info (e.g. a "referred_by" event property, a group-purchase event listing multiple participants). A naive "dump the whole row" export ships that embedded PII to the requesting contact.

**Why it happens:**
Export code is written against the schema (one row = one contact's data), not against the actual shape of freeform JSON, which was designed to be open-ended precisely so tenants can put anything in it. This is the same problem Phase 13's erasure scrub already solved and rejected a deny-list for — "deny-list can't cover tenant-defined keys" is already a ratified decision in this codebase (Key Decisions table). An export feature built without reusing that allowlist stance re-introduces the exact leak Phase 13 closed for erasure.

**How to avoid:**
Reuse the Phase 13 evidence-allowlist pattern, not a fresh deny-list: define an explicit allowlist of which top-level event/payload keys are safe to include verbatim (system-reserved keys, known-safe tenant properties), and either omit or flag-and-truncate unknown/freeform keys rather than including them by default. If full payload fidelity is a hard requirement (GDPR Art. 15 arguably requires it), route unknown keys through a per-workspace review step or clearly label them "unverified — may reference third parties" rather than silently including them.

**Warning signs:**
Export code that does `SELECT * FROM events WHERE contact_id = $1` and JSON-stringifies `properties` directly into the output file with no key-level filtering.

**Phase to address:**
DSR-выгрузка контакта (feature 2)

---

### Pitfall 2: Cross-tenant leakage through aggregation/discovery queries in the export path

**What goes wrong:**
To assemble "all related personal data about sends," the export may need to join through campaigns/flows/segments to find every `send_events` row touching the contact. If any of those joins are written without the same RLS-scoping discipline as the rest of the app (e.g. a convenience query that goes through an admin/scan role to "find everything fast" the way `mega_crm_scan` does for the reconciler), it can return rows belonging to a same-named contact in a sibling workspace, or leak workspace-scoped identifiers that let the requester infer another tenant's data existence.

**Why it happens:**
This codebase already has a precedent for privileged cross-workspace scan roles (`mega_crm_scan`, used by the reconciler and webhook-lag watchdog with a narrow column-level grant — migration 0065). A DSR export written under time pressure may reach for that same role "because it's already there and fast," without applying the same narrow-grant discipline that migration 0065 demonstrates is required whenever a privileged path touches tenant tables.

**How to avoid:**
The DSR export must run under the ordinary tenant-scoped RLS session (`SET LOCAL app.tenant_id`), never under `mega_crm_scan` or an admin-scan policy — it has no legitimate need for cross-workspace visibility, unlike the reconciler or watchdogs. Every query in the export path should be index-driven by `(workspace_id, contact_id)`, not a cross-workspace scan filtered after the fact. Add a negative test asserting the export API is unreachable/empty for a sibling-workspace contact id, following the same negative cross-tenant test pattern already used in Phase 10 (24 API + 14 worker tests).

**Warning signs:**
Any export query that doesn't have `workspace_id` in its WHERE clause or that relies on the scan role's session context instead of the request's own tenant context.

**Phase to address:**
DSR-выгрузка контакта (feature 2)

---

### Pitfall 3: DSR export as a slow synchronous HTTP handler (timeout, PII-in-logs, no resumability)

**What goes wrong:**
A contact with a long history (large `events`/`send_events` footprint from a busy trigger flow + broadcast campaigns) makes the export query slow enough to hit HTTP/gateway timeouts, or the handler buffers the entire export in memory before responding. Under load, this either 502s the UI (looks broken, contact retries, doubling load) or — worse — an unhandled query error logs the full row (including PII) to Pino/Sentry, since this is a single per-contact query path that may not go through the same redaction-by-default discipline the send/webhook paths already have.

**Why it happens:**
Per-contact DSR export looks small ("it's one contact, not a segment scan") so it's tempting to implement it as a simple synchronous request/response, unlike the batch/segment code paths in this app which are already async-by-default (BullMQ). The UI requirement ("button in contact card → downloadable file") reinforces a synchronous mental model.

**How to avoid:**
Treat DSR export as a BullMQ job from day one, mirroring the async pattern already used for CSV import and segment sweep: kick off a job, return 202 + job id, poll/notify on completion, serve the finished file (short-lived signed URL or authenticated download endpoint) rather than streaming synchronously. Any error path that touches contact data must go through the existing Pino/Sentry `scrub()` gate (Phase 15 pattern) — do not let export-specific error handling bypass it with a bespoke `logger.error(row)`.

**Warning signs:**
An export route with no queue involvement; error logging in the export path that doesn't route through the shared redaction/scrub utility; export completion assumed to happen within the request lifecycle.

**Phase to address:**
DSR-выгрузка контакта (feature 2)

---

### Pitfall 4: Export of an already-erased/anonymized contact fabricates or silently empties data

**What goes wrong:**
A contact who was previously GDPR-erased (Phase 13 machinery: anonymized profile, hashed suppression, scrubbed payloads) requests a "new" export, or an operator runs export against a contact id that was erased months ago. If the export code assumes a normal, non-erased contact shape, it either (a) returns an empty/misleading file that looks like "we have no data on you" when suppression evidence still legitimately exists, or (b) errors ungracefully because expected columns are null after scrubbing.

**Why it happens:**
Erasure and export are being planned as separate features in this milestone, but they operate on the same rows. Export code written against the "normal contact" happy path won't have been exercised against Phase 13's actual post-erasure row shapes (anonymized profile + `erasure_records` + hashed suppression + scrubbed `send_events.payload`/`events.properties`).

**How to avoid:**
Explicitly design the export's behavior for erased contacts: it should report *that* erasure occurred and reference the `erasure_records` evidence (a factual, compliance-honest answer — "this contact's personal data was erased on X per prior request"), not fabricate contact data that no longer exists and not silently return an empty file that reads as "we hold nothing" when suppression evidence intentionally still exists. Add this as an explicit test case using the erasure fixtures already established in Phase 13.

**Warning signs:**
No test in the export test suite that exercises a contact who has been through the erasure worker; export code with implicit non-null assumptions on profile fields.

**Phase to address:**
DSR-выгрузка контакта (feature 2)

---

### Pitfall 5: Purge treated as a partition-drop instead of scoped in-partition deletes (breaks sibling tenants)

**What goes wrong:**
`events` and `send_events` are partitioned by time (month), *not* by tenant — a decision this project made deliberately for the 100k–1M-contact target. A purge implementation that reaches for "drop the partition, it's fast" (a pattern this team already knows and used correctly for retention — Phase 14's catalog-driven partition drop) is catastrophic here: any given monthly partition holds rows from every tenant active that month, including tenants who are not being purged. Dropping or truncating a partition to purge one workspace destroys every sibling workspace's data in that time range.

**Why it happens:**
The team's only prior experience with "delete a lot of rows fast" on these tables is the Phase 14 retention mechanism, which legitimately operates at the partition level because retention is time-based and workspace-agnostic. Purge is workspace-based, and pattern-matching to "we already have a fast bulk-delete mechanism" reaches for the wrong tool.

**How to avoid:**
Purge must be `DELETE ... WHERE workspace_id = $1` batched (`LIMIT`/keyset, `SKIP LOCKED` where applicable) *inside* live partitions, the same checkpointed-sweep shape already proven in Phase 12 (segment sweep) and Phase 13 (scrub worker) — reuse that pattern, don't invent a new bulk-delete path. Never call `DROP TABLE`/`DETACH PARTITION`/`TRUNCATE` as part of workspace purge. Add an explicit test that purging workspace A leaves an untouched sibling workspace B's rows in the *same* monthly partition intact (row-count assertion before/after).

**Warning signs:**
Any purge code path that references partition names, `pg_class`, or `ALTER TABLE ... DETACH`; purge implemented by the same engineer/module as retention without an explicit workspace-scoping review.

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 6: Purge worker needs a privileged path but ends up weakening RLS for everyone

**What goes wrong:**
Ordinary tenant-scoped RLS (`SET LOCAL app.tenant_id`) is designed for the *current* tenant's session to read/write its own rows — it isn't obviously the right tool for "delete workspace X's rows as a background job with no live user session for X." Under deadline pressure, an implementer reaches for a shortcut: connect as the table owner, add `BYPASSRLS` to the purge role, or `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` temporarily during the purge run. Any of these either weakens isolation permanently (if the flag/role is reused elsewhere) or creates a window where RLS is off for *all* tenants, not just the one being purged.

**Why it happens:**
This is a genuinely awkward case: the purge worker isn't "the tenant" and doesn't have a natural RLS identity, but it must write to tenant tables. Postgres's RLS model doesn't have a built-in "impersonate this one tenant, non-interactively" primitive that's obviously safer than just bypassing RLS.

**How to avoid:**
Follow the existing `mega_crm_scan`/admin-scan-policy precedent already established for exactly this kind of cross-cutting privileged operation (migrations 0039, 0041–0045, and the `SET LOCAL app.admin_scan` pattern used in `attachPartitionCheckFirst`). Purge should run as a dedicated least-privilege role with an explicit, narrowly-scoped admin policy that still requires `workspace_id = $target` in its WHERE clause — the role gets *permission* to act outside a normal tenant session, not a blanket RLS bypass. Never introduce `BYPASSRLS` or a new `DISABLE ROW LEVEL SECURITY` anywhere in the purge path; if the existing admin-scan pattern doesn't cleanly cover a delete (as opposed to the read-only uses it has today), that's a signal to design a new fail-closed policy explicitly for purge, not to loosen an existing one.

**Warning signs:**
`BYPASSRLS` appearing anywhere in a new migration or role grant; any `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` in a purge-related migration; purge connecting as the table owner instead of a dedicated role.

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 7: Purge deletes compliance evidence that must legally outlive the tenant

**What goes wrong:**
A purge implementation that blindly deletes "everything belonging to workspace X" also deletes rows this project has already decided must survive as compliance evidence: `erasure_records` (proof an erasure happened, referenced by Pitfall 4 above), and the per-workspace HMAC suppression hashes (migration 0061) that prove a contact was legitimately suppressed and continue to prevent re-sending if the workspace or a successor re-imports the same external_id. Deleting these doesn't just lose data — it destroys the platform's own evidence that it behaved lawfully, in a domain where "we can prove we honored the unsubscribe" is exactly the kind of thing that matters in a dispute.

**Why it happens:**
"Purge = delete everything for workspace X" is the intuitive framing, and the retention/erasure design distinction ("erasure = anonymize + keep evidence, not physical delete" — an explicit Key Decision in this project) is easy to overlook when scoping a *new*, ostensibly more thorough deletion feature that sounds like it supersedes the earlier one.

**How to avoid:**
Explicitly decide, before implementation, what survives workspace purge and for how long — likely: `erasure_records` and suppression hash evidence should survive purge (they contain no reversible PII once HMAC'd/scrubbed, and their entire purpose is outliving the tenant relationship), while raw PII, tenant secrets (SendGrid key material, KMS-wrapped DEKs), and live tenant tables are purged. Write this decision down as a Key Decision the same way Phase 13's erasure scope was, and add a test asserting `erasure_records`/suppression-hash rows survive a purge run for that workspace.

**Warning signs:**
A purge implementation with a single "delete from every table where workspace_id = X" loop and no explicit exclusion list (mirroring the "5 evidence-table groups excluded by name, refused not skipped" pattern Phase 14 already established for retention — reuse that refuse-not-skip discipline here).

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 8: Purge is non-idempotent / not safely resumable across partial failure

**What goes wrong:**
Purge touches many tables (contacts, events, send_events, segments, flows, campaigns, tenant secrets, KMS key material) with FK/ordering constraints between them. A crash or timeout partway through leaves the workspace in an undefined half-purged state: some tables cleared, others not, with no clean way to tell "did purge run" from "purge is safe to re-run" from "purge is stuck." A naive implementation either fails hard on re-run (unique constraint violations from a second attempt) or silently no-ops on re-run without actually finishing the job.

**Why it happens:**
Purge looks like a one-shot script ("run this once when the workspace crosses the retention window") rather than a long-running, crash-tolerant background process — but at this project's scale and with the project's demonstrated pattern of designing for real `SIGKILL`/crash scenarios (Phase 12 segment sweep kill-resume, Phase 9 partition maintenance, Phase 13 checkpointed scrub), it should be built the same way.

**How to avoid:**
Reuse the checkpointed-worker shape already proven twice in this codebase (Phase 12 bounded segment sweep with kill-resume under real SIGKILL; Phase 13 checkpointed scrub worker + reclaim worker for erasures stuck between commit and enqueue): track purge progress per-table/per-batch in a durable row, make each step idempotent (`DELETE ... WHERE workspace_id = $1 AND <not-already-purged-marker>`), and add a reclaim/resume pass that picks up workspaces left mid-purge. Test with an actual SIGKILL mid-purge in CI, following the Phase 8/9/12 failure-injection precedent, not just a mocked crash. FK/partition ordering across tables (secrets before or after data rows, child tables before parents) must be an explicit, tested sequence — not implicit in whatever order the loop happens to iterate tables.

**Warning signs:**
Purge implemented as a single unchunked transaction across many tables (all-or-nothing is actually *safer* than partial-and-unresumable, but doesn't scale to large workspaces and will itself time out); no `purge_state`/checkpoint table; no test that re-runs purge against a partially-purged workspace.

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 9: Purge doesn't kill in-flight jobs before removing tenant secrets — worker crashes mid-send using a purged KMS key

**What goes wrong:**
If purge removes the tenant's SendGrid key (KMS-wrapped DEK) while there are still queued/in-flight `email:triggered` or `email:broadcast` jobs for that workspace, the worker picks up a job, tries to decrypt the key, and either crashes (unhandled decryption failure) or — worse — silently treats the failure as retryable and loops forever, generating alert noise or blocking the queue's fairness for other workspaces sharing that BullMQ worker pool.

**Why it happens:**
Purge is easy to reason about at the data layer (rows and secrets) but easy to forget has an operational dependency on the queue layer: a soft-deleted workspace could still have residual queued jobs (a stale scheduled campaign, a flow step waiting on quiet hours) that were never explicitly canceled at soft-delete time.

**How to avoid:**
Before removing tenant secrets, the purge worker must confirm no queued/in-flight jobs remain for the target workspace (drain check against `email:triggered`/`email:broadcast` by tenant, plus BullMQ delayed jobs) — either fail closed and defer the purge run, or explicitly cancel/remove those jobs first as a purge sub-step. Handle "key already gone, job still references workspace" as an explicit, correctly-classified terminal failure (dead-letter, not endless retry) in case ordering is ever violated despite the guard, reusing the dead-letter pattern from Phase 12.

**Warning signs:**
Purge implementation with no queue-awareness step; worker decrypt-failure handling that retries indefinitely instead of dead-lettering.

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 10: "Purge complete" is claimed without acknowledging PITR backups still hold the data

**What goes wrong:**
After a successful purge run, the natural internal claim is "workspace X's data is gone." But pgBackRest's off-host encrypted repository (already in production per Phase 14) retains WAL and full/diff/incr backups on its own retention schedule — the purged rows exist, recoverable, in every backup taken before the purge and still within the retention window. If the platform (or a support agent, or documentation) states "your data has been permanently deleted" without qualification, that's a false compliance claim that will not survive a serious audit or a determined DSR follow-up ("prove it's gone from backups too").

**Why it happens:**
"Purge deleted the live rows" and "purge deleted the data" feel synonymous from inside the engineering team, but they aren't the same claim from a regulator's or contact's perspective — and this gap is exactly the kind of thing this project's own convention ("no silent skips, evidence-based verification") is meant to catch.

**How to avoid:**
State the honest claim explicitly, in both internal docs and any user/tenant-facing language: purged data is removed from live tables and rendered "beyond use" (not queryable via the application), but persists in encrypted off-host backups until those backups age out of the existing retention window (per Phase 14's pgBackRest schedule). This mirrors the divergent-but-converging regulatory guidance found in research: CNIL doesn't require backup deletion for erasure compliance; the UK ICO's "beyond use" framing (data may remain in backups until naturally overwritten, provided it isn't accessed or processed) is the standard defensible position, and several authorities converge on "backups may retain data per a documented retention schedule, as long as it's not actively used." Document the pgBackRest retention window as the concrete number in the purge feature's compliance notes, the same way Phase 14 already documented WAL/backup retention operationally.

**Warning signs:**
Any user-facing copy or support-runbook language claiming "permanently and completely deleted" without a backup-retention caveat; no reference to pgBackRest retention in the purge feature's design notes.

**Phase to address:**
Workspace purge (feature 3)

**Confidence:** MEDIUM — cross-checked across CNIL/ICO/Danish DPA guidance summaries; the underlying legal nuance still varies by jurisdiction and isn't a substitute for legal review, but the *engineering* implication (don't overclaim) is solid regardless of which regulator's framing you adopt.

---

### Pitfall 10a: Purge worker runs against a workspace that isn't actually eligible — mis-targeted, restored, or clock/config error

**What goes wrong:**
Purge is a destructive-by-design operation: it exists to thoroughly and irreversibly remove tenant data. If the eligibility check that gates "this workspace is soft-deleted AND has passed the retention window" is wrong, stale, or only checked once (e.g. only at enqueue time, not re-verified at execution time), the worker can purge a workspace that was never actually meant to be purged — an operator typo targeting the wrong workspace id, a workspace that was soft-deleted and then restored (support reversed a cancellation) *after* a purge job was already enqueued for it, or a retention-window calculation that's wrong due to a clock skew or config error making an ineligible workspace look eligible. Because purge is designed to be thorough, this failure mode is not a small bug — it's a full, unrecoverable-except-via-backup data loss for a workspace that should still be live.

**Why it happens:**
Eligibility ("is this workspace actually supposed to be purged") is conceptually a precondition checked once, upstream of the purge job (e.g. at the point a scheduler enqueues purge jobs for workspaces past their retention window). But purge itself, per Pitfall 8, is a long-running, checkpointed, resumable process — there can be a real gap in time between when a workspace was found eligible and when a given batch of its rows is actually deleted, during which the workspace's status could change (restored, retention policy updated, operator intervention). A one-time upstream check doesn't protect against that window.

**How to avoid:**
Follow this project's own fail-closed idiom: re-verify eligibility (`deleted_at IS NOT NULL` and retention window elapsed) *inside* the purge transaction/batch itself, not only at enqueue time — every batch of deletes should re-confirm the workspace is still soft-deleted and still past retention before proceeding, and refuse (not skip silently) if that check fails, following the same "refused, not skipped" discipline Phase 14 already applied to retention-excluded evidence tables. Treat "workspace was restored mid-purge" as an expected, handled case (abort remaining batches, log/alert, leave already-purged batches as-is or reconcile per an explicit policy decision) rather than an edge case nobody planned for. Add a negative test: enqueue a purge job, restore the workspace before the worker processes it, assert the worker refuses to proceed.

**Warning signs:**
Eligibility checked only in the scheduler/enqueue code path with no re-check inside the worker's execution loop; no test simulating a workspace restored between enqueue and execution; purge triggerable by operator action with no re-confirmation step immediately before irreversible deletion begins.

**Phase to address:**
Workspace purge (feature 3)

---

### Pitfall 11: Two-secret webhook-rotation pattern doesn't transfer to unsubscribe-link rotation — old links must survive far longer than a quick revoke window

**What goes wrong:**
The standard advice for rotating an HMAC secret (seen consistently across webhook-signing guidance — Stripe/GitHub/Shopify-style: generate new secret, accept both old+new for a short overlap window, cut over, then revoke the old secret) is built for a sender who can be told "switch to the new secret now" and complies within minutes to hours. Unsubscribe links are the opposite: they're embedded in already-sent emails sitting in millions of recipient inboxes, and — because Gmail/Yahoo's Feb 2024 bulk-sender requirements mandate RFC 8058 one-click unsubscribe — those links (and their signatures) must keep working for as long as the email itself is reachable, which can be months to years, not a rotation-window's worth of hours. Applying the webhook pattern's short revoke window here silently breaks unsubscribe for every recipient who opens an old email after the "old" secret is dropped — a compliance regression (broken RFC 8058 compliance) disguised as routine secret hygiene.

**Why it happens:**
The mental model "rotate the secret, keep the old one around briefly, then drop it" is genuinely the right pattern for webhook signing (this project's own SendGrid Event Webhook already handles signature verification this way conceptually) — it's a natural but wrong analogy to reach for when the requirement says "previous secrets continue to verify old links" without also specifying *how long* "previous" has to mean.

**How to avoid:**
Size previous-secret retention against sent-link lifetime, not a fixed short window: the retention period should be at least as long as the platform is willing to claim old unsubscribe links keep working (a policy decision, not a technical default — consider tying it to the same order-of-magnitude horizon as the event/send-log retention already established in Phase 14, or making it effectively indefinite for previous secrets until an explicit operator decision to drop one). Whatever the number, it must be a deliberate, documented decision — not "however long feels reasonable at rotation time."

**Confidence:** LOW / reasoning-from-spec — the RFC 8058 + rotation web search found no direct source discussing rotation-window sizing for unsubscribe links specifically; this is synthesis from (a) the general webhook-rotation pattern found via search and (b) this project's own RFC 8058/Gmail-bulk-sender requirement already documented in its Phase 4 delivery decisions, not a directly sourced claim.

**Warning signs:**
A rotation design that copies a webhook-signing "keep old secret for N days then drop" pattern verbatim without an explicit link-lifetime policy discussion.

**Phase to address:**
Unsubscribe-secret rotation (feature 4)

---

### Pitfall 12: Multi-secret verification breaks either the timing-safety invariant or the byte-identical no-token-oracle response

**What goes wrong:**
Verifying against `[primary, ...previous]` naively — looping and returning as soon as any secret matches — is fine functionally, but two things go wrong if implemented carelessly: (1) if the per-secret comparison isn't constant-time (`crypto.timingSafeEqual`, not `===` or naive string comparison), an attacker can in principle distinguish "close to a valid signature under secret N" from "not close" through timing, secret by secret; (2) more specific to this codebase, Phase 13 already established a hard invariant — the public unsubscribe route responds byte-identically across all outcomes (valid token / invalid token / already-unsubscribed / expired) so there's no token oracle. A rotation implementation that adds a new branch ("valid under previous secret" vs "valid under primary secret" vs "invalid under all secrets") and lets any of those paths produce even a slightly different response (different status code, different body, different timing due to trying N secrets sequentially with early-exit) reopens the oracle Phase 13 closed.

**Why it happens:**
Rotation naturally wants to be efficient ("try primary first, only fall back to previous if that fails") and that efficiency is exactly what creates a timing signal, and it's easy to treat "verified under an older secret" as functionally different from "verified under the primary" in ways that leak into the response shape, when Phase 13's existing invariant already forbids any observable difference between valid-token outcomes.

**How to avoid:**
Use `crypto.timingSafeEqual` for every secret comparison, and make the *aggregate* multi-secret check itself constant-time-ish in outcome shape: the response the caller sees must remain identical across "valid under primary," "valid under previous secret #1," "valid under previous secret #2," etc. — collapse all of these to the single existing "valid" response path from Phase 13, don't introduce a new branch. Sequential secret-checking with early exit is acceptable for *internal* logic/performance as long as it doesn't change the externally observable response or its timing in a way distinguishable from the existing invalid/expired cases (buffer-length equalization before the loop, as already required for HMAC comparisons, still applies per-secret).

**Warning signs:**
Any `===`/`==` comparison of signature buffers or hex strings anywhere in the rotation code; a new response variant or status code introduced specifically for "verified under an old secret"; test coverage for rotation that doesn't reuse Phase 13's existing byte-identical-response test suite.

**Phase to address:**
Unsubscribe-secret rotation (feature 4)

**Confidence:** MEDIUM — timing-safe comparison and multi-secret fallback pattern cross-checked across multiple webhook-security sources; the byte-identical-response requirement is a project-specific fact (PROJECT.md, Phase 13).

---

### Pitfall 13: Rotation forgets one of the two unsubscribe entry points (GET link vs. RFC 8058 urlencoded POST)

**What goes wrong:**
This exact class of bug already happened once in this codebase — gap-closure 04-14 exists specifically because the RFC 8058 urlencoded POST variant of one-click unsubscribe was initially missed alongside the ordinary GET link path. A rotation implementation that updates signature verification in the route handler for the human-clicked GET link but not in the machine-driven `List-Unsubscribe-Post` handler (or vice versa) means one of the two paths silently starts rejecting valid signatures (or worse, accepting invalid ones) the moment a secret rotates.

**Why it happens:**
The two paths share a concept (verify the token) but may not share a single code path if they were implemented as two separate route handlers; a change applied to "the unsubscribe verification function" doesn't guarantee both routes call the same function unless that was explicitly enforced (and Phase 13 already had to unify two divergent entry points — public route + webhook worker — into one shared `applyUnsubscribeWithSendFact` for the same class of reason).

**How to avoid:**
Verify at code-review time (and with a shared-function test, not just per-route tests) that both the GET unsubscribe link and the RFC 8058 POST handler call the exact same signature-verification function with the exact same secret list — mirroring the "one shared function, both entry points" discipline Phase 13 already applied to `applyUnsubscribeWithSendFact`. Add both paths to the rotation test suite explicitly, referencing gap-closure 04-14 as the reason this is a named regression risk, not a hypothetical one.

**Warning signs:**
Two separate `verifySignature`/`verifyToken` implementations findable via grep; a rotation PR whose diff only touches one route file.

**Phase to address:**
Unsubscribe-secret rotation (feature 4)

**Confidence:** HIGH for the "this already happened once" fact — sourced directly from PROJECT.md's Phase 4 validated-requirements entry (gap-closure 04-14).

---

### Pitfall 14: Unbounded previous-secret list with no expiry — rotation debt rots silently

**What goes wrong:**
Every rotation event appends a secret to the "previous secrets that still verify" list, and if nothing ever prunes that list, it grows unboundedly over the platform's lifetime. Beyond the obvious storage/config bloat, this is a security regression multiplier: every secret ever used remains a valid forgery key for unsubscribe tokens forever, meaning a secret compromised years ago (and rotated away from specifically *because* it was compromised) still verifies signatures today.

**Why it happens:**
"Previous secrets keep working so old links don't break" (the stated feature requirement) has no natural expiry built into that sentence — it's tempting to implement the simplest version (an ever-growing list) and defer the pruning question, especially since Pitfall 11 above argues for *generous* retention on the "don't break old links" side, which pulls in the opposite direction from "don't keep stale secrets forever."

**How to avoid:**
Store each previous secret with an explicit retention/expiry timestamp set at rotation time (derived from the sent-link-lifetime policy decision in Pitfall 11), and build an operator-visible list (not silent) of which secrets are still active for verification and when each is scheduled to drop — mirroring this project's existing "accept-list with owner + expiry, not silent" discipline that the dependency-audit gate (feature 5) also needs. A secret that's about to expire should be a visible, reviewable event, not a background timer no one looks at.

**Warning signs:**
A `previous_secrets` array/column with no per-entry timestamp; no operator-facing surface listing active secrets and their expiry.

**Phase to address:**
Unsubscribe-secret rotation (feature 4)

**Confidence:** MEDIUM — synthesized from general secret-rotation hygiene (cross-checked in webhook-security sources) plus explicit cross-reference to this project's own "accept-list without expiry rots" framing already named in the milestone context for feature 5.

---

### Pitfall 15: Dependency-audit CI gate causes alert fatigue by not distinguishing NEW untriaged advisories from previously-accepted ones

**What goes wrong:**
A naive gate ("fail if `npm audit` reports any HIGH+") breaks on the first day a new advisory lands against any transitive dependency — which happens continuously across a real dependency tree — even for advisories the team has already reviewed and explicitly accepted (e.g. a tooling-only devDependency finding with no runtime exposure). Teams respond to this by either disabling the gate entirely after the first false alarm, or by habitually clicking through/re-approving the same advisory every CI run, which trains everyone to ignore the gate — exactly the "flaky gate" failure mode this project explicitly wants to avoid per its fail-closed, no-silent-skip conventions.

**Why it happens:**
`npm audit`'s exit-code-based pass/fail has no built-in memory of "we already looked at this one" — every run re-evaluates the full current advisory set against a fixed severity threshold, with no distinction between "newly appeared since last run" and "known and accepted."

**How to avoid:**
Use an allowlist/accept-list model (the pattern implemented by `audit-ci` and similar tools) rather than a bare severity threshold: the gate fails only on advisories that are HIGH+ *and not* on the accept-list; anything accepted is explicitly enumerated with an owner and a reason, and the gate's actual enforcement is "any HIGH+ advisory not already in the accept-list is new and must be triaged" — which is the "distinguish NEW untriaged from accepted" mechanism this milestone's own scope already calls for. Combine with `--omit=dev`/`--production`-style scoping (see Pitfall 16) to shrink the advisory surface the gate has to reason about in the first place.

**Warning signs:**
A CI job that just runs `npm audit --audit-level=high` with no accept-list file; a gate that's been red for multiple days without anyone acting (a strong signal it's already being ignored).

**Phase to address:**
Dependency hygiene (feature 5)

**Confidence:** MEDIUM — cross-checked across multiple 2026 npm-audit-in-CI guides and the `audit-ci` project's own stated design (allowlist of known advisories, configurable threshold).

---

### Pitfall 16: Accept-list entries never expire, and devDependency/tooling-only findings pollute the runtime-risk signal

**What goes wrong:**
Two related decay modes: (a) an accept-list with no expiry becomes a permanent blanket exemption — an advisory accepted as "not exploitable in our tooling-only usage" today may become exploitable if the tool's usage changes later (e.g. a build-time-only package gets wired into a runtime path), and nothing forces re-review; (b) without separating `dependencies` from `devDependencies` in the audit scope, every CI/build-tooling CVE (which is the majority of npm advisories by volume) shows up mixed in with genuinely runtime-exposed findings, burying the ones that actually matter behind noise, and pushing teams toward Pitfall 15's fatigue faster.

**Why it happens:**
Accept-list entries are usually added once, under time pressure, to unblock a red CI run, and there's no natural trigger to revisit them later; and `npm audit`'s default behavior audits the full tree (deps + devDeps) unless explicitly scoped, so the "runtime risk" and "build tooling risk" signals arrive pre-mixed.

**How to avoid:**
Require every accept-list entry to carry an explicit expiry/review date and an owner (mirroring the same discipline argued for in Pitfall 14's secret-rotation list) so stale acceptances surface for re-triage rather than living forever; run the audit gate scoped to production dependencies (`--omit=dev` / `--production`) as the primary blocking check, and optionally run a separate, non-blocking devDependency audit for visibility without gate-breaking noise. Note the monorepo-specific quirk: `npm audit --workspaces` from the root can report the same advisory multiple times (once per workspace path) without deduplicating — the accept-list mechanism needs to match on advisory id, not on the full duplicated path string, or the same accepted advisory will re-trigger per workspace.

**Warning signs:**
Accept-list file entries with no date/owner field; the audit gate running against the full tree with no `--omit=dev`/production scoping; the same GHSA id appearing multiple times in gate output across workspace packages.

**Phase to address:**
Dependency hygiene (feature 5)

**Confidence:** MEDIUM — cross-checked across multiple sources on `--omit=dev` scoping reducing false-positive volume and on npm workspaces' non-deduplicated audit reporting.

---

### Pitfall 17: Campaign template fix corrects the symptom on one send path (usually launch) but not schedule or test-send

**What goes wrong:**
The reported bug — "after selecting a new template in the campaign dropdown, the old SendGrid template was sent" — has three independent send entry points in this system's existing state machine (launch, schedule, test-send), each of which presumably reads `template_id` from somewhere. A fix applied only to the path the bug was reproduced on (most likely `launch`, since that's the most-tested path) leaves `schedule` and/or `test-send` reading a stale value from a different source (e.g. client-side component state, a cached TanStack Query result, or a request payload captured before autosave completed) — the bug resurfaces the moment someone reproduces it via the other two paths, and worse, may look "fixed" in QA if only the originally-reported path was retested.

**Why it happens:**
Bug reports describe a symptom observed on one path; the natural fix instinct is to patch where the symptom was seen. Three separate send entry points sharing a state machine doesn't guarantee they share a single "where does template_id come from" code path unless that was explicitly unified — and this project has already had to do exactly this kind of "unify divergent entry points into one shared function" fix twice before (Phase 13's `applyUnsubscribeWithSendFact` for two unsubscribe entry points; the same lesson as Pitfall 13 above).

**How to avoid:**
Fix this at the server, at send time, on all three paths identically: launch, schedule, and test-send should all resolve `template_id` from the *persisted* campaign row read inside the send transaction (not from any client-supplied value, not from a value cached earlier in the request lifecycle), ideally by routing all three through one shared "resolve the send-time template" helper the same way unsubscribe was unified. Add an explicit optimistic-concurrency check: the client can send the `template_id` it believes is current, and the server rejects (rather than silently using its own value) if that doesn't match the persisted row — this catches the client-state-race class of bug (Pitfall 18) as a clean 409 instead of a silent wrong-template send. Test all three paths with the same regression scenario (change template in dropdown, then launch / then schedule / then test-send) rather than only the originally-reported one.

**Warning signs:**
A fix PR that touches only `launchCampaign` (or only the route handler most associated with the original bug report) without corresponding changes in `scheduleCampaign`/`sendTestEmail`; no single shared function for "what template does this campaign use right now."

**Phase to address:**
Campaign template correctness (feature 1)

---

### Pitfall 18: Client-side race between dropdown selection, autosave, and send action captures a stale `template_id`

**What goes wrong:**
The UI likely autosaves campaign edits (template selection included) via a TanStack Query mutation, debounced or fire-and-forget. If the user changes the template dropdown and then immediately clicks Launch/Schedule/Test-send before the autosave mutation has resolved (or before its `invalidateQueries` has actually refetched fresh server state), the send action can read a stale cached `template_id` — either from local component state that hasn't been reconciled with the server yet, or from a TanStack Query cache entry that hasn't been invalidated because the mutation's success callback fired but the query refetch it triggered was still in flight (the exact "invalidateQueries race condition" pattern documented in TanStack's own GitHub discussions: a mutation that returns successfully before its underlying write is durable, racing against invalidation).

**Why it happens:**
Autosave-then-send is a two-step async sequence with no natural coupling between them unless deliberately built — the UI has no reason to *know* it needs to wait for autosave to settle before allowing a send action, especially if the send button was never disabled during the autosave in-flight window.

**How to avoid:**
This is a client-side contributing cause, not the root fix (the server-side fix in Pitfall 17 is the actual invariant that must hold), but it should still be addressed to avoid confusing 409s from the optimistic-concurrency check: disable/guard the Launch/Schedule/Test-send actions while an autosave mutation for that campaign is in flight, and on send, pass the `template_id` value that the *server* last confirmed (post-autosave), not a locally-held dropdown value — i.e. read from the TanStack Query cache only after confirming it reflects the latest successful autosave, not from local form state. This closes the loop the server-side optimistic-concurrency check (Pitfall 17) opens: a well-behaved client should rarely hit that 409, but a network hiccup or slow autosave still can, so the UI needs an honest "still saving, please wait" state rather than treating the send button as always-available the way `LaunchConfirmDialog`'s already-known audience-breakdown-failure defect (v1.1 tech debt) treated it.

**Warning signs:**
A Launch/Schedule/Send button that's enabled immediately after a dropdown change with no visible "saving..." state; a mutation's `onSuccess` that doesn't `await` its own `invalidateQueries` before allowing dependent UI actions.

**Phase to address:**
Campaign template correctness (feature 1)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Fixing template correctness bug only on the reported path (launch) | Ships the visible fix fast, closes the ticket | Bug resurfaces via schedule/test-send; erodes trust in "fixed" bugs | Never — this project has twice already paid the cost of unifying divergent entry points after the fact (unsubscribe GET/POST, unsubscribe public-route/webhook) |
| Synchronous DSR export handler for "small" contacts | Simpler code, no queue plumbing | Breaks under a genuinely large contact history; inconsistent UX between fast and slow contacts; PII-in-timeout-logs risk | Never at this project's target scale (100k–1M contacts); acceptable only behind a hard row-count cap with an explicit "export too large, contact support" fallback if async is truly deferred |
| Purge accept-list-free "delete everything for workspace_id" loop | Fast to write, obviously correct on the happy path | Silently deletes compliance evidence (`erasure_records`, suppression hashes) that must legally survive | Never — must be an explicit, reviewed exclusion list from the first implementation |
| Purge eligibility checked only once at enqueue time | Simpler scheduler/worker split | A workspace restored, or a config/clock error, between enqueue and execution causes an unrecoverable mis-purge | Never — eligibility must be re-verified inside the purge transaction itself |
| Fixed short previous-secret retention window (days) copied from webhook-rotation guidance | Matches familiar, well-documented rotation pattern | Breaks RFC 8058 compliance for every recipient who opens an old email after the window | Never for unsubscribe links specifically; fine for internal webhook signing (SendGrid inbound) where senders switch quickly |
| Bare `npm audit --audit-level=high` gate with no accept-list | Zero setup effort, immediate enforcement | Gate goes red on day one from an unrelated tooling CVE, gets disabled or bypassed within weeks | Acceptable only as a very short-lived first pass before the accept-list mechanism ships in the same phase |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| pgBackRest / off-host backups + purge | Claiming purge means data is "permanently deleted" without qualification | State the honest claim: removed from live tables / "beyond use," persists in encrypted backups until existing retention window expires (Phase 14 schedule) |
| npm audit + npm workspaces | Treating `npm audit --workspaces` output as deduplicated | Match accept-list entries on advisory (GHSA) id, not on the full per-workspace path string, since the same advisory can be reported once per workspace |
| TanStack Query cache + campaign send actions | Reading `template_id` from local/cached client state at send time | Resolve `template_id` server-side from the persisted row inside the send transaction; treat client-supplied value as an optimistic-concurrency check, not a source of truth |
| RFC 8058 List-Unsubscribe-Post + rotation | Updating signature verification in only one of the two unsubscribe entry points (GET link vs. urlencoded POST) | Route both through the single shared verification function already used for both, per the gap-closure 04-14 precedent |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Unbounded per-contact export scan across partitioned `events`/`send_events` without index-driven filtering | Export job runtime scales with total platform event volume instead of the target contact's own volume | Query strictly by `(workspace_id, contact_id)` with a supporting index; never scan a partition range without a contact-scoped predicate | Becomes visible once a single contact accumulates thousands of events (busy flow subscriber, long-tenured account) at the project's target scale (100k–1M contacts, hundreds of thousands of sends/day) |
| Purge as one giant unchunked multi-table transaction | Long-held locks, transaction timeout, replication/WAL bloat during the purge window | Checkpointed, batched deletes per table (reuse Phase 12/13 sweep-worker shape) | Breaks as soon as a workspace has a non-trivial history — even a moderately active tenant's `events`/`send_events` footprint is large enough to make a single-transaction purge exceed reasonable lock-hold time |
| Dependency-audit gate re-scanning the full tree (deps+devDeps, all workspaces) on every CI run with no scoping | CI job runtime grows and advisory-review noise grows as the dependency tree grows | Scope to `--omit=dev`/production for the blocking gate; run devDep audit separately/non-blocking | Noticeable as soon as the accept-list starts accumulating entries faster than they're reviewed |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Purge worker granted `BYPASSRLS` or connects as table owner | Silently weakens tenant isolation for every future query issued by that role/connection, not just purge | Dedicated least-privilege role with narrow admin-scan-style policy requiring `workspace_id = $target`, following migrations 0039/0041–0045 precedent |
| Purge eligibility checked only at enqueue, not re-verified before irreversible deletion | An operator error, restore-after-soft-delete, or clock/config bug causes a full, unrecoverable-except-via-backup purge of a live workspace | Re-verify `deleted_at IS NOT NULL` + retention elapsed inside every purge batch, fail-closed refuse (not skip) if not met |
| Non-constant-time comparison across multiple rotation secrets | Timing side-channel exposes information about which secret (if any) is close to matching | `crypto.timingSafeEqual` per secret; response shape/timing identical across all valid-secret outcomes |
| DSR export includes freeform JSONB fields verbatim | Ships other data subjects' PII embedded in tenant-defined event/payload properties to the requester | Evidence-allowlist for JSONB fields, reusing the Phase 13 erasure-scrub allowlist stance, not a deny-list |
| DSR export run under a privileged/scan DB role for query convenience | Cross-workspace data becomes reachable via a feature that has no legitimate need for it | Export must run under ordinary tenant-scoped RLS session; add negative sibling-workspace test |
| Accept-listed dependency advisories with no expiry | A tooling-only exemption becomes permanently blind to a finding that later becomes exploitable | Every accept-list entry carries an owner and expiry/review date |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| DSR export button gives no feedback while an async job runs | User re-clicks repeatedly, unsure if it worked, generating duplicate export jobs | Visible in-progress state + notification/poll on completion, mirroring existing honest error/empty/stale states from Phase 15 |
| Send/schedule buttons stay enabled during in-flight autosave after a template change | User can trigger a send that races the autosave and (absent the server-side fix) sends the wrong template, or (with the fix) gets a confusing 409 | Disable/guard send actions during in-flight autosave; surface an explicit "saving..." state before allowing send |
| Purge presented as instant ("Delete Workspace" completes immediately) | Operator believes purge is done when it's actually a long-running background process that could still be mid-run or stuck | Surface purge as a tracked, checkpointed operation with visible status (following the pattern already used for other long-running background operations in this system) |

## "Looks Done But Isn't" Checklist

- [ ] **Template correctness fix:** Often fixed on launch only — verify schedule AND test-send independently reproduce-and-pass the same regression scenario (change template in dropdown, then send via each of the three paths)
- [ ] **DSR export:** Often missing coverage for already-erased contacts — verify export against a contact that has been through Phase 13's erasure worker, not just a normal contact
- [ ] **DSR export:** Often missing JSONB allowlist filtering — verify with a fixture event/payload containing a synthetic "other person's" field and confirm it's excluded or flagged, not included verbatim
- [ ] **Workspace purge:** Often missing sibling-workspace isolation proof — verify purging workspace A leaves workspace B's rows in the *same* monthly partition unchanged
- [ ] **Workspace purge:** Often missing crash-resume proof — verify a real SIGKILL mid-purge followed by re-run completes cleanly with no duplicate-key errors and no orphaned rows
- [ ] **Workspace purge:** Often missing eligibility re-verification — verify the worker refuses to purge a workspace restored (undeleted) between enqueue and execution, and refuses a workspace that was never soft-deleted
- [ ] **Unsubscribe rotation:** Often missing POST-path coverage — verify rotation is exercised against both the GET link and the RFC 8058 urlencoded POST handler, not just one
- [ ] **Unsubscribe rotation:** Often missing byte-identical-response proof — verify the response is identical (status, body, headers) across primary-secret-valid, previous-secret-valid, invalid, and expired outcomes
- [ ] **Dependency-audit gate:** Often missing accept-list expiry — verify every accepted advisory in the allowlist carries an owner and a review/expiry date, not just a bare advisory id

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|------------------|
| Purge dropped/truncated a shared partition | HIGH | Restore affected sibling workspaces' data from the most recent pre-incident PITR backup into a scratch DB, re-insert only the affected sibling rows, verify row counts against backup baseline (mirrors the restore-drill verification already proven in Phase 14) |
| Purge ran against a mis-targeted or restored-in-flight workspace | HIGH | Restore the affected workspace from the most recent pre-purge PITR backup (same scratch-DB restore-drill procedure as above); this is why eligibility re-verification (Pitfall 10a) is prevention, not just detection — recovery always means falling back to backups |
| DSR export leaked another contact's PII in a delivered file | HIGH | Treat as a data breach: identify all requesters who received the affected export, notify per breach-notification obligations, patch the allowlist, re-issue corrected exports; this is a multi-party GDPR incident, not a simple bug fix |
| Rotation dropped a previous secret too early, breaking old unsubscribe links | MEDIUM | Cannot un-break already-served emails; mitigate by monitoring unsubscribe-failure rate post-drop, and if detected, restore the dropped secret to the previous-secrets list immediately (if retained anywhere) to stop further breakage, then re-plan retention sizing per Pitfall 11 |
| Dependency-audit gate disabled/bypassed after alert fatigue | LOW | Re-enable with the allowlist model from Pitfall 15/16 rather than the bare threshold that caused the fatigue; backfill accept-list entries for currently-known advisories with owners/expiry before re-enabling as blocking |
| Campaign fix applied only to launch path, bug resurfaces via schedule | LOW | Apply the same server-side template_id-resolution fix to the remaining paths; this is exactly the class of gap-closure round this project's own execution pattern already expects (up to 5 rounds seen in Phase 4/5) |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase (feature) | Verification |
|---------|------------------------------|----------------|
| Template fix applied to only one send path | Campaign template correctness | Regression test exercises launch, schedule, and test-send identically against the same "changed template" scenario |
| Client autosave/dropdown race captures stale template_id | Campaign template correctness | Server-side optimistic-concurrency check rejects mismatched client-supplied template_id with a 409; UI test covers rapid change-then-send |
| JSONB freeform payload leaks other contacts' PII in export | DSR-выгрузка контакта | Allowlist-filtering test with a synthetic other-person field fixture |
| Cross-tenant leakage via privileged/scan-role export queries | DSR-выгрузка контакта | Negative test: sibling-workspace contact id returns nothing via the export API |
| Synchronous export handler times out / leaks PII on error | DSR-выгрузка контакта | Export implemented as a BullMQ job; error paths route through existing scrub()/redaction gate |
| Export of already-erased contact fabricates data | DSR-выгрузка контакта | Test fixture: contact processed by Phase 13 erasure worker, then exported; asserts erasure_records-based honest response |
| Purge drops/truncates shared time-partitions | Workspace purge | Sibling-workspace row-count-unchanged test in the same monthly partition |
| Purge worker weakens RLS via BYPASSRLS/owner connection | Workspace purge | Migration/role review gate; no BYPASSRLS grant introduced; admin-scan-policy pattern reused |
| Purge deletes compliance evidence (erasure_records, suppression hashes) | Workspace purge | Explicit exclusion list, refused-not-skipped pattern (Phase 14 precedent); post-purge assertion these rows survive |
| Purge is non-idempotent / not resumable across crash | Workspace purge | Real SIGKILL-mid-purge CI scenario, re-run-to-completion assertion |
| Purge removes secrets before in-flight jobs drain | Workspace purge | Pre-purge queue-drain check for the target workspace; dead-letter (not infinite retry) on any residual decrypt failure |
| "Purge complete" overclaims against PITR backup retention | Workspace purge | Documentation/compliance-notes review; explicit backup-retention caveat in any user/tenant-facing purge confirmation |
| Purge runs against a mis-targeted / restored / ineligible workspace | Workspace purge | Eligibility re-verified inside the purge transaction itself; negative test for restored-between-enqueue-and-execution workspace |
| Two-secret webhook-rotation pattern under-retains previous unsubscribe secrets | Unsubscribe-secret rotation | Explicit sent-link-lifetime-based retention policy documented as a Key Decision, not a default window |
| Multi-secret verification breaks timing-safety or byte-identical response | Unsubscribe-secret rotation | Reuse Phase 13's byte-identical-response test suite against all secret-outcome branches; timingSafeEqual audit |
| Rotation misses the RFC 8058 POST path | Unsubscribe-secret rotation | Both GET and POST paths exercised in the rotation regression suite; shared-verification-function grep check |
| Unbounded previous-secret list with no expiry | Unsubscribe-secret rotation | Per-secret expiry timestamp required at schema level; operator-visible active-secrets list |
| Dependency gate alert fatigue from undistinguished new advisories | Dependency hygiene | Accept-list model (audit-ci-style); gate fails only on HIGH+ not already accepted |
| Accept-list entries never expire / devDep noise pollutes signal | Dependency hygiene | Every accept-list entry has owner + expiry; `--omit=dev` scoping for the blocking gate; GHSA-id-based dedup across npm workspaces |

## Sources

- [Multi-Tenant SaaS Security Testing: How to Prevent Cross-Tenant Data Leaks](https://bugstrix.com/blogs/multi-tenant-saas-security-testing-how-to-prevent-cross-tenant-data-leaks/) — MEDIUM, cross-tenant leak/DSAR risk framing
- [Data Isolation For Multi-Tenant SaaS: GDPR-Compliant Hosting Architectures](https://www.dchost.com/blog/en/data-isolation-for-multi-tenant-saas-gdpr-compliant-hosting-architectures/) — MEDIUM
- [RFC 8058 Explained: How One-Click Unsubscribe Works](https://glockapps.com/blog/rfc-8058-explained/) — MEDIUM, Gmail/Yahoo bulk-sender requirement confirmation
- [What Is RFC 8058, How It Works & How to Implement It](https://www.mailmodo.com/guides/rfc-8058/) — MEDIUM
- [GitHub - IBM/audit-ci](https://github.com/IBM/audit-ci) — HIGH (first-party tool design: allowlist of known advisories, configurable severity threshold)
- [Why npm Audit Is Broken (And What to Use Instead) 2026](https://www.pkgpulse.com/guides/why-npm-audit-is-broken) — LOW/MEDIUM, single-source but consistent with audit-ci's own stated rationale
- [npm-audit | npm Docs](https://docs.npmjs.com/cli/audit/) — HIGH, first-party npm documentation (`--omit=dev` scoping)
- [Multi-tenant data isolation with PostgreSQL Row Level Security | AWS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) — HIGH, first-party AWS guidance; cross-checked against this project's own already-adopted RLS+FORCE approach
- [Row Level Security for Tenants in Postgres | Crunchy Data Blog](https://www.crunchydata.com/blog/row-level-security-for-tenants-in-postgres) — MEDIUM
- [Postgres Row-Level Security in Practice](https://queryplane.com/blog/postgres-row-level-security-in-practice/) — MEDIUM, owner-bypass/FORCE ROW LEVEL SECURITY pitfall, cross-checked with AWS source
- [How is the Right to Erasure Applied Under the GDPR — Jetico](https://jetico.com/blog/how-right-erasure-applied-under-gdpr-complete-guide-organizational-compliance/) — MEDIUM
- [GDPR: Do I Need to Erase Personal Data from Backup Systems — VeraSafe](https://verasafe.com/blog/do-i-need-to-erase-personal-data-from-backup-systems-under-the-gdpr/) — MEDIUM, CNIL/ICO/Danish DPA divergence, cross-checked across multiple summaries
- [GDPR Right To Erasure: Should You Delete Backups As Well? — Hall Brown](https://hallboothsmith.com/we-all-know-about-gdprs-right-to-erasure-does-this-mean-you-have-to-delete-data-from-backups-as-well/) — MEDIUM
- [Design asynchronous API | The REST API cookbook](https://octo-woapi.github.io/cookbook/asynchronous-api.html) — MEDIUM, async job pattern (202 + Retry-After + status polling) for large exports
- [GDPR Implementation: Building Data Deletion and Export APIs That Actually Work](https://medium.com/@sohail_saifii/gdpr-implementation-building-data-deletion-and-export-apis-that-actually-work-833b34eb09f6) — LOW, single-source practitioner writeup
- [useQuery + invalidateQueries intermittently stale UI · TanStack/query · Discussion #6953](https://github.com/TanStack/query/discussions/6953) — HIGH, first-party TanStack maintainer discussion of the invalidation race
- [stale closure in invalidated queries · Issue #1194 · TanStack/query](https://github.com/TanStack/query/issues/1194) — HIGH, first-party TanStack issue tracker
- [Webhook Signature Validation HMAC SHA256 Best Practices — OpsecForge](https://www.opsecforge.com/blog/webhook-signature-validation-hmac-sha256-best-practices-2026) — MEDIUM, timingSafeEqual + multi-secret rotation pattern, cross-checked against multiple webhook-security guides
- [HMAC verification is vulnerable to timing attack (GHSA advisory)](https://github.com/junkurihara/httpsig-rs/security/advisories/GHSA-q7pg-9pr4-mrp2) — HIGH, first-party security advisory
- Project-internal facts (PROJECT.md, this repository): Phase 13 erasure/scrub-allowlist decision, Phase 13 unified `applyUnsubscribeWithSendFact`/byte-identical response, gap-closure 04-14 (RFC 8058 POST path), Phase 9/12/13/14 checkpointed-sweep and admin-scan-role precedents, Phase 14 catalog-driven partition retention and evidence-table exclusion pattern, Phase 12 dead-letter pattern — HIGH confidence (primary source: this project's own shipped decisions)

---
*Pitfalls research for: Mega CRM v1.2 Data Lifecycle & Delivery Trust*
*Researched: 2026-08-20*
