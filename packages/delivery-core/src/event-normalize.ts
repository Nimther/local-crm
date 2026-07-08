/**
 * Pure SendGrid Event Webhook event-type normalization (WBHK-02).
 *
 * Source: SendGrid Event Webhook Reference (official Twilio docs) --
 * confirms hard vs soft bounce share `event:"bounce"` and are distinguished
 * ONLY by the `type` field (`"bounce"` vs `"blocked"`). No DB/network --
 * fully unit-testable, shared verbatim between the webhook worker (05-03)
 * and this plan's own tests.
 */
export type NormalizedEventType =
  | "delivered"
  | "open"
  | "click"
  | "bounce_hard"
  | "bounce_soft"
  | "dropped"
  | "spam_report"
  | "unsubscribe"
  | "group_unsubscribe";

/**
 * Maps a raw SendGrid webhook event to a stable normalized type. Returns
 * `null` for events out of WBHK-02 scope (e.g. `processed`, `deferred`,
 * `group_resubscribe`, `account_status_change`) -- callers ack (2xx) and
 * drop these, never storing or acting on them.
 */
export function normalizeEventType(raw: { event: string; type?: string }): NormalizedEventType | null {
  switch (raw.event) {
    case "delivered":
      return "delivered";
    case "open":
      return "open";
    case "click":
      return "click";
    case "dropped":
      return "dropped";
    case "spamreport":
      return "spam_report";
    case "unsubscribe":
      return "unsubscribe";
    case "group_unsubscribe":
      return "group_unsubscribe";
    case "bounce":
      // D-10: type:"bounce" (or absent) = hard, type:"blocked" = soft.
      return raw.type === "blocked" ? "bounce_soft" : "bounce_hard";
    default:
      return null;
  }
}
