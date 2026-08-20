---
phase: quick-260818-aqd
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/kms/src/env.ts
  - packages/kms/src/client.ts
  - packages/kms/src/file-provider.ts
  - packages/kms/src/index.ts
  - packages/kms/src/__tests__/file-provider.test.ts
  - packages/kms/src/__tests__/envelope.test.ts
  - apps/api/src/env.ts
  - apps/api/src/server.ts
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/worker/src/server.ts
  - docker/docker-compose.prod.yml
  - docker/prod.env.example
  - scripts/check-env.mjs
  - scripts/validate-kek-file.mjs
  - scripts/__tests__/validate-kek-file.test.mjs
  - scripts/validate-prod-compose.mjs
  - scripts/__tests__/validate-prod-compose.test.mjs
  - scripts/deploy.sh
  - scripts/__tests__/deploy-script.test.mjs
  - docs/runbooks/production-topology.md
  - docs/runbooks/deploy-and-rollback.md
  - docs/runbooks/uat-live-sendgrid.md
autonomous: false
requirements: [UAT-01, UAT-02, UAT-03, UAT-04, UAT-05]

must_haves:
  truths:
    - "Production accepts KMS_PROVIDER=file without any AWS account or credential, while KMS_PROVIDER=local remains forbidden in production and unknown provider names fail closed instead of silently selecting local."
    - "The file provider preserves the existing envelope-encryption contract: a fresh AES-256 DEK per secret, AES-256-GCM wrapping, workspaceId as authenticated data, tamper rejection, tenant binding, and prompt zeroing of plaintext KEK/DEK buffers."
    - "The production KEK is a 32-byte random value stored outside the repository in a root-owned regular file with mode 0440 and dedicated numeric group 1999; both applications refuse readiness when the file is absent, malformed, a symlink, incorrectly owned, or too permissive."
    - "Only api and worker receive the KEK bind mount and supplemental group; db, redis, web, migrate, pgbackrest, and alloy receive neither the mount nor the key material."
    - "The documented threat boundary is explicit: a database-only compromise does not reveal tenant SendGrid keys, but a full VPS/root or api/worker process compromise can read the KEK and is not protected by this design."
    - "Deployment fails before migrations or container replacement when the host KEK file is unsafe, confirms api and worker health after replacement, and restores the tenant SendGrid-key flow from HTTP 500 to a successful encrypted save/decrypt path."
    - "Existing production ciphertext is not silently orphaned: before switching providers, the operator proves there are no AWS-wrapped workspace_sendgrid_keys rows, or stops and follows an explicit re-enrollment/rewrap decision; the KEK is never rotated in place."
  artifacts:
    - "packages/kms/src/file-provider.ts — production-capable, file-backed provider with strict key-file validation and the same KmsProvider contract as AWS/local"
    - "packages/kms/src/__tests__/file-provider.test.ts — executable coverage for round-trip, tenant AAD, tamper/malformed input, file ownership/mode/type checks, and zeroization behavior"
    - "docker/docker-compose.prod.yml — read-only KEK bind mount plus group_add 1999 on api/worker only"
    - "scripts/validate-kek-file.mjs — non-leaking host preflight used by deploy.sh before any production mutation"
    - "scripts/validate-prod-compose.mjs — CI invariant proving mount/group isolation to exactly api and worker"
    - "docs/runbooks/deploy-and-rollback.md — one-time provisioning, cutover, rotation prohibition/recovery, and rollback procedure"
    - "docs/runbooks/uat-live-sendgrid.md — Phase 16 continuation after KEK cutover, including evidence that BYO key save and worker decrypt no longer return 500"
  key_links:
    - "apps/api/src/env.ts + packages/kms/src/env.ts -> packages/kms/src/client.ts: the exact provider union and required KMS_FILE_KEK_PATH select file-provider without a typo falling back to local"
    - "docker/docker-compose.prod.yml api/worker mounts -> KMS_FILE_KEK_PATH=/run/secrets/mega-crm-kek -> file-provider.ts: the configured container path resolves to the read-only root:1999 0440 file both processes validate before readiness"
    - "packages/kms/src/file-provider.ts workspaceId AAD -> workspace_sendgrid_keys.encrypted_dek -> decryptTenantSecret at worker dispatch: a wrapped DEK copied between tenant rows cannot be unwrapped under another workspace"
    - "scripts/deploy.sh -> scripts/validate-kek-file.mjs -> /etc/mega-crm/kek: unsafe or missing host key aborts before compose pull/migrate/up, and validation output never contains key bytes"
    - "scripts/validate-prod-compose.mjs -> docker/docker-compose.prod.yml: CI proves only api/worker have both the mount target and group 1999; env_file presence alone is not mistaken for secret access"
    - "docs/runbooks/deploy-and-rollback.md cutover query -> workspace_sendgrid_keys: provider switch is allowed only with zero AWS-wrapped rows unless a separately approved migration/re-enrollment path exists"
    - "successful API key connect/recheck -> encrypted row -> worker test send/decrypt -> Phase 16 uat-verify evidence: the original Internal Server Error is closed before live UAT resumes"
