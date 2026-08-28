---
status: resolved
trigger: "uuid-redacted-as-phone"
created: 2026-08-27
updated: 2026-08-27
---

## Current Focus

hypothesis: CONFIRMED and FIXED (see Resolution.root_cause / Resolution.fix). The phone valueRule's boundary anchors admit only a match that starts at index 0 and ends at end-of-value, which requires every character of the UUID to be a digit or `-`. So the anchors protected exactly those UUIDs containing at least one hex LETTER, and all-decimal canonical UUIDs were matched in full.
test: GREEN phase complete. Tests 8/9/10 now pass against the patched pattern; Tests 1-7 and 11 unchanged; all three mutation checks confirmed to bite.
expecting: Nothing further to test autonomously. All applicable fix-acceptance signals recorded under Resolution.verification are green.
next_action: NONE — session resolved and archived. Human verification collected 2026-08-28 (see `human_verification` below); the three changed files, the knowledge-base entry and this file were committed on branch `fix/uuid-redacted-as-phone`.

human_verification:
  collected_at: 2026-08-28
  method: "AskUserQuestion, asked by the /gsd-debug orchestrator (the session manager has no AskUserQuestion tool, so it returned CONTINUE_REQUIRED rather than synthesise a confirmation)"
  answer: "Confirmed fixed"
  orchestrator_independent_recheck: "35/35 tests across 5 files in packages/redaction pass; a live scrub() run returns both 17240210-0546-4077-9954-207876832048 and the nil UUID unchanged while phone/card values are still [REDACTED]."
  session_manager_independent_recheck: |
    Run independently of the debugger's own suite, before confirmation was collected:
      - RED verified pre-fix: Tests 8/9/10 failing with rules.ts untouched (working tree carried only the test file).
      - GREEN verified post-fix: 5 files / 35 tests pass, `tsc --noEmit` exit 0.
      - Independent probe (not the debugger's fixtures): 8/8 phone/card forms still match, including the 33-digit
        near-UUID `12345678-1234-1234-1234-1234567890123` that pins the inner lookahead; 9/9 UUID forms now survive —
        bare, nil, the repdigit fixtures this repo uses, parenthesised, `+`-prefixed, embedded in prose, and `key=value`.
      - Independent 300,000-value sweep of freshly generated all-decimal canonical UUIDs: old pattern matched 300,000
        (100%), new pattern matched 0. Confirms the CLASS is closed, not just the reported literal.

bug_class: Bohrbug — fully deterministic given the input value. Not a Heisenbug: it presented as "never observed" only because the triggering input class has density 3.76e-7 under random UUID generation, not because of any timing or observation effect. SBFL was not run (single-package pure-function defect, exact failing input already known — spectrum ranking would add nothing over the direct reproduction).

reasoning_checkpoint:
  hypothesis: "packages/redaction/src/rules.ts:145's phone pattern `/(?<![0-9A-Za-z-])\\+?\\(?\\d(?:[\\s().-]*\\d){9,}(?![0-9A-Za-z-])/` matches a canonical UUID in full whenever all 32 of its hex characters are digits, because `-` is a member of its own separator class `[\\s().-]` and its boundary anchors permit exactly one start position (index 0) and exactly one end position (end of value) inside such a token."
  confirming_evidence:
    - "Direct execution: the pattern returns a match of the entire 36-char value at index 0 for `17240210-0546-4077-9954-207876832048`, and no match for the same string with one trailing hex letter (`...20787683204f`)."
    - "Direct execution: the nil UUID `00000000-0000-0000-0000-000000000000` also matches in full — a deterministic, non-random instance of the same class."
    - "200,000/200,000 generated all-decimal canonical v4 UUIDs match the current pattern; 0/3,000,000 `randomUUID()` values match, consistent with the closed-form density 0.625^30 x 0.5 = 3.76e-7."
    - "The written RED tests 8/9/10 fail against unmodified source with `[REDACTED]` in place of the UUID; tests 1-7 and 11 pass."
  falsification_test: "If the defect were not the pattern's separator/anchor interaction, then either (a) an all-decimal UUID would survive `scrub()` today, or (b) a UUID containing a hex letter would be redacted. Both were tested; both came out the other way. A further falsifier: if the mechanism were anything other than 'whole value is digits-and-hyphens', appending a single hex letter would not change the outcome — it does."
  fix_rationale: "The root cause is that the pattern's exclusion criterion is 'token contains a non-digit hex character', when the criterion it needs is 'token is UUID-shaped'. Adding a UUID-shape negative lookahead at the match start replaces the incidental criterion with the intended one, closing the whole residual class (including the nil UUID) rather than the one reported literal. It is a root-cause fix, not a symptom fix: it targets the criterion, and the class sweep in Test 10 proves the class is closed rather than that the example is handled."
  blind_spots: "(1) Non-canonical identifier shapes remain matched and are deliberately out of scope — see the Eliminated entries for unhyphenated 32-digit ids, IPv4, epoch-ms and `YYYY-MM-DD hh`; those share a different cause (a bare 10+ digit run is genuinely indistinguishable from a card number) and narrowing them would cost real PII coverage. (2) The lookahead is anchored on the canonical 8-4-4-4-12 form only, so a UUID written in braced (`{...}`) or URN (`urn:uuid:`) form is only protected insofar as its inner canonical form is; braced form was not probed. (3) Verification is scoped to packages/redaction as instructed, so no cross-package assertion that no other consumer depends on all-decimal ids being redacted (grep shows scrub.ts is the only code consumer, so this risk is low)."
  candidate_causes:
    - "code: the phone valueRule's separator class includes `-`, so a UUID's hex groups chain into one digit run, and its boundary anchors exclude only hex-LETTERED tokens rather than UUID-SHAPED ones (CONFIRMED — this is the fix target)"
    - "data: the specific value's 32 hex characters all happen to be digits, at density 3.76e-7 for random v4 and 100% for the nil UUID (CONFIRMED as the necessary co-condition, but uncontrollable — not a fix target)"
    - "config/environment: ELIMINATED — the pattern is a module-level literal with no env or config input, and the reproduction is identical under `node -e` with no project config loaded"
  and_gate: "YES — two conditions must hold simultaneously: the permissive code criterion AND an all-decimal input. Removing either makes the failure vanish (verified both ways: a hex-lettered UUID does not match the current pattern; an all-decimal UUID does not match the proposed pattern). Because the data leg is uncontrollable randomness — and is 100% certain for the nil UUID — the fix targets the code leg alone."

green_phase_plan:
  file: packages/redaction/src/rules.ts (the `phone` valueRule, currently line 145)
  pattern: |
    /(?<![0-9A-Za-z-])\+?\(?(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-]))\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/
  pattern_invariants_already_verified_empirically:
    - "PLACEMENT: the UUID-shape lookahead must sit AFTER the optional `\\+?\\(?` prefix, not before it. Placed before, `(uuid)` and `+uuid` are still redacted — the match just starts one character earlier, on the `(` or `+`, where the shape lookahead never fires. Verified: `before` placement fails 2 of 23 probes, `after` placement passes 23 of 23. Test 9 is the assertion that pins this."
    - "INNER LOOKAHEAD: the trailing `(?![0-9A-Za-z-])` INSIDE the shape lookahead is load-bearing. Without it, `12345678-1234-1234-1234-1234567890123` (13-digit final group — a 33-digit run, not a UUID) stops matching, a coverage regression. Verified: withInner=true, noInner=false. Test 11 is the assertion that pins this."
    - "HEX vs DIGITS in the lookahead: `[0-9a-fA-F]` and `[0-9]` are provably equivalent here (a hex-lettered UUID cannot match the outer pattern at all, so excluding it changes nothing). Full-hex is preferred because it documents the intent as 'this token is UUID-shaped'. Say that equivalence in the comment so a later reader does not 'simplify' it and lose the intent."
  doc_corrections:
    - "packages/redaction/src/rules.ts — the `phone` rule's comment block (~lines 110-145) asserts the false positive is fixed 'BY CONSTRUCTION' and that 'no legal start position exists anywhere in it'. That is true only for hex-LETTERED UUIDs. Rewrite to: the anchors exclude hex-lettered UUIDs; the shape lookahead excludes the all-decimal residue, nil UUID included. Keep the existing rationale for the open-ended `{9,}` upper bound — it is still correct and still load-bearing."
    - "SPECIFICATION.md:1705 — makes the same 'исключён по построению' claim in Russian. Correct it in the same change, adding the all-decimal residue, the 3.76e-7 density, and the new pattern. Per project CLAUDE.md, SPECIFICATION.md is the as-built doc and must not keep asserting a guarantee the code did not provide."
    - "packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts — already corrected during the RED phase (file header + Test 7 title + the new comment block above Test 8). No further edit needed there."
  verify:
    - "cd packages/redaction && npx vitest run --reporter=verbose src/__tests__/scrub-identifier-false-positive.test.ts  # expect 11/11 pass"
    - "cd packages/redaction && npx vitest run  # expect 5 files / 35 tests pass (baseline at HEAD was 5 files / 31 tests)"
    - "cd packages/redaction && npx tsc --noEmit -p tsconfig.json  # expect exit 0"
    - "MUTATION CHECK (fix-acceptance signal): revert only the rules.ts pattern and confirm Tests 8/9/10 fail again — the bug must return when the fix is removed."
    - "MUTATION CHECK (over-correction): temporarily move the shape lookahead BEFORE `\\+?\\(?` and confirm Test 9 fails; temporarily drop the inner `(?![0-9A-Za-z-])` and confirm Test 11 fails. Both prove the new assertions bite rather than pass vacuously."
    - "Do NOT attribute to this fix: sentry.test.ts 'no DSN' failures (deterministic on this machine, real DSNs in ~/.config/mega-crm/.env) or advisory-lock / flow-run-advance / temp-redis flakes under full-suite load. Verification is scoped to packages/redaction."
  git_traps_at_archive_time:
    - "This session file is UNTRACKED and gitignored (`.gitignore:16` matches `.planning/`), so committing it needs `git add -f .planning/debug/resolved/uuid-redacted-as-phone.md` — `gsd_run query commit` no-ops on .planning paths and reports skipped_gitignored."
    - "`.planning/debug/knowledge-base.md` IS tracked despite the ignore rule, and a checkout or fast-forward can silently clobber an edited working copy. Grep-verify the new KB entry is present AFTER the last git operation, not before."
    - "Nothing is committed yet. Working tree currently carries exactly one modification: the RED test file."

