# Synthesis Summary

Mode: new (net-new bootstrap, no existing .planning/ context)
Synthesized: 2026-07-02

## Docs

- Total: 1 (ADR: 0, SPEC: 0, PRD: 0, DOC: 1, UNKNOWN: 0)
- docs/research/crm-platform-research.md — DOC, confidence high. Research-only study
  of eight CRM/marketing-automation tools anchoring a date-attribute countdown email
  reminder platform on a SQL + SendGrid baseline.
- Cycle detection: passed (cross-ref graph acyclic; all five refs are proposed
  future documents, none exist yet).

## Decisions

- Locked: 0
- Proposed candidates: 8 (D-01 through D-08) — see intel/decisions.md. Includes the
  source's one inline [Decision] tag (SendGrid sole v1 provider), recorded as
  PROPOSED per the document's research-only framing.

## Requirements

- Extracted: 10 candidates, mapped 1:1 from MVP modules M1–M10 — see
  intel/requirements.md.
  REQ-profile-entity-store, REQ-trigger-definition, REQ-eligibility-evaluator,
  REQ-send-ledger, REQ-dispatcher, REQ-delivery-event-ingestion,
  REQ-suppression-consent, REQ-campaign-lifecycle, REQ-safety-rails,
  REQ-compliance-deliverability.
- All are DOC-derived candidates (no PRDs in ingest set); acceptance criteria are
  candidates drawn from the source's stated mechanics and safety invariants.

## Constraints

- Extracted: 11 — see intel/constraints.md.
- Breakdown: api-contract 4 (C-01 SendGrid 72h scheduling ceiling, C-02 30-day
  activity retention, C-03 batching/correlation limits, C-05 suppression division of
  labor), protocol 1 (C-04 Event Webhook semantics), nfr 6 (C-06 Gmail/Yahoo rules,
  C-07 CAN-SPAM, C-08 GDPR/PECR, C-09 CASL, C-10 IP/volume posture, C-11 scan scale
  envelope).

## Context

- Topics: 10 — see intel/context.md. Notably: three correctness invariants,
  tracked-entity modeling rationale, deferral table with build-when conditions,
  risks R1–R10, and open questions Q1–Q9.

## Conflicts

- 0 blockers, 0 competing-variants, 5 auto-resolved/informational.
- Report: .planning/INGEST-CONFLICTS.md

## Flags for the roadmapper

- The source names nine open scope questions (Q1–Q9, §17); Q1 (what is the tracked
  entity) and Q2 (consent posture) gate roughly half the data model and the send-path
  design. These need product-owner answers before deep planning.
- The source's own recommended first artifact is docs/decisions/mvp-scope-decisions.md
  answering Q1–Q9 — a natural first roadmap item.
- Two load-bearing Customer.io claims are medium-confidence (R9) and should be
  re-verified during design if they influence decisions.

## Intel files

- .planning/intel/decisions.md
- .planning/intel/requirements.md
- .planning/intel/constraints.md
- .planning/intel/context.md
