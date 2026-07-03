import pino from "pino";
import { env } from "./env.js";

/**
 * Structured logging (Pino, per CLAUDE.md). Redaction paths cover every
 * field name that could carry a tenant SendGrid key, a decrypted DEK, a
 * session token, or a password — across arbitrarily nested log objects
 * (the wildcard `*` segments), per RESEARCH.md Security Domain
 * ("never log the decrypted SendGrid key or session tokens").
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: {
    paths: [
      "sendgridKey",
      "*.sendgridKey",
      "*.*.sendgridKey",
      "apiKey",
      "*.apiKey",
      "*.*.apiKey",
      "password",
      "*.password",
      "*.*.password",
      "token",
      "*.token",
      "*.*.token",
    ],
    censor: "[REDACTED]",
  },
});
