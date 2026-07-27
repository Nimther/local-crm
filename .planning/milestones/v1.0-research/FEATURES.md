# Feature Research

**Domain:** B2C email marketing automation (Klaviyo-class: flows + broadcast campaigns, SendGrid delivery)
**Researched:** 2026-07-03
**Confidence:** MEDIUM (product-category knowledge is well-established and cross-checked across multiple competitors; live web verification was WebSearch-only — see Sources)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist in any product claiming to be "Klaviyo-like." Missing these makes the product feel broken or unfinished, not just less-featured. All of these are already committed in PROJECT.md — this section validates the commitments and calls out omissions inside each area that would otherwise leave gaps.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Contact profile (CRUD + timeline) | Every ESP/marketing-automation tool has a single-contact view showing properties + full activity history | LOW-MEDIUM | Already committed. Timeline must include events, email sends, opens/clicks, subscription changes — not just email sends. |
| CSV import with column mapping | Standard onboarding path for every ESP (Klaviyo, Mailchimp, Customer.io) — day-1 data migration | MEDIUM | Already committed. Table stakes also includes: preview before commit, error/duplicate report, ability to map to custom properties, and either upsert-by-email or upsert-by-external_id. |
| Contacts API (CRUD) | Any product that also offers event ingestion needs a way to manage contacts programmatically, not just via UI | LOW-MEDIUM | Already committed. |
| Event ingestion API (custom events) | Klaviyo's whole automation model is "event → segment/flow trigger"; without it, flows have nothing to key off besides list membership | MEDIUM | Already committed, server-side only (correct scope cut — browser tracking snippet is explicitly deferred). |
| Profile-attribute segmentation | Baseline of every list tool ("all contacts where plan = Pro") | LOW | Already committed. |
| Behavioral/event segmentation | Baseline of Klaviyo-class tools — "purchased in last 30 days", "opened 0 emails in 90 days" | MEDIUM-HIGH | Already committed. This is the single most execution-risky "table stakes" item — see Pitfalls research for query performance at scale. |
| Segment membership used by both flows (entry trigger / exit condition) and campaigns (audience) | Segments are the shared primitive across the whole product; if flows and campaigns use different segment engines, marketers must learn two mental models | MEDIUM | Not explicit in PROJECT.md as a single shared engine — recommend explicit architectural decision that flows, campaigns, and exit conditions ALL evaluate the same segment-definition format. |
| Visual flow/canvas builder with branching | This is Klaviyo's signature UX; users coming from Klaviyo/ActiveCampaign/Mailchimp expect drag-and-drop, not a form-based rule list | HIGH | Already committed. Must include: trigger node, delay/wait node, conditional branch (if/else) node, action node (send email), and — often overlooked — an explicit exit/end node per branch. |
| Time-delay / wait steps in flows | Universal in every flow builder (Klaviyo "time delay", Mailchimp "wait for X days") | LOW-MEDIUM | Not explicitly named in PROJECT.md's flow-rules bullet but implied by "триггерные цепочки". Must be an explicit node type, not just a global setting. |
| Conditional branching by profile/event property | Klaviyo's "Conditional Split" — branch flow paths based on a property, not just A/B random split | MEDIUM-HIGH | Implied by canvas builder commitment. This is a distinct capability from the A/B-test differentiator below — don't conflate them. |
| Flow exit conditions | If a contact meets a defined condition (e.g., "already purchased"), they leave the flow rather than getting an irrelevant email | MEDIUM | Already committed explicitly. |
| Re-entry control (once ever / once per N days / every time) | Prevents duplicate/spammy re-triggering of the same flow for the same contact | MEDIUM | Already committed explicitly — matches Klaviyo's flow settings exactly. |
| Quiet hours | Compliance/UX baseline — do not send at 3am local time | LOW-MEDIUM | Already committed. Needs a decision on whose timezone (contact's inferred TZ vs workspace default) — flag for phase-level research. |
| Frequency capping (global, cross-flow/campaign) | Without this, a contact in 3 overlapping flows plus a broadcast can get 5 emails in a day — the #1 complaint driver in ESPs | MEDIUM-HIGH | Already committed. This must be enforced at send-time across ALL sources (flows + campaigns), which is an architectural, not just a UI, requirement. |
| Broadcast/one-off campaigns | Every ESP needs "send this one email to this segment now/later" alongside automation | LOW-MEDIUM | Already committed. Includes: audience selection (segment), scheduling (send now / send later), and a send-time review step. |
| Send scheduling (future send) | Table stakes for any campaign tool — marketers plan sends days ahead | LOW | Implicit in "запуск/планирование" — make explicit. |
| Subscription/consent status per contact | Legal requirement (CAN-SPAM/GDPR/CASL) and a core Klaviyo primitive (subscribed/unsubscribed/never-subscribed, separate from "suppressed") | MEDIUM | Already committed. Recommend explicit 3-state model: subscribed / unsubscribed / suppressed-for-other-reason (bounce, spam complaint), since these have different re-subscription semantics. |
| Suppression handling (bounce, spam complaint, unsubscribe) | Without this, sender reputation collapses within weeks — this is not optional in email | MEDIUM-HIGH | Already committed via SendGrid webhook. Must suppress BEFORE send (pre-flight filter), not just record after the fact. |
| One-click unsubscribe link + preference honoring | CAN-SPAM/Gmail bulk-sender requirements (2024+ Gmail/Yahoo rules mandate one-click List-Unsubscribe for bulk senders) | LOW-MEDIUM | Not explicit in PROJECT.md. Because templates live in SendGrid Dynamic Templates, the unsubscribe link/header must still be guaranteed present — this is a delivery-layer responsibility (List-Unsubscribe header + suppression-aware link), not a template-editor feature. Flag as a v1 requirement even though there's no in-app template editor. |
| Delivery status per message (delivered/opened/clicked/bounced/unsubscribed) | Core value prop stated in PROJECT.md itself | MEDIUM | Already committed. |
| Campaign-level and flow-step-level analytics | Marketers need to know which step of a flow underperforms, not just flow-level aggregate | MEDIUM | Already committed. |
| Workspace-level dashboard | Every SaaS analytics surface needs a "how are we doing overall" landing view | LOW-MEDIUM | Already committed. |
| Per-message send log with filters | Support/debugging table stakes — "did this contact get this email and what happened to it" | LOW-MEDIUM | Already committed. |
| Multi-tenant workspaces + team invites + roles | Any B2B SaaS with more than one seat needs this from day one | MEDIUM | Already committed (Owner/Admin/Member). |
| Duplicate/test send safety (send test email, preview data) | Marketers routinely test a campaign/flow email before it goes to a whole segment | LOW-MEDIUM | Not explicit in PROJECT.md. Because SendGrid renders the template, "send test" = trigger a real SendGrid send with test dynamic_template_data to the marketer's own address. Recommend adding explicitly — cheap and expected. |
| Flow/campaign draft vs live/published state | Marketers build in draft, review, then explicitly publish/activate — accidental live sends are a classic footgun | LOW-MEDIUM | Not explicit in PROJECT.md, but implied by "создание, выбор сегмента, запуск/планирование". Should be an explicit state machine (draft → scheduled/live → paused/archived). |

### Differentiators (Competitive Advantage)

Not required for the product to feel complete, but where a Klaviyo-class product can compete. PROJECT.md's Core Value ("triggered chains reliably arrive on time, with end-to-end status tracking") suggests reliability/observability and canvas UX are the intended differentiation surface — not content/AI (explicitly out of scope) and not omnichannel (email-only by design).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| A/B testing within flows (branch-level or single-email-level, auto-pick-winner) | Klaviyo's flow A/B testing is a well-known power feature; absence is noticeable to Klaviyo-experienced marketers but tolerable for v1 | MEDIUM-HIGH | Recommend v1.x, not v1 — depends on flow engine + stats-significance logic + winner-promotion logic all being solid first. Defer per template guidance ("nice to have is not MVP"). |
| RFM / predictive segmentation (churn risk, CLV, next-order-date) | Klaviyo's headline differentiator for ecommerce; drives segment quality without manual rule-building | HIGH | Explicitly out of scope for v1 (no AI content, and this needs a predictive model + enough transaction history). Good v2 candidate once event volume is established. |
| Reliable, observable send pipeline (RPS-safe queue, priority isolation of triggered vs broadcast) | This is literally the product's stated Core Value; most competitors treat this as invisible infrastructure — making it visible (e.g., accurate ETAs, honest queue-depth indicators, no broadcast-blocks-triggered incidents) is a real differentiator for a v1 aimed at reliability-conscious teams | HIGH | Already an architectural constraint in PROJECT.md. The differentiation is less "build a queue" (table stakes for correctness) and more "expose this reliability to the user" — e.g., campaign send progress bar, per-step flow health indicators. |
| Deep per-contact + per-flow-step delivery timeline (unified view across events, sends, and status changes) | Klaviyo has this; Customer.io has this; Mailchimp's is weaker. A clean unified timeline is a genuine UX differentiator versus lower-tier ESPs | MEDIUM | Already partially committed via "timeline активности в карточке контакта" — leaning into this as the differentiator (vs. treating it as a checkbox feature) is a cheap way to punch above the product's weight. |
| Segment "who's in this segment right now" live preview with count, while building | Removes the #1 segmentation frustration (build a segment, save, THEN discover it matches 0 or 500k contacts) | MEDIUM | Not in PROJECT.md. Recommend for v1 given behavioral segmentation is core value — cheap relative to the trust it builds. |
| Canvas flow builder with real-time validation (dead branches, missing exit path, orphan nodes) | Differentiator vs. bare-bones automation tools; prevents the "flow silently does nothing" failure mode that's common in DIY automation tools | MEDIUM-HIGH | Complements the already-committed canvas editor — the differentiation is in the guardrails, not just the drag-and-drop itself. |

### Anti-Features (Commonly Requested, Often Problematic)

Consistent with what PROJECT.md already scoped out — documented here with rationale for the roadmap/requirements stage, plus a couple of category-typical asks not yet explicitly called out.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| In-app WYSIWYG email template editor | "Every competitor has one, marketers expect to design emails visually" | Massive scope (drag-drop block editor, MJML/HTML rendering, mobile preview, merge-tag UI) — a multi-month project on its own, and directly conflicts with the BYO-SendGrid/Dynamic-Templates architecture decision | Already correctly scoped out. Templates + variables live in SendGrid Dynamic Templates; platform only passes `template_id` + `dynamic_template_data`. |
| Omnichannel (SMS/push/in-app/WhatsApp) | "Klaviyo/Braze do SMS+email together, it feels incomplete without it" | Each channel adds its own compliance regime (10DLC for SMS, APNs/FCM for push), its own delivery provider, its own suppression rules — multiplies surface area before email-only value is proven | Already correctly scoped out. Ship email deep, revisit channel expansion only after email flows/segmentation are validated. |
| AI content generation / subject-line writer / autotranslate | "Competitors are all adding AI copy tools, feels dated without it" | Adds an LLM-integration dependency, a review/quality-control problem (hallucinated claims in marketing copy = legal/brand risk), and directly competes with the "templates live in SendGrid" decision — there's no in-app content surface to inject AI into anyway | Already correctly scoped out. If ever added, layer onto a future in-app template editor, not before. |
| Deals / sales pipeline / opportunity tracking | "CRMs usually have this, and 'mega-crm' sounds CRM-like" | Fundamentally different data model and workflow (stages, deal value, forecasting) serving sales teams, not marketers; bolting it on dilutes focus and roadmap for a product explicitly positioned as marketing-only | Already correctly scoped out — explicit principled decision in PROJECT.md. |
| Strict/validated event schemas (required fields, typed properties) | "Prevents bad data from entering the system" | Adds friction at integration time (the #1 factor in event-driven tools' time-to-value) and requires a schema-registry UI before any events even exist yet — premature for v1 | Already correctly scoped out. Free-form event model now; a discovered/inferred type registry (surface what schemas ARE being sent, don't enforce them) is a reasonable v1.x addition. |
| Platform-run shared-sending SendGrid account (subusers, platform-level domain auth) | "Simpler onboarding — no BYO API key setup for the tenant" | Shared sending reputation means one abusive/careless tenant can damage deliverability for all tenants; also requires the platform to own domain authentication/DKIM/subuser management — real infra and compliance burden | Already correctly scoped out (BYO key model). Revisit only if self-serve onboarding friction from BYO-key setup proves to be a real adoption blocker. |
| Full real-time streaming analytics (sub-second dashboard updates) | "Looks impressive, feels 'modern'" | At the stated year-1 scale (100k-1M contacts, hundreds of thousands of emails/day) this is solvable with periodic aggregation (e.g., minute-level rollups) at a fraction of the infra cost/complexity of a true streaming pipeline (Kafka/ClickHouse-class); premature investment before there's proof marketers need sub-second dashboards | Not previously flagged in PROJECT.md — added here as an anti-feature for scoping requirements. Batch/near-real-time (1-5 min lag) rollups are the right v1 target; see ARCHITECTURE.md/PITFALLS.md for the aggregation approach. |

## Feature Dependencies

```
Event ingestion API (custom events)
    └──requires──> Contact upsert (external_id/email identity resolution)

Behavioral/event segmentation
    └──requires──> Event ingestion API
    └──requires──> Contact profile data model

Flow entry trigger (event or segment-based)
    └──requires──> Behavioral/event segmentation OR Event ingestion API
                       └──requires──> Segment evaluation engine (shared with campaigns)

Flow exit conditions
    └──requires──> Segment evaluation engine (same primitive as entry trigger)

Re-entry control
    └──requires──> Flow execution history per contact (has this contact been through this flow, and when)

Frequency capping (global, cross-flow/campaign)
    └──requires──> Unified send-attempt ledger across flows AND campaigns
                       └──requires──> Shared send-queue/orchestration layer

Broadcast campaigns (audience selection)
    └──requires──> Segment evaluation engine (same primitive as flows)

Suppression handling (bounce/spam/unsubscribe)
    └──requires──> SendGrid Event Webhook ingestion
    └──enhances──> Subscription/consent status (both gate send eligibility)

Send-time suppression filtering ("do not send" pre-flight check)
    └──requires──> Suppression handling
    └──requires──> Subscription/consent status

Campaign/flow-step analytics
    └──requires──> Delivery status per message
                       └──requires──> SendGrid Event Webhook ingestion

Contact timeline
    └──requires──> Delivery status per message
    └──requires──> Event ingestion API
    └──requires──> Subscription/consent status changes

A/B testing within flows (differentiator)
    └──requires──> Conditional branching (table stakes)
    └──requires──> Flow-step analytics (to compute a winner)

Segment live preview/count (differentiator)
    └──enhances──> Behavioral/event segmentation (same engine, added UX)

RFM/predictive segmentation (differentiator, deferred)
    └──requires──> Behavioral/event segmentation
    └──requires──> Sufficient historical event volume per tenant

In-app template editor (anti-feature, not building)
    └──conflicts──> SendGrid Dynamic Templates as source of truth for content
```

### Dependency Notes

- **Behavioral/event segmentation requires Event ingestion API:** without incoming custom events, segmentation degrades to profile-attribute-only, which undercuts the stated Core Value (Klaviyo-style triggered scenarios need event data).
- **Flow entry/exit and campaign audience selection should share one Segment evaluation engine:** this is the single most important architectural dependency to get right early — if flows and campaigns build separate segment-matching code paths, the product will accumulate two divergent, hard-to-reconcile definitions of "who is in this segment," which surfaces as user-visible inconsistency (a contact in a campaign audience but skipped by an identical flow condition).
- **Frequency capping requires a unified send-attempt ledger:** capping only works if flows and broadcast campaigns write to the same ledger of "attempted sends per contact per time window" — implementing it per-subsystem (flow-local cap, campaign-local cap) does not satisfy the actual requirement ("global frequency cap on contact") already stated in PROJECT.md.
- **Re-entry control requires flow execution history:** "once ever" / "once per N days" needs a durable per-contact-per-flow record of prior entries, which must survive flow edits (versioning question to flag for architecture/phase research).
- **Suppression handling enhances but is distinct from Subscription/consent status:** a contact can be "subscribed" (opted in) yet suppressed (hard-bounced address) — these are two independent gates that both must pass before a send is attempted; conflating them into one status field is a common modeling mistake (see PITFALLS.md).
- **A/B testing depends on maturity of two other systems:** it should not be scheduled into the same phase as the initial flow engine build — sequence it after conditional branching and flow-step analytics are both proven, per the MVP Definition below.
- **In-app template editor conflicts with the BYO SendGrid Dynamic Templates decision:** this is a hard architectural conflict, not a priority call — building any in-app rendering surface duplicates SendGrid's own template stack and reintroduces exactly the scope PROJECT.md deliberately cut.

## MVP Definition

### Launch With (v1)

Everything below is already committed in PROJECT.md's Active requirements, refined with the table-stakes gap-fills identified above. This is the minimum for the product to feel like a credible Klaviyo-class tool rather than a partial prototype.

- [ ] Multi-tenant workspaces, team invites, Owner/Admin/Member roles — required for any multi-seat SaaS
- [ ] BYO SendGrid key connection per tenant — required for delivery to work at all
- [ ] Contacts CRUD (UI + API), CSV import with mapping/preview, external_id + email identity resolution, event-driven upsert — required data foundation
- [ ] Event ingestion API (server-side, free-form schema) — required for behavioral segmentation and flow triggers
- [ ] Segmentation: profile-attribute AND behavioral/event-based, backed by one shared segment-evaluation engine used by flows, exit conditions, and campaigns — this shared-engine requirement is the key gap-fill from this research
- [ ] Subscription status (3-state: subscribed/unsubscribed/suppressed) + suppression from SendGrid webhook, enforced as a pre-send filter — required for legal compliance and reputation
- [ ] Canvas flow builder: trigger, delay/wait, conditional branch, action(send) node types, with an explicit exit/end per branch — this is the committed differentiator-grade UX; ship it complete, not partial
- [ ] Flow rules: exit conditions, re-entry control, quiet hours, global cross-flow/campaign frequency cap — all four already committed; frequency cap specifically needs the unified send-ledger noted above
- [ ] Broadcast campaigns: segment selection, send-now or scheduled send, draft→scheduled/live state machine, send-test-email capability — draft/live state and test-send are the gap-fills here
- [ ] Send queue with RPS throttling, priority isolation (broadcast never blocks triggered) — required architectural constraint from PROJECT.md
- [ ] SendGrid Event Webhook processing (delivered/opened/clicked/bounced/unsubscribed/spam report/dropped) — required for suppression and analytics both
- [ ] Analytics: campaign metrics, flow-step metrics, contact timeline, workspace dashboard, per-message send log with filters — all committed
- [ ] Segment live-preview count while building a segment — cheap, high-trust addition; recommend folding into the segmentation phase rather than treating as a stretch item

### Add After Validation (v1.x)

Add once the core loop (contacts → segment → flow/campaign → delivery → analytics) is proven with real tenants sending real volume.

- [ ] A/B testing within flows (branch-level and/or single-email-level, auto-winner) — trigger: flow engine and flow-step analytics both stable in production for at least one full send cycle
- [ ] Canvas flow validation/linting (dead branches, missing exit, orphan nodes) — trigger: enough real tenant-built flows exist to know which mistakes are actually common
- [ ] Discovered/inferred event-type registry (surface schemas seen, without enforcing them) — trigger: enough event volume/variety exists that marketers are asking "what events do we even have"
- [ ] Re-engagement/sunset-policy tooling (auto-flag contacts inactive 60-180 days, one-click win-back segment) — trigger: tenants' lists are old enough that engagement decay is visible in the data

### Future Consideration (v2+)

Defer until product-market fit is established for the email-only v1.

- [ ] RFM / predictive segmentation (churn risk, CLV, next-order prediction) — why defer: needs sustained transaction/event history per tenant plus a predictive-modeling investment; premature before email flows/segmentation themselves are validated
- [ ] Additional channels (SMS, push, in-app) — why defer: explicit v1 scope decision; each channel is its own compliance and delivery-provider integration project
- [ ] Platform-run shared SendGrid sending (subusers/domain auth) — why defer: only relevant if BYO-key onboarding friction proves to be a real adoption blocker
- [ ] In-app template editor — why defer: conflicts with the SendGrid Dynamic Templates architecture decision; would require unwinding that decision first, not just "adding a feature"
- [ ] AI content generation — why defer: explicit v1 scope decision; also has no natural home in the product until/unless an in-app content surface exists

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|----------------------|----------|
| Shared segment-evaluation engine (flows+campaigns) | HIGH | MEDIUM | P1 |
| Canvas flow builder (full node set) | HIGH | HIGH | P1 |
| Behavioral/event segmentation | HIGH | HIGH | P1 |
| Suppression + subscription status pre-send filter | HIGH | MEDIUM | P1 |
| Send queue with RPS throttling + priority isolation | HIGH | HIGH | P1 |
| SendGrid Event Webhook processing | HIGH | MEDIUM | P1 |
| Frequency capping (unified ledger) | HIGH | MEDIUM | P1 |
| Contacts CRUD + CSV import + API | HIGH | MEDIUM | P1 |
| Analytics (campaign/flow-step/timeline/dashboard/send log) | HIGH | MEDIUM | P1 |
| Broadcast campaigns w/ draft-state + test send | HIGH | LOW-MEDIUM | P1 |
| Multi-tenant workspaces + roles | MEDIUM | MEDIUM | P1 |
| Segment live-preview count | MEDIUM | LOW | P1 |
| A/B testing in flows | MEDIUM | HIGH | P2 |
| Flow validation/linting | MEDIUM | MEDIUM | P2 |
| Discovered event-type registry | LOW-MEDIUM | LOW | P2 |
| Sunset/win-back tooling | MEDIUM | LOW-MEDIUM | P2 |
| RFM/predictive segmentation | HIGH (for ecommerce tenants) | HIGH | P3 |
| Additional channels (SMS/push) | MEDIUM | HIGH | P3 |
| Platform-run shared SendGrid sending | LOW | HIGH | P3 |
| In-app template editor | MEDIUM | HIGH | P3 |
| AI content generation | LOW-MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Klaviyo | Customer.io / Braze | Mailchimp | Our Approach |
|---------|---------|----------------------|-----------|---------------|
| Flow builder | Canvas, trigger+conditional splits, time delays, smart sending | Canvas/graph-based, event-driven, developer-oriented | Canvas ("Customer Journey Builder"), if/else branching, templates | Canvas builder matching Klaviyo's node vocabulary (trigger, delay, conditional branch, action, exit) |
| Segmentation | Profile + behavioral + RFM + AI-predictive, real-time updating | Strong event-driven segmentation, developer-configurable | Profile + behavioral, weaker predictive layer | Profile + behavioral for v1 (table stakes); RFM/predictive explicitly deferred to v2+ |
| A/B testing | Flow-branch level and single-email level, auto-winner by open/click | Available, more manual/developer-configured | Available at campaign level, more basic in automations | Deferred to v1.x — sequence after flow engine + analytics are proven |
| Channels | Email + SMS (no native push/in-app) | Full omnichannel (email/SMS/push/in-app) | Email + SMS + some social/ads | Email-only by explicit scope decision — depth over breadth |
| Deliverability/suppression | Own suppression + engagement-based sunset flows | Strong, developer-managed suppression | Own suppression, less granular engagement scoring | Own 3-state subscription/suppression model, SendGrid-webhook-driven, pre-send filter (matches Klaviyo's rigor without needing SMS/push suppression complexity) |
| Analytics | Flow/campaign/segment dashboards, revenue attribution | Strong event/funnel analytics, developer-facing | Solid but shallower automation-step analytics | Campaign + flow-step + contact-timeline + workspace dashboard + send log — matches Klaviyo's granularity; revenue attribution out of scope (no ecommerce integration in v1) |
| Content/templates | In-app drag-drop email designer, AI content assist | In-app + Liquid templating, some AI assist | In-app drag-drop designer, AI content assist | No in-app editor — SendGrid Dynamic Templates own content; explicit differentiation-by-subtraction versus all three competitors here |
| Engineering lift to operate | Low (marketer-owned) | Higher (developer partnership expected) | Low (marketer-owned) | Aims for Klaviyo/Mailchimp-like low marketer-lift on the segmentation/flow/campaign surfaces, while accepting the BYO-SendGrid-key setup as a one-time developer-assisted step per tenant |

## Sources

- [Klaviyo Flows: Email & Marketing Automation Workflows](https://www.klaviyo.com/features/flows) — official product page
- [Klaviyo Help Center: How to A/B test flow branches](https://help.klaviyo.com/hc/en-us/articles/360049849432) — official docs
- [Klaviyo Help Center: Understanding what to A/B test in your flows](https://help.klaviyo.com/hc/en-us/articles/360054629031) — official docs
- [Klaviyo Help Center: Flow Glossary](https://help.klaviyo.com/hc/en-us/articles/360054130591) — official docs
- [Flowium: The Trigger Split vs Conditional Split in Klaviyo](https://flowium.com/blog/the-trigger-split-vs-conditional-split-in-klaviyo/) — third-party analysis
- [Klaviyo: Customer Segmentation Tools](https://www.klaviyo.com/features/segmentation) — official product page
- [Klaviyo Help Center: How to build a segment using RFM properties](https://help.klaviyo.com/hc/en-us/articles/18193920339483) — official docs
- [Klaviyo: The Enterprise Customer Data Platform](https://www.klaviyo.com/products/advanced-cdp) — official product page (predictive analytics/AI segmentation)
- [Oden: Customer.io vs Braze vs Iterable vs Klaviyo comparison](https://getoden.com/blog/customerio-vs-braze-vs-iterable-vs-klaviyo) — third-party comparison, cross-referenced against multiple similar comparison sources for consistency
- [Contra Collective: Klaviyo vs Braze 2026](https://contracollective.com/blog/klaviyo-vs-braze-ecommerce-email-marketing-automation-2026) — third-party comparison
- [Mailchimp Help: About Marketing Automation Flows](https://mailchimp.com/help/about-customer-journeys/) — official docs
- [Mailchimp Help: Create a Marketing Automation Flow](https://mailchimp.com/help/create-customer-journey/) — official docs
- [Mailchimp Help: Use Automation Flow Templates](https://mailchimp.com/help/use-pre-built-journey-maps/) — official docs
- [Spamhaus: What is an email sunset policy](https://www.spamhaus.org/resource-hub/deliverability/what-is-an-email-sunset-policy-and-why-do-you-need-one/) — industry authority on deliverability
- [Mailjet: Sunset Policies In Email](https://www.mailjet.com/blog/deliverability/understanding-email-sunset-policies/) — ESP vendor content, cross-checked against Spamhaus
- [Twilio SendGrid Docs: Event Webhook Reference](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event) — official SendGrid documentation
- [Twilio SendGrid Docs: Suppressions](https://www.twilio.com/docs/sendgrid/ui/sending-email/index-suppressions) — official SendGrid documentation
- [HubSpot: Email marketing benchmarks by industry](https://blog.hubspot.com/sales/average-email-open-rate-benchmark) — industry benchmark aggregator
- [Bloomreach: 15 Essential Email Marketing Analytics & KPIs](https://www.bloomreach.com/en/blog/email-marketing-analytics-deep-dive-metrics) — third-party analytics guide

**Note on confidence:** Findings were gathered via the built-in WebSearch tool (Brave/Exa/Tavily API keys not configured in this environment), so per the source-hierarchy seam individual fetches classify as LOW confidence by default (MEDIUM where cross-verified against official vendor docs). However, this is a well-known, mature product category (Klaviyo/Mailchimp/SendGrid are extensively documented, and the researcher has strong built-in domain knowledge of email marketing automation as a category) — findings were cross-checked across 3+ independent sources per topic and against official vendor documentation (Klaviyo Help Center, Mailchimp Help, Twilio/SendGrid Docs) wherever possible. Overall confidence for this document is assessed as MEDIUM on that basis. Areas of genuine uncertainty (exact re-entry semantics edge cases, exact quiet-hours timezone handling conventions) are flagged inline above for phase-specific research.

---
*Feature research for: B2C email marketing automation SaaS (Klaviyo-class, email-only, SendGrid delivery)*
*Researched: 2026-07-03*
