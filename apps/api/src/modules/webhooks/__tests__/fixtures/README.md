# Phase 16 live SendGrid fixture

`uat-signed-payload.json` was captured from a real SendGrid Event Webhook delivery to the dedicated Phase 16 UAT workspace on the production deployment on 2026-08-18 UTC.

Before the fixture entered git, the operator decoded and inspected the raw body under plan 16-04's blocking gate. It contains only the designated throwaway UAT recipient's own event and no sibling-workspace, platform-mail, or third-party data. The README intentionally records neither the recipient address nor any endpoint credential.

SendGrid's signature covers the exact raw body bytes and the timestamp header. It does not cover the destination URL, so the regression test can use a newly provisioned endpoint whose stored public key is the fixture's captured public key.

Replacing this fixture requires repeating the live capture, tenant-attribution, decode-and-inspect, byte-exact replay, and one-byte rejection procedure from plan 16-04. Never hand-edit the body, timestamp, signature, or public key, and never re-sign a modified payload to make the test pass.