---

<objective>
Replace the unavailable AWS dependency on the DigitalOcean production VPS with a production-safe file-backed KEK provider, without weakening the existing envelope-encryption or tenant-binding properties.

Purpose: the deployed API currently requires AWS KMS credentials the operator does not have, so saving the Phase 16 BYO SendGrid key fails with HTTP 500. A root-owned, read-only host key mounted only into API and worker protects against a database-only compromise and unblocks live SendGrid UAT. It deliberately does not claim protection from a compromised VPS/root or compromised application process.

Output: a tested provider and fail-closed configuration, compose/deploy isolation gates, an operator-safe VPS cutover, and evidence that the SendGrid-key path works before Phase 16 UAT continues.
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@packages/kms/src/client.ts
@packages/kms/src/env.ts
@packages/kms/src/local-provider.ts
@packages/kms/src/aws-provider.ts
@packages/kms/src/__tests__/envelope.test.ts
@apps/api/src/env.ts
@apps/api/src/server.ts
@apps/worker/src/server.ts
@docker/docker-compose.prod.yml
@docker/prod.env.example
@scripts/check-env.mjs
@scripts/validate-prod-compose.mjs
@scripts/deploy.sh
@docs/runbooks/production-topology.md
@docs/runbooks/deploy-and-rollback.md
@docs/runbooks/uat-live-sendgrid.md
</context>

<hard_constraints>

1. Do not add an AWS account, AWS credentials, DigitalOcean secret product, Vault, or a plaintext KEK environment variable. `KMS_LOCAL_KEK` remains development/test only. The new production provider reads key bytes only from the mounted file.

2. The host source is `/etc/mega-crm/kek`; the container target is `/run/secrets/mega-crm-kek`; ownership is numeric `root:1999`; mode is exactly `0440`; group 1999 is dedicated to this mount. API and worker images continue to run as `USER node` and receive only supplemental group 1999. Do not run them as root to make the file readable.

3. Mount the file read-only into `api` and `worker` only. In particular, `migrate` reuses the API image but must not receive the mount or supplemental group because migrations do not encrypt or decrypt tenant secrets.

4. Never print, log, snapshot, commit, place in an env file, or expose through an error message the KEK contents. Tests use generated temporary keys only. Any validator reports path/metadata/reason, never bytes or decoded material.

5. Fail closed. Production boot/readiness must reject a missing file, symlink/non-regular file, non-root owner, wrong group, mode other than 0440, invalid base64, trailing non-whitespace garbage, or decoded length other than 32 bytes. Unknown `KMS_PROVIDER` values must be validation errors.

6. Do not change ciphertext columns or invent an unversioned silent migration. Existing AWS-wrapped DEKs cannot be decrypted without AWS; cutover therefore requires a zero-row preflight or an explicit operator decision to re-enroll affected keys. Never overwrite/rotate `/etc/mega-crm/kek` while rows encrypted under it exist.

7. Deployment and real SendGrid UAT are external production actions. Stop for the normal operator checkpoint before provisioning the VPS file/deploying and for the tenant key entry/manual inbox steps. Do not paste the SendGrid API key or KEK into chat, commands, plans, summaries, or logs.

</hard_constraints>

<tasks>

<task type="auto">
  <name>Task 1: Implement and fail-close the file-backed envelope provider</name>
  <files>packages/kms/src/env.ts, packages/kms/src/client.ts, packages/kms/src/file-provider.ts, packages/kms/src/index.ts, packages/kms/src/__tests__/file-provider.test.ts, packages/kms/src/__tests__/envelope.test.ts, apps/api/src/env.ts, apps/api/src/server.ts, apps/api/src/__tests__/env-schema.test.ts, apps/worker/src/server.ts, scripts/check-env.mjs</files>
  <action>