tdd_checkpoint:
  test_file: "packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts"
  test_name: "Test 8 / Test 9 / Test 10 (all-decimal canonical UUID must survive the phone valueRule)"
  status: "green"
  green_result: "11/11 pass in the target file; 5 files / 35 tests pass across packages/redaction; tsc --noEmit exit 0. Tests 8/9/10 flipped red -> green with no change to Tests 1-7 or 11."
  red_failure_output_retained_below: true
  failure_output: |
    × Test 8: an all-decimal canonical UUID passes through untouched, under a key that matches no rule
      → expected 17240210-0546-4077-9954-207876832048 to survive scrub(): expected '[REDACTED]' to be '17240210-0546-4077-9954-207876832048'
    × Test 9: an all-decimal UUID survives every position a UUID actually appears in
      → expected '[REDACTED]' to be 'dropped 17240210-0546-4077-9954-207876832048 for a sibling workspace'
    × Test 10: the phone rule matches no all-decimal canonical UUID -- swept over the whole previously-vulnerable class
      → expected no phone match in 17240210-0546-4077-9954-207876832048: expected true to be false
    Test Files 1 failed | 4 passed (5) -- Tests 3 failed | 32 passed (35); tsc --noEmit exit 0
  red_confirmation:
    method: "empirical re-run by session-manager (no AskUserQuestion tool available; RED/GREEN is a factual check, not a judgment call, so it was verified rather than asked)"
    command: "npm -w @mega-crm/redaction run test -- src/__tests__/scrub-identifier-false-positive.test.ts"
    result: "Tests 3 failed | 8 passed (11) in the target file -- Tests 8/9/10 fail exactly as reported"
    working_tree_at_verification: "only packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts modified; rules.ts untouched -- so this is genuine pre-fix RED"
    verified_at: 2026-08-27
    note: "This is an automated verification, NOT user approval. No human confirmation has been collected in this session."

