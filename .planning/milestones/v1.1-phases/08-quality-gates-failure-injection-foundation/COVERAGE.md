No external API integration: Phase 8 builds CI gates, test-DB infrastructure, a migration linter and a failure-injection harness — every SendGrid interaction is faked via the `ProcessSendJobDeps.sendMail` seam.

A SPEC prohibition additionally forbids any network call to the SendGrid host from any scenario in this phase.

The deterministic detector fires on this phase's plan text only because the plans repeatedly *forbid* reaching the SendGrid API (the prohibition rows in `must_haves`), not because any capability of an external API is being integrated. Introducing a configurable SendGrid base URL is explicitly deferred to Phase 16 (08-CONTEXT.md § Deferred Ideas); the live-SendGrid UAT is Phase 16's own release barrier.