Add `file` as an explicit third provider; parse provider names strictly and require `KMS_FILE_KEK_PATH` for it. Keep `local` production-forbidden and AWS behavior available for compatibility, but make no AWS credential a production prerequisite when `file` is selected.

Implement `file-provider.ts` behind the existing `generateDataKey`/`decryptDataKey` interface. Load exactly one base64-encoded 32-byte KEK from the configured path, validate file type/ownership/group/mode before use, wrap a fresh 32-byte DEK with AES-256-GCM, and bind the wrap to `workspaceId` as AAD. Use a versioned packed representation for newly wrapped file-provider DEKs so malformed/truncated blobs are rejected legibly and a foreign/AWS blob is never misinterpreted as file ciphertext. Zero the temporary KEK buffer in `finally` after every operation; retain the existing client-level DEK zeroing.

Export an `assertKmsReady()` preflight that selects and validates the configured provider without encrypting a tenant secret. Invoke it during both API and worker startup before either process is considered ready. Do not weaken readiness when the key becomes unreadable; boot must fail with a metadata-only error.

Extend tests with provider selection, production acceptance for `file`, production rejection for `local`, missing-path and unknown-provider rejection, exact file-policy checks, round-trip/non-determinism, cross-workspace refusal, malformed/version/tamper rejection, and buffer-zeroing assertions using mocks or injectable pure validation inputs where CI cannot create a root-owned file. Preserve the existing local-provider suite.
  </action>
  <verify>
    <automated>npm test -w packages/kms &amp;&amp; npm run build -w packages/kms &amp;&amp; npm test -w apps/api -- --run src/__tests__/env-schema.test.ts src/kms/__tests__/envelope.test.ts &amp;&amp; npm run build -w apps/api &amp;&amp; npm run build -w apps/worker</automated>
  </verify>
  <done>`KMS_PROVIDER=file` is a production-valid, workspace-bound envelope provider; unsafe configuration fails before API/worker readiness; local/AWS behavior does not regress; no key bytes escape into errors or logs.</done>
</task>

<task type="auto">
  <name>Task 2: Isolate the mount, gate deployment, and document the security boundary</name>
  <files>docker/docker-compose.prod.yml, docker/prod.env.example, scripts/validate-kek-file.mjs, scripts/__tests__/validate-kek-file.test.mjs, scripts/validate-prod-compose.mjs, scripts/__tests__/validate-prod-compose.test.mjs, scripts/deploy.sh, scripts/__tests__/deploy-script.test.mjs, docs/runbooks/production-topology.md, docs/runbooks/deploy-and-rollback.md, docs/runbooks/uat-live-sendgrid.md</files>
  <action>
Configure production for `KMS_PROVIDER=file` and `KMS_FILE_KEK_PATH=/run/secrets/mega-crm-kek`. Add a read-only bind of `/etc/mega-crm/kek` and supplemental group 1999 to exactly `api` and `worker`; add neither to `migrate` nor any other service. Update the compose validator and negative fixtures/tests so missing mount, writable mount, wrong target, missing/wrong group, or leakage to another service is a CI violation.

Add a non-leaking host validator for regular-file/no-symlink, uid 0, gid 1999, mode 0440, strict base64 and decoded 32-byte length. Make `deploy.sh` call it after required-env validation but before pull, migrate, or any container replacement; cover ordering and failure with deploy-script tests. Its dry-run must show the preflight without reading or creating a secret.

Document one-time VPS setup with a dedicated numeric group 1999 and secret generation whose value never enters shell history or the repository; document backup/escrow expectations, the prohibition on in-place rotation, loss recovery, rollback implications, and the exact threat boundary (DB-only compromise protected; full VPS/root or API/worker compromise not protected). Add a pre-cutover query/count for `workspace_sendgrid_keys`; zero rows permits the switch, nonzero rows stop the procedure because AWS ciphertext cannot be recovered without AWS and must be re-enrolled or migrated under separately approved handling.
  </action>
  <verify>
    <automated>npm run verify:prod-compose &amp;&amp; npx vitest run --root scripts __tests__/validate-prod-compose.test.mjs __tests__/validate-kek-file.test.mjs __tests__/deploy-script.test.mjs &amp;&amp; docker compose -f docker/docker-compose.prod.yml --env-file docker/prod.env.example config &gt;/dev/null</automated>
  </verify>
  <done>Repository gates prove the root-owned KEK can reach only API/worker, an unsafe host file aborts deployment before mutation, and the runbooks state provisioning, cutover, non-rotation, recovery, and residual VPS-compromise risk without exposing a secret.</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 3: Provision, deploy, prove the fixed key path, and resume Phase 16 UAT</name>
  <files>docs/runbooks/deploy-and-rollback.md, docs/runbooks/uat-live-sendgrid.md, .planning/quick/260818-aqd-add-a-production-safe-file-backed-kek-pr/260818-aqd-SUMMARY.md</files>
  <action>
