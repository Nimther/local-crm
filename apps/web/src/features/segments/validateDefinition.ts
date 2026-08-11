import type { ConditionOperator, SegmentDefinition } from "@mega-crm/shared-schemas";

/**
 * Generic server-error copy (CR-01 part 3 / WR-07) -- shown when a mutation's
 * onError fires and there is no more specific message to surface. Shared by
 * SegmentCreatePage and SegmentDetailPage so the copy cannot drift between
 * the two flows.
 */
export const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

/** Mirrors SegmentBuilder's HIDDEN_VALUE_OPERATORS -- operators that need no value input. */
const HIDDEN_VALUE_OPERATORS = new Set<ConditionOperator>(["is_empty", "is_not_empty", "is_true", "is_false"]);

/**
 * Save-time validation (UI-SPEC copy contract) -- client-side only, the
 * server (03-02 Zod schemas + segments-core compiler) is the authority (see
 * plan's threat_model T-03-07). Returns the first violation found, or null.
 *
 * Shared by SegmentCreatePage and SegmentDetailPage (IN-04) so the
 * empty-field/missing-value checks cannot drift between them.
 */
export function validateDefinition(definition: SegmentDefinition): string | null {
  for (const group of definition.groups) {
    if (group.conditions.length === 0) {
      return "Добавьте хотя бы одно условие в каждую группу";
    }
    for (const cond of group.conditions) {
      if (cond.type === "attribute") {
        if (!cond.field) {
          return "Выберите поле в каждом условии";
        }
        if (!HIDDEN_VALUE_OPERATORS.has(cond.operator) && (cond.value === undefined || cond.value === "")) {
          return "Укажите значение условия";
        }
      }
      if (cond.type === "behavioral") {
        if (cond.countOperator === "at_least" && !cond.count) {
          return "Укажите количество";
        }
        if (cond.timeframe.kind === "last_days" && !cond.timeframe.days) {
          return "Укажите количество дней";
        }
      }
    }
  }
  return null;
}
