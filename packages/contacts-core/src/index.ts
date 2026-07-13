export { logger } from "./logger.js";
export {
  registerObservedProperty,
  registerObservedProperties,
  type ObservedPropertyType,
} from "./property-registry.js";
export {
  CONTACT_COLUMNS,
  RESERVED_CONTACT_PROPERTY_KEYS,
  isEmailSuppressed,
  isEmailTaken,
  findContactIdByIdentity,
  upsertContactByIdentity,
  type ContactRow,
  type SubscriptionStatus,
  type UpsertContactIdentityInput,
  type UpsertContactIdentityResult,
} from "./contact-repository.js";
export { applyCsvRowMapping, type CsvMappingResult } from "./csv-mapping.js";
export {
  recordSubscriptionStatusChange,
  type RecordSubscriptionStatusChangeParams,
  type SubscriptionStatusChangeSource,
} from "./subscription-status-history.js";
