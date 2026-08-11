/** The subset of a contact row `buildContactTemplateData` reads from. */
export interface ContactTemplateDataContact {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  properties: Record<string, unknown>;
}

/**
 * v1 `dynamic_template_data` contract (D-18): the ONE standardized,
 * documented contact-profile shape every tenant designs their SendGrid
 * Dynamic Template against. There is deliberately NO per-campaign
 * variable-mapping in v1 -- every send (broadcast dispatch, 04-04; test
 * send, 04-05/04-08) sends exactly this shape, snake_case, with custom
 * properties nested under `properties` (never flattened into top-level
 * keys, and never colliding with the standard fields above).
 */
export interface ContactTemplateData {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  unsubscribe_url?: string;
}

/**
 * Builds the v1 `dynamic_template_data` payload (D-18) for one contact. This
 * is the single source of truth both the dispatch worker (04-04) and the
 * test-send sample builder (04-05/04-08) must call -- a second,
 * independently-hand-rolled mapping here would be exactly the "second,
 * subtly-different implementation of a send rule" RESEARCH.md's central
 * warning is about. Never includes `subscription_status`, `workspace_id`, or
 * any internal id -- only the documented profile fields plus the optional
 * service field `unsubscribe_url`.
 */
export function buildContactTemplateData(
  contact: ContactTemplateDataContact,
  opts?: { unsubscribeUrl?: string }
): ContactTemplateData {
  return {
    first_name: contact.firstName,
    last_name: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    city: contact.city,
    country: contact.country,
    tags: contact.tags,
    properties: contact.properties,
    ...(opts?.unsubscribeUrl ? { unsubscribe_url: opts.unsubscribeUrl } : {}),
  };
}
