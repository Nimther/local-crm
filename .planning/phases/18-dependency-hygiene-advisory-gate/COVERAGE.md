# Phase 18 — API Coverage Matrix

External API in scope: **GitHub REST API — Issues**, called by `actions/github-script` inside `.github/workflows/advisory-scan.yml` (D-13). The detector read `false` on the ROADMAP text alone; the matrix is produced anyway because plan 18-04 genuinely calls this API. `npm audit` is out of scope — a CLI subcommand of the installed toolchain, not an SDK integration (D-01 adds no client library).

| capability | decision | reason |
|---|---|---|
| `issues.listForRepo` (filter by label + state) | INTEGRATE | The dedup search: finds the one open advisory issue before deciding to create or update. |
| `issues.create` (with label attached at creation) | INTEGRATE | Opens the advisory issue naming package + GHSA id when no open labelled issue exists. |
| `issues.createComment` | INTEGRATE | Updates the existing open issue on a repeat failure instead of opening a duplicate. |
| `issues.update` (title/body) | INTEGRATE | Refreshes the issue when the failing finding set changes between runs. |
| `issues.get` | OPT-OUT | The label-scoped list call already returns everything the dedup decision needs; a per-issue fetch adds a round trip and no signal. |
| `issues.addLabels` / `removeLabel` | OPT-OUT | The label is attached at creation time; a post-hoc label call is the exact race that breaks the next run's dedup search. |
| `issues.createLabel` / label CRUD | OPT-OUT | The `dependency-advisory` label is repository configuration, created once by a human — not something an unattended cron job should mint. |
| `issues.lock` / `unlock` | OPT-OUT | Advisory issues are meant to be discussed and closed by humans; locking would suppress the response this workflow exists to provoke. |
| `issues.addAssignees` / `removeAssignees` | OPT-OUT | Ownership of an advisory is recorded in the accept-list `owner` field (D-07), not by assigning a GitHub user from CI. |
| `issues.setLabels` | OPT-OUT | Would clobber labels a human added for triage; the workflow only ever needs its own dedup label present. |
| Milestones, reactions, sub-issues, transfer, pin | OPT-OUT | Project-management surface with no bearing on surfacing a dependency advisory; nothing in DEP-02 or D-13 asks for it. |
| Issue events / timeline reads | OPT-OUT | The workflow needs current open-issue state only; history adds no input to the create-or-comment decision. |
| Close / reopen an issue | OPT-OUT | Deliberate: a human closes the issue after acting. Auto-closing on a green run would erase the record before anyone read it. |
| Issue search via `search.issuesAndPullRequests` | OPT-OUT | Rate-limited and eventually-consistent; the label-scoped list call is exact and cheap for a single-label lookup. |
