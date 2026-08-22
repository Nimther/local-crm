# Per-Contact PII Inventory

This document is the **shared definition** of what counts as one contact's
personal data in this system. It exists so Phase 21's per-contact DSR export
and Phase 22's physical purge (DSR-03, PRG-*) can never diverge on that
question: **export discloses exactly what this document lists as
included**, **purge must delete or anonymize exactly the same set**, and any
change to either allowlist or to any row of these tables updates this
document in the same change (see `.claude/CLAUDE.md`'s same-change rule and
`.planning/phases/21-per-contact-dsr-export/21-CONTEXT.md` D-01 through D-04).

Phase 22's purge planning depends on this document — see
`.planning/ROADMAP.md`'s Phase 22 section.

## Included

One row per table that carries this contact's personal data.

| Table | Reached via | Personal data columns exported | Excluded columns + reason |
|---|---|---|---|
| `contacts` | `(workspace_id, id)` | `id`, `external_id`, `email`, `first_name`, `last_name`, `phone`, `city`, `country`, `timezone`, `tags`, `subscription_status`, `created_at`, `updated_at`, and `properties` in full | `anonymized_at` (a lifecycle flag, not personal data itself — and non-null means the export refuses entirely, see "Erased contact" below); delivery-health counters such as `consecutive_soft_bounces` (platform state about the address, not data the subject supplied or that describes them personally) |
| `contacts.properties` | (same row as `contacts` above) | Included **WHOLE** — see the dedicated note below | — |
| `subscription_status_history` | `(workspace_id, contact_id)` | `id`, `old_status`, `new_status`, `source`, `reason`, `changed_at` | None — this is the consent history in full; the table is append-only, so no additional tracking exists or is needed |
| `events` | `(workspace_id, contact_id)` | `id`, `name`, `occurred_at`, `received_at` | **`properties`, entirely (D-01)** — see the dedicated note below |
| `sends` | `(workspace_id, contact_id)` | `id`, `campaign_id`, `kind`, `status`, `exclusion_reason`, `provider_message_id`, `queued_at`, `sent_at`, `delivered_at`, `first_opened_at`, `first_clicked_at`, `bounced_at`, `dropped_at`, `unsubscribed_at`, `spam_reported_at`, `bounce_reason`, `drop_reason`, `flow_run_id`, `node_id`, `open_count`, `click_count`, `dispatched_at` | `reconciling_since`, `dispatch_duration_ms` — internal dispatch instrumentation, platform telemetry about the send attempt itself, not personal data |
| `send_events` | `sends.contact_id` (the table carries no `contact_id` of its own; reached by joining through `sends`) | `id`, `sg_event_id`, `event_type`, `reason`, `is_test`, `occurred_at`, `received_at`, and `payload` **only through `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST`** — see the dedicated note below | Everything in `payload` outside `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` |
| `flow_runs` | `(workspace_id, contact_id)` | Which automations processed this person and when: `id`, `flow_id`, `flow_version_id`, `status`, `current_node_id`, `entered_at`, `last_entry_at`, `exited_at`, `exit_reason` | None — processing history is personal data under GDPR Art. 15 |
| `flow_run_steps` | `flow_runs.id` (via the `flow_runs` rows already reached above) | How each step resolved: `id`, `flow_run_id`, `node_id`, `node_type`, `outcome`, `send_id`, `created_at` | None — same GDPR Art. 15 basis as `flow_runs` |
| `campaign_recipients` | `(workspace_id, contact_id)` | Which campaigns targeted this person: `id`, `campaign_id`, `created_at` | None |

### `contacts.properties` — included whole

`contacts.properties` is included **WHOLE** and is deliberately **not**
treated like `events.properties` below. It is the tenant's own structured
record about this subject: it is edited through the contact form (a
tenant-operated UI acting on this specific subject, not a freeform ingestion
endpoint), and it is exactly what DSR-01 means by "custom properties." The
key space here is still tenant-defined, but the values are asserted by the
tenant to be *about this contact* — there is no other-subject-leakage risk
structurally analogous to a freeform ingestion payload, because every key
under `contacts.properties` is written by the tenant editing *this* contact's
record, not copied from an arbitrary inbound payload.