## Symptoms

DATA_START
expected: scrub({ id: "17240210-0546-4077-9954-207876832048" }) returns the UUID unchanged — UUIDs (workspace_id/contact_id/send_id) must never be redacted as phone numbers.
actual: scrub({ id: "17240210-0546-4077-9954-207876832048" }) returns { id: "[REDACTED]" }. The UUID consists entirely of digits and hyphens, so the phone pattern matches the entire value despite its boundary anchors: the match starts at the beginning of the value, ends at its end, and every internal hyphen is accepted as a phone separator ([\s().-]*).
errors: No error output — observed as a failing assertion in packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts, Test 3.
timeline: Still happening now, after the anchored-pattern fix in rules.ts:145 whose comment claims UUID collision is impossible "by construction". The anchors only protect UUIDs that contain at least one hex letter; all-decimal UUIDs (every hex char a digit) remain vulnerable.
reproduction: Deterministic. const uuid = "17240210-0546-4077-9954-207876832048"; scrub({ id: uuid }) → { id: "[REDACTED]" }. Affected path is the generic scrub() value walker (packages/redaction/src/scrub.ts) used for freeform values; not observed directly in Pino or Sentry production output.
user_requirements: Replace or supplement the probabilistic 5000-random-UUID assertion in the test suite with this deterministic regression fixture (UUID 17240210-0546-4077-9954-207876832048).
DATA_END

## Evidence

