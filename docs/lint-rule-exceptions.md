# Lint rule exceptions

Every rule turned off in `eslint.config.js` beyond its default tier is registered here with
the violation count that prompted the decision and the reason it does not fit this codebase.

The config comment is what a developer sees at the point of change; this file is what a
reviewer reads when asking whether an exception is still justified. They must stay in sync —
each rule listed here appears in `eslint.config.js`, and vice versa.

**This register is for rule-level exceptions only.** A single deliberate violation is not
listed here: it gets a line-scoped `eslint-disable-next-line` naming the rule, with a reason
after a `--` separator, at the site itself (D-06). File-level blanket disables that name no
rule are forbidden outright and are asserted against by
`packages/test-support/src/__tests__/lint-gate.test.ts`.

Counts below were measured at the 08-07 baseline: **403 files checked, 525 violations**
(511 error / 14 warning).

---

## `@typescript-eslint/no-unsafe-*`, test files only

**Rules:** `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`,
`no-unsafe-return`, `no-unsafe-call`

**Scope:** `**/*.test.ts`, `**/*.test.tsx`, `**/__tests__/**/*.{ts,tsx}` — **off in tests, on everywhere else**

**Count at decision:** 243 total — **238 in test files, 5 in source**

| Rule | test | src |
|------|-----:|----:|
| `no-unsafe-member-access` | 160 | 0 |
| `no-unsafe-assignment` | 44 | 3 |
| `no-unsafe-argument` | 22 | 1 |
| `no-unsafe-return` | 10 | 1 |
| `no-unsafe-call` | 2 | 0 |

**Reason.** All 238 test-file violations share one root cause that is not a defect in this
repository's code. The API tests drive Fastify through `app.inject()`, which returns a
`light-my-request` response object whose body reader is declared

```ts
json: <T = any>() => T
```

Because the type parameter defaults to `any`, every expression derived from a response body
is `any` by construction — `res.json().user.id`, `expect(res.json().items[0].email)`, and so
on. The rule is faithfully reporting the type of a third-party test helper, not a place where
this codebase is losing type safety in shipped code.

Reaching zero by typing these out would mean hand-writing a response type at roughly 380 call
sites across ~50 test files. That is a refactor, not a lint cleanup, and this phase is
explicitly bounded against expanding into one (08-SPEC § Constraints, Phase 9 deadline
2026-09-01).

The exception is scoped to tests rather than applied repo-wide because the two cases are
genuinely different: an `any` crossing a boundary in `apps/api/src` or `apps/worker/src` is
the failure mode these rules exist to catch, and there it stays enforced. The five source
violations were fixed individually rather than absorbed by this exception.

**Migration path, if it is ever wanted.** `res.json<T>()` supplies the type parameter directly
and removes the violation at the site — verified during 08-07 triage. A typed helper in
`@mega-crm/test-support` wrapping `inject()` would let the exception be narrowed and eventually
dropped. Neither is scheduled.

---

## The type-aware async rule class is not exceptable

The four async rules named in the Block 4b comment of `eslint.config.js` carry the largest
remaining violation counts in this repository — 87 between them at the 08-07 baseline, 53 of
those in source — and a reader scanning this register may reasonably wonder why they are not
listed above alongside a similarly large count.

They are not, and by policy cannot be. That rule class is the entire reason D-05 selected the
`recommended-type-checked` tier over plain `recommended`: async misuse is the bug class the
production audit found in the send pipeline and the BullMQ workers, and detecting it requires
type information. Excepting any of them — in source or in tests — would leave a green gate
protecting nothing that motivated building it. Nor is an un-awaited promise harmless in a
test: it is a test that can pass before its assertions ever run.

Every one of those 87 sites was therefore resolved individually — the code was fixed, or the
site carries a line-scoped directive naming the rule with a reason after a `--` separator.
The exact rule names, and this prohibition, live in the `eslint.config.js` Block 4b comment,
which is where a developer editing the config will actually encounter them.
