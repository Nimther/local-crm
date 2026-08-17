---
phase: 15-observability-alerting-frontend-resilience
reviewed: 2026-08-17T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - scripts/validate-alloy-config.mjs
  - scripts/__tests__/validate-alloy-config.test.mjs
  - scripts/__fixtures__/alloy-config/hash-comment-header.alloy
  - scripts/__fixtures__/alloy-config/hash-trailing-comment.alloy
  - scripts/__fixtures__/alloy-config/valid-with-slash-comments.alloy
  - docker/alloy/config.alloy
  - .github/workflows/ci.yml
  - docs/runbooks/log-shipping-and-backstop-alerts.md
findings:
  critical: 0
  warning: 4
  info: 2
  total: 6
status: issues_found
---

# Phase 15: Code Review Report (gap closure 15-22, G-15-4 — Alloy config syntax gate)

**Reviewed:** 2026-08-17
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Scope is narrowly the gaps-only wave that added `scripts/validate-alloy-config.mjs`
(the static + real-binary Alloy config syntax gate), its tests/fixtures, the
`#` → `//` comment conversion in `docker/alloy/config.alloy`, the new
`static` CI step, and the corresponding runbook update. This REVIEW.md
supersedes the earlier phase-wide REVIEW.md at this path for this wave only
— it does not re-cover the prior waves' findings.

The core defect this gap closure targets (`docker/alloy/config.alloy`
shipping `#` comments that Alloy's lexer rejects, restart-looping the
production sidecar) is genuinely fixed: the committed file now uses only
`//`/`/* */`, a regression-lock test asserts this against the real file, and
CI's `static` job runs `alloy fmt` against the real pinned `grafana/alloy`
image with `ALLOY_VALIDATE_REQUIRE_BINARY=1` (verified: the script is wired
into `package.json` and the CI step correctly sets the env var per the
wiring-lock test). No command-injection, secret-exposure, or fail-open
defect was found in the orchestration — `runValidation`'s fail-closed logic
holds in every case actually exercisable in CI, and `execFileSync` is always
called with an argument array (never a shell string), so `imageRef` — parsed
from a committed YAML file — cannot be used for command injection.

The findings below are all in the static scanner's own scope boundary and
in test/documentation robustness — none of them allow the specific defect
this gate exists to catch (`#` shipping to production) to go undetected,
because CI's `ALLOY_VALIDATE_REQUIRE_BINARY=1` real-binary layer backstops
every gap found in the hand-rolled scanner. That backstop is exactly why
none of these are Critical.

## Warnings

### WR-01: Static scanner has no raw-string (backtick) awareness — proven false positive AND false negative

**File:** `scripts/validate-alloy-config.mjs:85-148` (state machine has only
`code` / `string` / `lineComment` / `blockComment` — no backtick-delimited
raw-string state)

**Issue:** Alloy's config language (River) supports backtick-delimited raw
strings in addition to double-quoted strings — commonly used for
`regex = \`...\`` to avoid backslash-escaping regex metacharacters.
`scanIllegalCommentTokens` only tracks double-quoted strings; a backtick is
just another CODE-position character to it. This was empirically verified
against the real pinned image, not asserted from memory:

```
$ cat backtick-test.alloy
  regex = `a#b`
$ docker run --rm --network none -v "$PWD/backtick-test.alloy:/etc/alloy/config.alloy:ro" \
    grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy
(reformats cleanly, exit 0 -- Alloy accepts this)

