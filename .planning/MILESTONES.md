# Milestones

## v1.0 MVP (Shipped: 2026-07-14)

**Delivered:** A working Klaviyo-class multi-tenant email-marketing platform: isolated workspaces with BYO SendGrid keys, a contact base fed by UI/CSV/events, dynamic segmentation, throttled idempotent broadcast campaigns, webhook-driven delivery tracking with auto-suppression, a visual canvas flow builder with a durable execution engine, and end-to-end analytics.

**Stats:** 7 phases, 96 plans, 243 tasks · 616 commits · 802 files · ~57k LOC TypeScript · 2026-07-02 → 2026-07-14 (13 days)
**Closeout:** verified_closeout — all 7 phases `verification: passed`, 49/49 v1 requirements complete, open-artifact audit clear (11 diagnose-only debug sessions resolved at close; fixes shipped via gap-closure plans or recorded as env tech debt in the milestone audit)

**Key accomplishments:**

1. **Multi-tenant foundation** — shared-schema Postgres with Row-Level Security on every tenant table, better-auth organizations (invites, Owner/Admin/Member role matrix), and KMS envelope encryption (per-tenant DEK, local/AWS KEK toggle) protecting live-validated BYO SendGrid keys.
2. **Contact base & event ingestion** — contact CRUD UI, streaming CSV import wizard with dry-run/error report, and an API-key-authed fast-2xx `/v1/events` pipeline over a partitioned events table with an idempotent BullMQ worker sharing one `upsertContactByIdentity` (external_id-first, email-fallback) across all three ingestion paths.
3. **Segmentation engine** — a fails-closed AND/OR condition compiler (`@mega-crm/segments-core`) producing one SQL WHERE reused verbatim by campaign audiences, flow triggers, and branch checks, with statement-timeout-guarded live preview counts in the builder UI.
4. **Broadcast send pipeline** — draft→scheduled→sending→sent state machine, batched recipient snapshots, two isolated BullMQ queues (triggered/broadcast) throttled by a per-tenant Redis token bucket, a commit-before-network idempotent dispatch that survives crashes without duplicate sends, pre-send suppression gate, and RFC 8058 one-click unsubscribe.
5. **Delivery tracking loop** — auto-provisioned per-tenant signed SendGrid Event Webhooks (self-healing reconnect), raw-body ECDSA verification, exactly-once dedup into partitioned `send_events`, per-message status facts, campaign counters, and automatic bounce/spam/unsubscribe suppression.
6. **Flows & analytics** — @xyflow/react canvas builder (5 node types, honest autosave, publish-time graph validation incl. cycle detection) driving a durable versioned execution engine (pinned versions, re-entry control, DST-correct delays, dispatch-time quiet hours), plus campaign/flow-node/contact-timeline/dashboard/send-log analytics on a dual-write daily rollup.

**Tech debt accepted at close** (see `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for full list): live-email/external-env items requiring a real platform SendGrid key + verified sender, live SendGrid UAT click-throughs (test send to real inbox, one-click unsubscribe redemption), and a set of human visual/UX spot checks carried from phase plans.

**Archived:**
- `.planning/milestones/v1.0-ROADMAP.md`
- `.planning/milestones/v1.0-REQUIREMENTS.md`
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.0-phases/` (7 phase directories, 96 plans + summaries)
