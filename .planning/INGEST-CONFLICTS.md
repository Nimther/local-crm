## Conflict Detection Report

### BLOCKERS (0)

(none)

### WARNINGS (0)

(none)

### INFO (5)

[INFO] Single-document ingest — no cross-doc conflicts possible
  Note: The ingest set contains exactly one classified document
  (docs/research/crm-platform-research.md, type DOC, confidence high). Precedence
  rules had nothing to arbitrate; all buckets that require two contradicting sources
  are empty by construction.

[INFO] Cross-refs point to five proposed documents that do not exist yet
  Note: docs/research/crm-platform-research.md (§18) references
  docs/decisions/mvp-scope-decisions.md, docs/design/trigger-lifecycle-spec.md,
  docs/design/data-model.md, docs/policy/consent-and-compliance.md, and
  docs/ops/send-safety-runbook.md as recommended next documents. None exist on disk.
  The cross-ref graph is trivially acyclic; cycle detection passed. These are forward
  pointers, not missing inputs.

[INFO] Inline [Decision] tag recorded as PROPOSED, not LOCKED
  Note: docs/research/crm-platform-research.md (§11) carries one inline [Decision]
  tag ("SendGrid is the sole email provider in v1"). Per the document's own framing
  ("Research-only sprint... no final architecture decisions") and its classification
  (locked: false), it is synthesized as PROPOSED candidate D-01 in
  .planning/intel/decisions.md. Formalize as an ADR if it should become binding.

[INFO] All requirements and decisions are DOC-derived candidates (lowest precedence)
  Note: No ADRs, PRDs, or SPECs were ingested. Every entry in
  .planning/intel/decisions.md and requirements.md is a candidate extracted from
  research recommendations; any future ADR/SPEC/PRD supersedes them without conflict.
  Constraints in .planning/intel/constraints.md describe external provider/regulatory
  facts the source labels [Confirmed], but provenance is still DOC-tier.

[INFO] Source flags its own confidence gaps and nine unresolved scope questions
  Note: docs/research/crm-platform-research.md R9 (§16) — Customer.io and Iterable
  mechanics rest on search-snippet extracts of fetch-blocked official pages; the
  source recommends re-verifying two load-bearing Customer.io claims (late-attribute
  cutoff, monthly clamping) during design. §17 lists nine open questions (Q1–Q9);
  the source states Q1 (tracked entity) and Q2 (consent posture) block roughly half
  the data model. These are product-owner decisions, not doc conflicts — the
  roadmapper should surface them before deep planning.