$ node -e '... scanIllegalCommentTokens("regex = `a#b`\n") ...'
[{"rule":"illegal-comment-token","line":1,"column":11,"lineText":"regex = `a#b`"}]
```

This is a **false positive**: a syntactically legal Alloy config using a
backtick raw string containing `#` would be rejected by this gate even
though the real binary accepts it — exactly the failure mode the file's own
header comment (lines 70-73) warns about ("a blind character search would
false-positive on both and make this gate unusable, which is how gates get
deleted").

It also produces a **false negative** in the opposite direction, also
empirically confirmed: a backtick string containing an unescaped `"`
desyncs the scanner into `string` state permanently (the scanner has no
concept of "inside a raw string," so it reads the `"` as a double-quoted
string *opener*, never later closed by a matching `"`), silently swallowing
a genuinely illegal `#` later in the file:

```
$ node -e '... scanIllegalCommentTokens("regex = `a\"b`\nreal_code # illegal\n") ...'
[]   // no violation reported -- the real `#` on line 2 is illegal Alloy but unreported
```

Neither direction is Critical only because CI's real-binary layer
(`ALLOY_VALIDATE_REQUIRE_BINARY: "1"` in `.github/workflows/ci.yml`) is the
authoritative parser and backstops both: a false positive still fails loud
(blocks a legal config, an availability/DX problem, not a correctness gap);
a false negative in the static scan is still caught because `alloy fmt`
itself would reject genuinely invalid syntax regardless of what the scanner
missed. But the static scanner's own doc comments claim to be
"comment-aware, string-aware" without qualifying that raw/backtick strings
are out of scope, and the committed config does not currently use backtick
strings only by chance, not by any enforced rule.

**Fix:** Add a fifth lexical state for backtick-delimited raw strings
(River raw strings have no escape sequences — the string ends at the very
next backtick, unconditionally):
```js
/** @type {"code" | "string" | "rawString" | "lineComment" | "blockComment"} */
let state = "code";
...
if (state === "code") {
  if (ch === '"') { state = "string"; escapeNext = false; }
  else if (ch === "`") { state = "rawString"; }
  else if (ch === "/" && next === "/") { ... }
  ...
} else if (state === "rawString") {
  if (ch === "`") state = "code";
  // no escape handling -- River raw strings have none
}
```
Add fixtures covering both directions above and update the header comment
to note raw-string awareness explicitly.

---

### WR-02: `requireBinary` fail-closed guarantee has an untested, effectively-dead branch when Docker is available but image resolution fails

**File:** `scripts/validate-alloy-config.mjs:258-311` (specifically the
final two `else if` branches at lines 305-309)

**Issue:** The branch order in `runValidation` is:
```js
if (dockerIsAvailable && imageRef !== undefined) { ...run... }
else if (!dockerIsAvailable && requireBinary) { ...violation (fail-closed)... }
else if (!dockerIsAvailable) { ...skipReason... }
else if (dockerIsAvailable && imageRef === undefined) { ...skipReason... }  // <-- no requireBinary check here
```
When Docker is reachable but `resolveAlloyImageRef` fails (e.g., the
`alloy` service is renamed/removed from `docker-compose.prod.yml`, or a
future change to `validate-prod-compose.mjs`'s YAML-fallback parser stops
matching the `image:` field), the code takes the last branch and sets a
`skipReason` — it never checks `requireBinary` here, unlike the symmetric
`!dockerIsAvailable && requireBinary` branch above. The doc comment on
`defaultRequireBinary` (line 236) frames `requireBinary` as "required
(fail-closed) rather than merely attempted," but this specific combination
of conditions doesn't independently enforce that.

In practice this is currently masked (not exploitable): `resolveAlloyImageRef`
always throws `AlloyImageResolutionError` before `imageRef` can end up
`undefined` in a way that isn't itself already recorded as an
`alloy-image-unresolvable` violation earlier in `runValidation` (line
274-282), so the overall violations array is non-empty and the CLI still
exits non-zero. This is a contract/dead-branch inconsistency, not a live
fail-open bug — but it is untested (no test exercises "docker reachable +
image unresolvable + requireBinary true/false"), and the masking depends on
`resolveAlloyImageRef` always throwing rather than ever returning an
empty/falsy value, which is a coupling the code doesn't defend explicitly.

**Fix:** Make the fail-closed check explicit and symmetric, and add the
missing test:
```js
} else if (dockerIsAvailable && imageRef === undefined) {
  if (requireBinary) {
    violations.push({
      rule: "alloy-binary-check-unavailable",
      detail: "The alloy image reference could not be resolved and ALLOY_VALIDATE_REQUIRE_BINARY is set -- the real-binary layer is required but could not run",
    });
  } else {
    skipReason = "the alloy image reference could not be resolved -- the real-binary layer was skipped";
  }
}
```

---

### WR-03: `AlloyImageResolutionError`'s actual throw sites are never exercised by any test

**File:** `scripts/validate-alloy-config.mjs:172-185` (the two `throw new
AlloyImageResolutionError(...)` call sites);
`scripts/__tests__/validate-alloy-config.test.mjs:83-88`

**Issue:** The test titled "throws a named error when the compose file
declares no alloy service or no image for it" points `resolveAlloyImageRef`
at `scripts/__fixtures__/alloy-config` as `baseDir`. That directory has no
`docker/docker-compose.prod.yml` or `docker/prod.env.example` at all, so
`readFileSync` throws a plain Node `ENOENT` error *before* the function ever
reaches the "no alloy service" / "no image" checks that construct
`AlloyImageResolutionError`. The assertion is a bare `.toThrow()` (no
argument), which passes for any thrown error — so this test proves nothing
about the two lines it claims to cover, and `AlloyImageResolutionError` is
never imported, never checked via `instanceof`/`.name`, anywhere in this
test file. A regression that broke the "no alloy service" or "no image"
detection logic (e.g., wrong optional-chaining, wrong property name) would
not be caught by this test suite.

**Fix:** Add a real fixture compose file that parses successfully but omits
the `alloy` service (or omits its `image:` field), and assert the specific
error class:
```js
it("throws AlloyImageResolutionError when the compose file declares no alloy service", () => {
  const baseDir = path.join(FIXTURES_DIR, "no-alloy-service");
  expect(() => resolveAlloyImageRef(baseDir)).toThrow(AlloyImageResolutionError);
});
```
(requires a minimal `docker/docker-compose.prod.yml` + `docker/prod.env.example`
under that fixture subdirectory, and importing `AlloyImageResolutionError`
from the module under test.)

---

### WR-04: Runbook hardcodes the pinned Alloy image tag in a manual recovery command, contradicting the doc's own "restate nothing, link instead" rule

**File:** `docs/runbooks/log-shipping-and-backstop-alerts.md:156-159`

**Issue:** The recovery procedure for "No-logs-received fired" tells the
operator to run:
```bash
docker run --rm --network none \
  -v "$PWD/docker/alloy/config.alloy:/etc/alloy/config.alloy:ro" \
  grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy
