import type { FlowValidationError, FlowValidationErrorCode } from "@mega-crm/flows-core";

/**
 * D-17/Pitfall-3: shapes validateFlowDefinition's (pure, @mega-crm/flows-core)
 * hard-error list into the `fields` breakdown a 422 publish-rejection
 * response needs. Node-scoped errors (`empty_send`/`branch_missing_exit`)
 * key by their `nodeId`; the flow-scoped `no_trigger` error keys by the
 * fixed string "trigger" (there is no node id to key it by -- the flow has
 * zero or more than one trigger node).
 */
export function shapeFlowValidationFields(errors: FlowValidationError[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const error of errors) {
    const key = error.nodeId ?? "trigger";
    fields[key] = copyForCode(error.code);
  }
  return fields;
}

function copyForCode(code: FlowValidationErrorCode): string {
  switch (code) {
    case "no_trigger":
      return "Добавьте ровно один узел триггера";
    case "empty_send":
      return "Укажите шаблон письма и отправителя для узла отправки";
    case "branch_missing_exit":
      return "Оба исхода ветвления должны вести к узлу выхода";
    case "cycle_detected":
      return "Цепочка содержит цикл — уберите повторяющийся путь, чтобы контакт мог дойти до узла выхода.";
    case "no_entry":
      return "Триггер должен вести к следующему узлу — добавьте связь от триггера.";
    default:
      return "Некорректная конфигурация цепочки";
  }
}