- timestamp: 2026-08-27T20:30Z
  checked: MemPalace unavailable; read `.planning/debug/knowledge-base.md` and grepped for phone/uuid/redact
  found: Direct predecessor entry `aggregate-coverage-run-fails` (Phase 10, commits ec7f5f6/c975a1f/3cd3f0c). It introduced the current anchored pattern and asserts the UUID false positive is "gone BY CONSTRUCTION, not made rarer". Its own recorded process lesson is the one that applies here: "a probabilistic bug 'fixed' against a single failing example has only had its rate lowered until it is verified against a sampled population."
  implication: Known-pattern candidate confirmed as the same defect class, one iteration on. The by-construction claim is the thing to falsify, and the fix must be verified by an EXHAUSTIVE/property test, not a larger sample — the previous round's sample-based guard is exactly what let this survive.

- timestamp: 2026-08-27T20:31Z
  checked: Ran the phone pattern `/(?<![0-9A-Za-z-])\+?\(?\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/` directly against the reported UUID and controls
  found: `17240210-0546-4077-9954-207876832048` MATCHES at index 0, consuming the entire 36-char value. `b2cd545e-...` (has hex letters) and `17240210-0546-4077-9954-20787683204f` (one trailing hex letter) do NOT match.
  implication: Deterministic reproduction confirmed. Symptom statement is accurate: the boundary anchors only protect UUIDs containing at least one hex LETTER.

- timestamp: 2026-08-27T20:31Z
  checked: Derived the necessary condition for a match anywhere inside a standalone canonical UUID
  found: The lookbehind `(?<![0-9A-Za-z-])` admits only index 0 inside a UUID (every other position is preceded by a hex char or `-`). The closing lookahead `(?![0-9A-Za-z-])` rejects every position followed by a digit, hex letter, or `-` — i.e. every internal position. So the match can only start at 0 and only end at the value's end, which requires EVERY character to be a digit or a `-`.
  implication: The vulnerable set is exactly the all-decimal canonical UUIDs (32 hex chars all digits). This is a precise, closed characterization — the fix can therefore be verified as a property, not sampled.

- timestamp: 2026-08-27T20:32Z
  checked: Measured the true false-positive rate of the CURRENT pattern against `randomUUID()`, 3,000,000 samples; compared to the closed form (0.625^30 x 0.5, since the version nibble is fixed `4` and the variant nibble is a digit in 2 of 4 cases)
  found: 0 hits in 3,000,000. Theoretical rate 3.76e-7 (~1 in 2.7 million).
  implication: Test 3's 5000-sample sweep has a ~0.19% chance of catching this defect — it is effectively vacuous against it. This is why the defect survived a guard that was written specifically for this rule. Confirms the user requirement to replace the probabilistic assertion with a deterministic fixture.

- timestamp: 2026-08-27T20:32Z
  checked: Probed adjacent value shapes against the current pattern
  found: Also redacted today: the NIL UUID `00000000-0000-0000-0000-000000000000` (a real sentinel value, all-decimal by definition — deterministic, not probabilistic), an unhyphenated all-decimal UUID, IPv4 `192.168.100.101`, `2026-08-27 12:34:56` (matches the `2026-08-27 12` prefix), and a 13-digit epoch-ms timestamp. NOT redacted: max UUID, ISO `2026-08-27T12:34:56`, `2026-08-27`, semver.
  implication: The nil UUID is a second, fully deterministic instance of the SAME root cause and belongs in the regression fixture. IPv4 / epoch-ms / space-separated-datetime are pre-existing false positives of a DIFFERENT cause (a bare 10+ digit run is genuinely ambiguous with a card number) — out of scope here, noted so the fix is not mistaken for addressing them.

- timestamp: 2026-08-27T20:32Z
  checked: Grepped every consumer of `REDACTION_RULES.valueRules`; ran the redaction suite at HEAD
  found: `packages/redaction/src/scrub.ts` is the only code consumer (`delivery-core/src/send-event-payload-allowlist.ts` and `apps/worker/src/queues/erasure-scrub.worker.ts` only mention it in comments; `pino-redact.ts` cannot apply value rules). Suite green at HEAD: 5 files, 31 tests. `SPECIFICATION.md:1705` records the incorrect "по построению" (by construction) claim.
  implication: Blast radius of a pattern change is limited to `scrub()`. SPECIFICATION.md:1705 must be corrected in the same change or the docs will keep asserting a guarantee the code does not provide.