```
hardcoding `grafana/alloy:v1.18.1` literally. This is currently correct
(matches `docker/docker-compose.prod.yml`'s pinned tag), but the same file
states elsewhere (§"How to tune the thresholds", line ~241-242) an explicit
repository convention: "this runbook does not duplicate the values, only
the recovery procedure ... per this repository's own 'restate nothing, link
instead' convention." This one command breaks that same convention it
otherwise follows. `scripts/validate-alloy-config.mjs` itself was
deliberately built to *never* hardcode this image reference for exactly
this staleness reason (its own header, lines 20-25: "resolved at run time
... never hardcoded here, so this gate can never validate against a stale
or different image than the one production actually runs"). If the pinned
tag is ever bumped in `docker-compose.prod.yml` without this runbook being
updated in lockstep, an operator running this exact command during a real
incident would validate against the wrong image version — and because this
is specifically the incident-recovery path for a production outage, a false
"config parses fine" (or a false failure against a tag that isn't what's
actually deployed) is a worse outcome here than generic doc drift elsewhere.

**Fix:** Point at the source of truth instead of a literal value, e.g.:
```bash
IMAGE=$(docker compose -f docker/docker-compose.prod.yml config --format json | jq -r '.services.alloy.image')
docker run --rm --network none \
  -v "$PWD/docker/alloy/config.alloy:/etc/alloy/config.alloy:ro" \
  "$IMAGE" fmt /etc/alloy/config.alloy
```
or simply: "run `npm run verify:alloy-config` (it resolves the correct
pinned image automatically)" — which the same paragraph already references
two sentences later as the pre-deploy gate.

## Info

### IN-01: `execFileSync` timeout in `runAlloyFmt` is reported as a parse failure, not distinguished from a timeout

**File:** `scripts/validate-alloy-config.mjs:217-234`

**Issue:** The 5-minute timeout exists (per the comment on lines 224-225)
specifically so "a cold CI runner pulling the pinned vendor image for the
first time must not be mistaken for a parse failure." But when
`execFileSync` actually times out, the thrown error has `err.killed: true`
and `err.signal` set, with `err.status` typically `null`. The catch block
maps this the same way it maps a real parse failure:
```js
return { exitCode: typeof err?.status === "number" ? err.status : 1, stderr };
```
`runValidation` then reports `rule: "alloy-binary-parse-failed"`, which
reads to an operator/CI log as "the config is syntactically invalid" —
exactly the misdiagnosis the timeout comment says it's trying to avoid.
This fails safe (CI goes red either way, never silently green), so it's
Info rather than a correctness bug, but it will send whoever investigates a
red CI run down the wrong path (checking the config for typos rather than
checking image-pull/network health).

**Fix:** Distinguish the timeout case in the catch block and surface a
distinct rule:
```js
} catch (err) {
  if (err?.killed || err?.signal) {
    return { exitCode: 1, stderr: `alloy fmt timed out or was killed (signal: ${err.signal ?? "unknown"}) -- likely a slow/cold image pull, not a config syntax error` };
  }
  ...
}
```

### IN-02: Container-path drift test only checks substring presence, not that it appears as the mount target and command argument specifically

**File:** `scripts/__tests__/validate-alloy-config.test.mjs:179-183`

**Issue:** The test "docker-compose.prod.yml's raw text contains
CONTAINER_CONFIG_PATH" only asserts `composeText.toContain(CONTAINER_CONFIG_PATH)`.
This is currently true because `/etc/alloy/config.alloy` appears both as the
volume bind-mount target (`./alloy/config.alloy:/etc/alloy/config.alloy:ro`)
and inside the `command:` array in the real file — verified by direct
inspection of `docker/docker-compose.prod.yml`'s `alloy:` service block.
But the assertion itself would also pass if the string appeared once,
anywhere in the file, for an unrelated reason (e.g., a stray comment), so it
doesn't fully deliver on the doc comment's claim (source lines 55-59) that
this is "asserted by a dedicated test so the two paths cannot silently
drift apart" — it proves presence, not that the mount target and the
`command:` argument are specifically the constant in question.

**Fix:** Tighten the assertion to match the specific volume line and the
specific command-array element, e.g. with two targeted regexes
(`/\.\/alloy\/config\.alloy:\/etc\/alloy\/config\.alloy:ro/` for the mount,
and a check that the `command:` array's string literal equals
`CONTAINER_CONFIG_PATH`) rather than one generic substring check.

---

_Reviewed: 2026-08-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
