// RED stub (10-13 Task 1) -- implementation not yet written.
export const CENSOR = "[REDACTED]";
export interface KeyRule {
  readonly key: string;
  readonly protects: string;
}
export interface ValueRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly protects: string;
}
export const REDACTION_RULES: { keyRules: readonly KeyRule[]; valueRules: readonly ValueRule[] } = {
  keyRules: [],
  valueRules: [],
};