After code review/CI and image publication, ask the operator to approve production action. On the VPS, first execute the documented row-count preflight. If any tenant key row exists, stop without changing providers and record the required re-enrollment/rewrap decision. If zero, create the dedicated group and root-owned KEK file through the documented non-echoing procedure, validate it, set the non-secret provider/path values in `/etc/mega-crm/production.env`, remove/leave unset AWS credential variables, and deploy the immutable SHA with the existing deploy script.

Confirm API and worker are healthy and their logs contain neither key material nor AWS credential errors. Through the existing product UI/API, have the operator enter the Mail-Send-only UAT SendGrid key without sharing it in chat. Verify connect/save/recheck succeeds (no HTTP 500), the database stores ciphertext plus wrapped DEK rather than plaintext, and a worker-driven test/campaign send successfully decrypts the same key. Then continue `docs/runbooks/uat-live-sendgrid.md` from the Phase 16 prerequisite/procedure and capture only non-secret command verdicts, timestamps, row counts, send IDs/event coverage, and health evidence in the SUMMARY.

If deployment fails after API replacement but before worker health, use the documented rollback decision; keep the KEK file intact because old/new file-provider ciphertext depends on it. Never solve a failure by regenerating the file.
  </action>
  <verify>
    <manual>
      - Host validator exits 0 for `/etc/mega-crm/kek`; `stat` confirms uid 0, gid 1999, mode 0440, without printing contents.
      - Resolved compose inspection shows `/run/secrets/mega-crm-kek:ro` and group 1999 on api/worker only; `migrate`, db, redis, web, pgbackrest, and alloy have neither.
      - `docker compose ... ps` reports api and worker healthy after the immutable-SHA deploy; logs have no AWS credential error and no secret value.
      - Saving/rechecking the dedicated tenant SendGrid key returns success instead of the original 500; its database row contains only encrypted fields/key mask.
      - A worker-processed UAT send reaches the operator-controlled inbox and Phase 16's existing `uat-verify.mjs` check exits 0 for the applicable UAT checkpoint.
    </manual>
  </verify>
  <done>The DigitalOcean production deployment runs without AWS, the real API/worker encrypt/decrypt path is proven, the Internal Server Error is closed, and Phase 16 live SendGrid UAT can proceed with non-secret evidence recorded.</done>
</task>

</tasks>

<verification>
Before the production checkpoint, run the focused KMS, API env, build, compose, host-validator, and deploy-order suites from Tasks 1-2. Inspect the final diff for accidental secret literals and confirm only documentation placeholders/test-generated keys exist. At the checkpoint, retain the exact immutable SHA and non-secret health/UAT evidence; never retain KEK or SendGrid API key bytes.
</verification>

<success_criteria>
1. A clean production boot on DigitalOcean needs no AWS account or AWS credential.
2. API and worker alone can read a strictly protected file KEK while remaining non-root.
3. Envelope encryption stays authenticated, tenant-bound, nondeterministic, and tamper-evident.
4. Unsafe key files, provider typos, mount drift, and incompatible existing ciphertext fail closed.
5. A real tenant SendGrid key saves and decrypts without HTTP 500, and Phase 16 UAT resumes against an operator-controlled inbox.
6. Documentation accurately limits the guarantee to database-only compromise and names full-VPS compromise as residual risk.
</success_criteria>

<output>
After completion, create `.planning/quick/260818-aqd-add-a-production-safe-file-backed-kek-pr/260818-aqd-SUMMARY.md` with implementation/test/deploy evidence, the deployed immutable SHA, the pre-cutover row count, the UAT verdict, and the residual-risk statement. Include no KEK, SendGrid API key, AWS credential, or ciphertext capable of being replayed.
</output>