### `events.properties` — excluded entirely (D-01)

`events` exports only its non-JSONB row metadata (`name`, `occurred_at`,
`received_at` — the fact and timing of the event). `properties` is excluded
**in full**. The reason: the whole key space of `events.properties` is
tenant-supplied at event-ingestion time, so any allowlist over it would be
one tenant's schema guessed and applied to every tenant, and a tenant can put
another subject's email, name, or any other person's data under any key
name. This mirrors the Phase 13 erasure ruling verbatim
(`buildScrubbedEventProperties`, `@mega-crm/delivery-core`, returns `{}` for
every input) — **what erasure cannot defend keeping, export cannot defend
disclosing.** The export goes one step further than the scrub and never
selects the column at all.

### `send_events.payload` — extended export allowlist (D-02)

`send_events.payload` passes through `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST`
(`packages/delivery-core/src/send-event-payload-allowlist.ts`), which is a
**strict superset** of the erasure evidence list
`SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`:

- **Evidence list (10 keys, kept by erasure and also disclosed by export):**
  `event`, `type`, `timestamp`, `sg_event_id`, `sg_message_id`, `smtp-id`,
  `status`, `attempt`, `asm_group_id`, `bounce_classification`.
- **Export-only additions (4 keys, disclosed by export, removed by erasure):**
  `ip`, `useragent`, `url`, `reason` — on a per-recipient send event these
  are this subject's own network/device identifiers and the diagnostic text
  about their own delivery attempt, so a DSR answer without them is
  incomplete. Erasure evidence needs only the fact and status of the send,
  so it does not retain them.

The superset relationship export ⊇ evidence is **structural, not just
documented**: `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` is declared as a spread
of `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` in the source file itself, and
`packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts`
asserts both that every evidence key is present in the export list and that
the set difference between the two lists is exactly
`["ip", "useragent", "url", "reason"]` — a future addition to the export
list without an explicit decision fails that test.

Tenant-defined keys (`unique_args`, `categories`, `marketing_campaign_*`, and
any other custom SendGrid argument a tenant's integration might attach) are
excluded from **both** lists, for the same reason as `events.properties`
above: that key space is unenumerable by construction, and a tenant can put
another subject's data under any key name.

## Excluded tables

Tables that hold no per-subject disclosable data, each with a written reason.

| Table | Reason |
|---|---|
| `workspace_suppressions` | Entries are HMAC hashes of the address, keyed per-workspace. There is no plaintext to return; returning the hash would disclose nothing useful to the subject while leaking the suppression mechanism itself. |
| `send_event_quarantine` | Provider events that could not be attributed to a send. Unattributed by definition, so not provably this subject's data. |
| `erasure_records` | Relevant only *after* erasure, at which point the export refuses entirely with the typed 410 that references this row (see "Erased contact" below) rather than exporting the row's contents. |
| Checkpoint and plumbing tables (erasure-scrub cursors, partition maintenance, reconciler runs, alert state, rollups) | Platform bookkeeping with no per-subject content. |

## Erased contact

If `contacts.anonymized_at` is non-null, the export refuses entirely rather
than returning a file of empty or partially-scrubbed shells — see
`.planning/phases/21-per-contact-dsr-export/21-CONTEXT.md` D-13/D-15. This
inventory's "Included" set only applies to a contact that has not been
erased; `erasure_records` is the reference the refusal response cites, not a
table this document allowlists for export.

## Consumed by

- **Phase 21's export** — `apps/api/src/modules/contacts/dsr-export.repository.ts`
  discloses exactly the Included set above, through the same shared
  allowlist constants this document names.
- **Phase 22's purge** — must delete or anonymize exactly the same set this
  document lists as Included; the Excluded tables above are exactly the
  tables the purge does not need to touch on this contact's account, for the
  reasons stated per row.

A change to either allowlist (`packages/delivery-core/src/send-event-payload-allowlist.ts`)
or to any row of the tables named in this document updates this document in
the same change — this is the same-change discipline that keeps export and
purge from diverging on what counts as a contact's personal data.