- timestamp: 2026-08-27T20:36Z
  checked: Compared the two candidate placements of the UUID-shape negative lookahead across a 23-case discriminating probe set (all 10 of Test 5's phone formats, 10/16/19-digit runs, a card number, the 13-digit-tail near-UUID, 9 digits, a hex-lettered UUID, and the reported + nil UUIDs bare / embedded / parenthesised / `+`-prefixed)
  found: Lookahead placed BEFORE `\+?\(?` fails 2 of 23 — `(<uuid>)` and `+<uuid>` are still redacted, because the match simply begins one character earlier on the `(` or `+`, at a position where the shape lookahead never fires. Placed AFTER `\+?\(?` it passes 23 of 23.
  implication: Placement is load-bearing, not cosmetic, and the failure mode is silent (the fix would look correct and still redact UUIDs appearing in parentheses in log messages). Pinned by RED Test 9's parenthesised/`+`-prefixed cases.

- timestamp: 2026-08-27T20:36Z
  checked: Whether the trailing `(?![0-9A-Za-z-])` inside the shape lookahead is necessary, against `12345678-1234-1234-1234-1234567890123` (8-4-4-4-13, a 33-digit run that is NOT a canonical UUID)
  found: With the inner lookahead the value still matches (correct — long digit runs stay covered); without it the value stops matching.
  implication: Dropping the inner lookahead would silently narrow real card/long-digit-run coverage, i.e. trade a false positive for a false negative on PII. Pinned by RED Test 11.

- timestamp: 2026-08-27T20:37Z
  checked: 200,000 deterministically generated all-decimal canonical v4 UUIDs, plus 200,000 all-decimal any-version canonical UUIDs, against the proposed pattern; and the same population against the current pattern
  found: Current pattern 200,000/200,000 matched. Proposed pattern 0/200,000 and 0/200,000.
  implication: The proposed fix closes the entire previously-vulnerable class at 100% sampling density, not just the reported literal — the by-construction claim becomes true for the whole canonical form. This density is the reason Test 10 sweeps the class rather than the UUID space.

- timestamp: 2026-08-27T20:38Z
  checked: Wrote RED Tests 8-11 and ran the suite plus typecheck against unmodified source
  found: Exactly Tests 8, 9, 10 fail (each with `[REDACTED]` where the UUID belongs); Tests 1-7 pass unchanged; Test 11 (positive control) passes. 5 files / 35 tests, 3 failed. `tsc --noEmit` exit 0.
  implication: RED phase complete and clean — the new assertions fail for the intended reason and nothing pre-existing was disturbed. Test 11 passing today is intentional: it is the over-correction guard for the green phase, not a red test.

- timestamp: 2026-08-27T20:55Z
  checked: GREEN phase — applied the planned pattern to rules.ts and re-ran the scoped verification
  found: Target file 11/11 pass (Tests 8/9/10 flipped red -> green). Full package 5 files / 35 tests pass. `tsc --noEmit` exit 0. Working tree carries exactly three modified files (rules.ts, the test file, SPECIFICATION.md) and nothing else.
  implication: The fix works and disturbs nothing else in the package. Baseline at HEAD was 5 files / 31 tests; the +4 delta is exactly Tests 8-11.

- timestamp: 2026-08-27T20:56Z
  checked: Three mutation checks applied to rules.ts ITSELF (not to a standalone regex probe) and run through vitest, then the fixed pattern restored and re-verified byte-identical against a pre-mutation backup
  found: (1) revert-to-pre-fix-pattern → exactly Tests 8, 9, 10 fail — the bug returns when the fix is removed. (2) shape-lookahead moved BEFORE `\+?\(?` → exactly Test 9 fails. (3) inner `(?![0-9A-Za-z-])` dropped → exactly Test 11 fails. Final state: `cmp` confirms rules.ts identical to the fixed version, and a final full run is green (5 files / 35 tests, tsc exit 0).
  implication: All three signals bite rather than passing vacuously. Both silent-failure invariants are genuinely test-pinned, and the new assertions are causally tied to the fix rather than coincidentally green.

- timestamp: 2026-08-27T20:57Z
  checked: Blast radius of a strictly-narrowing pattern change outside packages/redaction — grepped for out-of-package consumers of `@mega-crm/redaction`, then for every all-decimal canonical UUID literal in apps/ packages/ scripts/
  found: The change only REMOVES matches (canonical-UUID-shaped tokens), so the sole breakage mode would be a test asserting an all-decimal UUID SHOULD be redacted. No such assertion exists. All-decimal UUID literals are widespread FIXTURES (`00000000-...`, `11111111-1111-...`, `11111111-2222-3333-4444-555555555555`, `66666666-7777-8888-9999-000000000000`), and the ops-watchdog tests that plant them (`queue-depth`, `webhook-lag`, `failed-send-share`) `void` the values and assert the rendered body contains NO uuid at all — an assertion about the renderer, independent of the redaction rule.
  implication: No cross-package regression is possible from this change. Separately, this grep is direct evidence the defect had real reach: the all-decimal sentinel/fixture ids this codebase uses constantly (`00000000-...` and `11111111-1111-...` both) were being redacted with certainty, not at 3.76e-7 — the density figure understates real-world exposure because real ids are not always random.

## Eliminated

- hypothesis: The defect lies in `scrub.ts`'s walker (key-rule matching, recursion, or the Error branch) rather than in the pattern itself
  evidence: The pattern reproduces the match standalone under `node -e` with no project code loaded at all — `/(?<![0-9A-Za-z-])\+?\(?\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/.exec("17240210-0546-4077-9954-207876832048")` returns the whole value at index 0. `scrub.ts` is behaving exactly as documented: it applies every valueRule to every string value regardless of key.
  timestamp: 2026-08-27T20:31Z

- hypothesis: Config or environment contributes (a rule table loaded from env, a per-environment pattern override, or a stale compiled artifact)
  evidence: `REDACTION_RULES` is a module-level literal with no env or config input; grep shows `scrub.ts` is the only code consumer of `valueRules` (`delivery-core/src/send-event-payload-allowlist.ts` and `apps/worker/src/queues/erasure-scrub.worker.ts` reference it in comments only, and `pino-redact.ts` structurally cannot apply value rules). Reproduction is byte-identical outside the project.
  timestamp: 2026-08-27T20:32Z

- hypothesis: Raising the digit floor, tightening the digit ceiling, or removing `-` from the separator class would fix it
  evidence: All three fail on the mechanism. The all-decimal UUID holds 32 digits, far above any plausible floor. A ceiling cannot help because with a start anchor the pattern can no longer slide its start forward — the predecessor session already opened `{9,14}` to `{9,}` for exactly this reason, and re-capping it would drop 16+ digit runs (card numbers). Dropping `-` from the separator class would stop matching `+1 415-555-0199`, `415-555-0199` and `tel:+1-415-555-0199`, i.e. most of Test 5.
  timestamp: 2026-08-27T20:35Z

- hypothesis: The remaining redaction of unhyphenated 32-digit ids, IPv4 addresses (`192.168.100.101`), 13-digit epoch-ms timestamps, and `YYYY-MM-DD hh` datetimes is part of this defect
  evidence: Deliberately OUT OF SCOPE, and a different cause. Each of those is a bare run of 10+ digits with no UUID structure to key on, which is genuinely indistinguishable from a card number by pattern alone — the phone/card rule catching them is the rule working as specified, and narrowing it would trade a cosmetic false positive for missed PII. Recorded here so the fix is not mistaken for addressing them. (Not redacted today and left that way: max UUID, ISO `2026-08-27T12:34:56`, `2026-08-27`, semver.)
  timestamp: 2026-08-27T20:32Z

## Resolution

root_cause: |
  packages/redaction/src/rules.ts:145 — the `phone` valueRule's exclusion criterion is the WRONG criterion. The pattern
  `/(?<![0-9A-Za-z-])\+?\(?\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/` includes `-` in its own separator class `[\s().-]`, so a
  canonical UUID's five hex groups chain into a single digit run; its boundary anchors then admit exactly one start position
  (index 0, the only position in a UUID not preceded by a hex character or `-`) and exactly one end position (end of value, the
  only position not followed by a digit, hex letter or `-`). A match therefore requires every character of the token to be a
  digit or a `-`, which means the anchors exclude a UUID only when it contains at least one hex LETTER — not because it is
  UUID-shaped. Any canonical UUID whose 32 hex characters are all digits is matched in full and replaced with `[REDACTED]`:
  the reported `17240210-0546-4077-9954-207876832048`, and the nil UUID `00000000-0000-0000-0000-000000000000` with certainty.

  AND-gate: the failure needs the permissive code criterion AND an all-decimal input; the data leg has density 3.76e-7 for
  random v4 (0.625^30 x 0.5 — version nibble fixed `4`, variant nibble a digit in 2 of 4 legal values, 30 free characters;
  measured 0/3,000,000) but is 100% for the nil UUID. Only the code leg is controllable, so it is the fix target.

  Contributing cause of the SURVIVAL (not of the failure): the guard written for this exact rule in the predecessor session,
  Test 3, samples 5000 random UUIDs — a ~0.19% chance of ever reaching this class. The predecessor's own recorded lesson
  applied one level up and was missed: a probabilistic guard calibrated against a 4%-density defect proves nothing about a
  3.76e-7-density one.

fix: |
  RED PHASE COMPLETE (this session, tdd_mode). Failing tests written and verified failing; no source changed yet.
  Added to packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts:
    - `ALL_DECIMAL_UUIDS` fixture pinning the reported literal `17240210-0546-4077-9954-207876832048` (per the stated user
      requirement) plus the nil UUID as its zero-randomness twin.
    - Test 8 — whole-value pass-through under a non-matching key. RED.
    - Test 9 — pass-through embedded in a freeform message, parenthesised, and `+`-prefixed (the last two discriminate the
      fix's lookahead PLACEMENT, which fails silently if wrong). RED.
    - Test 10 — pattern-level no-match, plus a deterministic (mulberry32, fixed seed) 2000-value sweep of the all-decimal
      canonical v4 class where the pre-fix pattern matched 200,000/200,000. Sweeps the vulnerable CLASS at 100% density
      instead of sampling the UUID space at 3.76e-7. RED.
    - Test 11 — positive control: 8-4-4-4-13 and 8-4-4-4-11 near-UUIDs, a card number, a 16-digit run and the unhyphenated
      32-digit form all stay redacted. Passes today; it is the over-correction guard for the green phase.
    - Test 3 KEPT and re-scoped in its title and a new docstring (it still catches a gross anchor-removal regression at ~4%;
      it is near-vacuous for this class). File header and Test 7 title corrected to say "hex-lettered".
  GREEN PHASE COMPLETE. Three files changed, nothing committed.

  1. packages/redaction/src/rules.ts — the `phone` valueRule's pattern is now
     `/(?<![0-9A-Za-z-])\+?\(?(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-]))\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/`.
     The added negative lookahead replaces the INCIDENTAL exclusion criterion ("the token contains a hex letter") with the
     INTENDED one ("the token is UUID-shaped"). Minimal: one lookahead inserted, nothing else about the rule touched — the
     digit floor, the separator class and the open-ended `{9,}` ceiling are all unchanged, so coverage stays a superset.
  2. packages/redaction/src/rules.ts comment block — the falsified "fixes it BY CONSTRUCTION ... no legal start position
     exists anywhere in it" paragraph is replaced by a third learned-from-failure bullet (UUID-SHAPE EXCLUSION) deriving
     what the anchors actually admit, plus a numbered block recording all three load-bearing lookahead properties. Item 3
     (full-hex vs digits) is flagged IN THE COMMENT as the one invariant no test can pin, because it is comment-content
     only and would otherwise be silently "simplified" away.
  3. SPECIFICATION.md — the Russian "исключён по построению" claim at the old line 1705 is retracted in place (the
     historical ~4% narrative is accurate and kept; only the guarantee was false), followed by three new paragraphs: the
     mechanism, the 3.76e-7 density with the nil-UUID 100% case, the new pattern with all three invariants, and an explicit
     list of what is STILL redacted by design (unhyphenated 32-digit form, IPv4, epoch-ms, `YYYY-MM-DD hh`) so the next
     reader does not mistake this fix for addressing them.

  Deliberately NOT done in this session: no commit, no archive, no knowledge-base entry. Those belong to archive_session
  and are gated on human confirmation, which has not been collected (the RED re-verification in `tdd_checkpoint` was an
  automated check, not user approval).

oracle_type: derived
oracle_note: |
  Not `implicit` (no crash was ever involved) and not `specified` (no external spec states this). It is DERIVED from a
  contract this codebase already holds elsewhere: SEC-09/WR-01's drop signal exists to carry workspace ids, so a
  workspace id MUST survive `scrub()`. The oracle is "a canonical UUID is not PII and must pass through unchanged",
  which is checkable for the whole class rather than for the reported example — which is why Test 10 sweeps the class.
  Boundary neighbours around the fixed equivalence class are asserted by Test 11 (8-4-4-4-13 and 8-4-4-4-11: the ±1
  off-by-one on the final group) and Test 6 (the 9/10/15/16/19-digit floor and ceiling neighbours).

verification: |
  GREEN gate, scoped to packages/redaction as instructed. Fix-acceptance guardrail, per signal:

  signal_1_regression_test_passes: PASS
    `npx vitest run --reporter=verbose src/__tests__/scrub-identifier-false-positive.test.ts` → 11/11 pass. Tests 8/9/10
    flipped red -> green; Tests 1-7 and 11 unchanged.

  signal_2_no_collateral_breakage: PASS
    `npx vitest run` (whole package) → 5 files / 35 tests pass. Baseline at HEAD was 5 files / 31 tests; the +4 delta is
    exactly Tests 8-11. `npx tsc --noEmit -p tsconfig.json` → exit 0. Cross-package reasoning recorded in the
    2026-08-27T20:57Z Evidence entry: the change only REMOVES matches, and no test anywhere asserts that an all-decimal
    UUID should be redacted (the ops-watchdog tests that plant such ids `void` them and assert about the renderer).

  signal_3_bug_returns_on_revert: PASS
    Reverted ONLY the rules.ts pattern to the pre-fix literal, ran vitest → exactly Tests 8, 9, 10 fail again. The fix is
    causally responsible for the green, not incidentally correlated with it.

  signal_4_over_correction_mutants_die: PASS
    Both silent-failure invariants were mutated in rules.ts itself and run through vitest:
      - shape lookahead moved BEFORE `\+?\(?` → exactly Test 9 fails (placement invariant is genuinely pinned).
      - inner `(?![0-9A-Za-z-])` dropped → exactly Test 11 fails (PII-coverage invariant is genuinely pinned).
    Neither new assertion passes vacuously. NOTE the known gap: invariant 3 (full-hex vs `[0-9]`) is behaviourally
    equivalent and therefore UNPINNABLE by any test; it is defended by the comment only, and that is stated in the comment.

  signal_5_fix_is_not_deletion_only: PASS
    The diff ADDS a constraint (one negative lookahead) and adds documentation; it removes no assertion, no test and no
    coverage. The rule's matched language is a strict subset of the previous one, differing exactly by canonical-UUID
    tokens — which is the defect class and nothing else.

  restoration_check: PASS
    After the last mutation, rules.ts was restored from a pre-mutation backup and `cmp` confirmed byte-identity; a final
    full run is green (5 files / 35 tests, tsc exit 0) and `git status` shows exactly the three intended modified files.

  guardrail_verdict: accepted

  Excluded as known local noise, per instruction, and NOT attributable to this fix: `sentry.test.ts` "no DSN" failures
  (deterministic on this machine — real DSNs in ~/.config/mega-crm/.env) and advisory-lock / flow-run-advance / temp-redis
  flakes under full-suite load. All of those live outside packages/redaction, so nothing in the scoped runs above touches
  them; every result reported here is a real signal, not filtered noise.

files_changed:
  - packages/redaction/src/rules.ts (the `phone` valueRule pattern — UUID-shape negative lookahead added after `\+?\(?`;
    plus the comment block rewritten: falsified "BY CONSTRUCTION" claim retracted, third failure round documented, all
    three load-bearing lookahead invariants recorded with the untestable one flagged as such)
  - packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts (RED tests 8-11, deterministic fixtures
    incl. the reported literal and the nil UUID, mulberry32 class-sweep generator, Test 3 re-scoped, falsified
    "by construction" claims corrected in this file's docs)
  - SPECIFICATION.md (the Russian "исключён по построению" claim retracted in place and replaced with the real mechanism,
    the density, the new pattern, its three invariants, and the explicit still-redacted-by-design list)
  - .planning/debug/knowledge-base.md (recurrence entry; tracked despite the .planning ignore rule)

postmortem:
  why_not_caught: |
    A gate DID exist and it ran green — that is the whole lesson. The predecessor session wrote Test 3 to guard this exact
    rule, but sampled 5000 random UUIDs against a defect of density 3.76e-7, giving it a ~0.19% chance of ever firing. The
    gate was calibrated against the PREVIOUS round's defect (~4% density) and silently carried forward to a far rarer one.
    Worse, the code and SPECIFICATION.md both asserted the class was excluded "BY CONSTRUCTION" / "по построению", so a
    reader had a written guarantee where there was only an unmeasured probability. The residual class was not exotic in
    practice: this repo's own all-decimal sentinel fixtures (`00000000-...`, `11111111-1111-...`) were redacted with
    certainty, so real-world exposure was far above the random-UUID density.
  guard: |
    packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts — Tests 8-11 replace probability with
    coverage: deterministic fixtures pin the reported literal and the nil UUID, and Test 10 sweeps the all-decimal
    canonical class at 100% density (deterministic mulberry32, fixed seed) instead of sampling the UUID space. Test 9 and
    Test 11 pin the two invariants that fail SILENTLY (lookahead placement; the inner boundary that preserves card/long-run
    coverage) — both were mutation-verified to fail when broken. Test 3 is kept but re-scoped in its title and docstring so
    its ~4%-density reach is no longer mistaken for a guarantee.
  transferable_lesson: |
    A probabilistic guard proves nothing about a defect rarer than its own sampling density, and it looks identical to a
    real guard in a green CI run. When the input space is structured, sweep the vulnerable CLASS at full density rather
    than sampling the whole space. Related: never let a comment or spec assert "by construction" unless the construction
    is actually the criterion being enforced — here the code excluded "contains a hex letter" while the docs claimed it
    excluded "is a UUID", and the gap between those two statements WAS the bug.
  known_gap_accepted: |
    Invariant 3 (`[0-9a-fA-F]` vs `[0-9]` inside the lookahead) is behaviourally equivalent and therefore unpinnable by
    any test; it is defended by comment only, and the comment says so explicitly to stop a later "simplification".
    Out of scope by design and unchanged: unhyphenated 32-digit ids, IPv4, epoch-ms, and `YYYY-MM-DD hh` remain redacted,
    because a bare 10+ digit run is genuinely indistinguishable from a card number and narrowing it would cost real PII
    coverage.
