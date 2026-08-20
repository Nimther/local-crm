# Phase 9 — API Coverage Matrix

The deterministic detector returned `detected: false` for this phase scope
(`api-coverage.cjs --json` over `09-CONTEXT.md` + the ROADMAP phase section). This file is
written anyway because the phase does place one real call against an external API — the
platform SendGrid transactional send used by the operator alert — and an explicit
subtraction record is cheaper than a seal-time ambiguity.

**Scope of the integration:** SendGrid Mail Send v3 (`POST /v3/mail/send`) via
`@sendgrid/mail@8.1.6`, using the platform's own `PLATFORM_SENDGRID_API_KEY`. This is a
**reuse** of the integration `apps/api/src/modules/platform-mail/client.ts` already
established for verification, password-reset and invite email — not a new integration
surface. Per the full-coverage-by-default rule, the capability surface is re-decided here
from the same baseline as that first integration rather than inherited.

## Capability surface

| capability | decision | reason |
|---|---|---|
| `mail.send.plaintext` | INTEGRATE | The operator alert body. D-04 requires plain text so the emergency channel does not depend on a template existing in the platform SendGrid account. |
| `mail.send.html` | OPT-OUT | D-04 forbids an HTML body for this channel; the alert must be readable without rendering, and the existing `platform-mail` module already covers HTML system email. |
| `mail.send.dynamic_template` | OPT-OUT | D-04 explicitly forbids it for the alert path — a template that has been deleted from the SendGrid account would silently break the only push channel the platform has. |
| `mail.send.attachments` | OPT-OUT | The alert carries counts and timestamps in the body; no artifact needs transferring, and an attachment would add a failure mode to an emergency path. |
| `mail.send.scheduling` (`send_at`) | OPT-OUT | An alert whose value is timeliness must never be deferred. Cadence is controlled by the watchdog's own dedup window, not by SendGrid. |
| `mail.send.batch` (`personalizations[]`, multiple recipients) | OPT-OUT | One operator address (`OPERATOR_ALERT_EMAIL`). Multi-operator routing is Phase 15's real alerting concern. |
| `mail.send.categories` / `custom_args` | OPT-OUT | These exist to correlate sends with webhook events; the platform alert channel is not tracked through the event webhook and deliberately produces no `send_events` rows. |
| `mail.send.tracking_settings` (open/click tracking) | OPT-OUT | Tracking an operator alert would add a rewritten-link failure mode to an emergency message for no operational benefit. |
| `mail.send.reply_to` | OPT-OUT | There is no inbound handler for operator replies; a `reply_to` would imply a channel that does not exist. |
| `mail.send.sandbox_mode` | OPT-OUT | Tests inject a fake `sendMail` seam (the Phase 8 `ProcessSendJobDeps.sendMail` pattern), so no test path reaches SendGrid and sandbox mode has no consumer. |
| Event Webhook consumption for alert email | OPT-OUT | Alert delivery status is not tracked — a bounced operator alert goes unnoticed. Known limitation; closing the loop belongs to Phase 15 alerting. |

## Notes

- No new package is installed for this integration; `@sendgrid/mail@8.1.6` is already a
  dependency of `apps/api` and carries verdict OK in RESEARCH.md's Package Legitimacy Audit.
- No tenant BYO SendGrid key is reachable from the alert path — see threat T-09-04 in
  `09-01-PLAN.md`.
- The single un-mitigated gap worth naming: an alert that fails to deliver is invisible to
  this phase. A send *error* propagates and fails the watchdog call (plan 09-01 task 2,
  test 8), but a silent bounce after SendGrid accepts the message does not. This is the
  bridge-to-Phase-15 limitation the phase accepts by design.
