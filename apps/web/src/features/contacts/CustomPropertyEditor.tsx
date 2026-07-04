import { useState } from "react";
import { X } from "lucide-react";

import type { PropertyRegistryItem } from "@mega-crm/shared-schemas";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const REGISTRY_DATALIST_ID = "contact-property-registry-keys";

interface PropertyRow {
  id: string;
  key: string;
  value: unknown;
}

function rowsFromProperties(properties: Record<string, unknown>): PropertyRow[] {
  return Object.entries(properties).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
  }));
}

function observedTypeFor(key: string, registry: PropertyRegistryItem[]): "string" | "number" | "bool" | "date" {
  return registry.find((item) => item.key === key)?.observedType ?? "string";
}

/**
 * D-10/D-19: key/value row list under a "Свойства" section -- key inputs
 * autocomplete from the workspace property registry (native <datalist>, no
 * combobox library in the stack), value input is type-aware per the
 * registry's observed type for that key, defaulting to text for unknown
 * keys. Emits the full merged properties object on every edit.
 */
export function CustomPropertyEditor({
  properties,
  registry,
  onChange,
}: {
  properties: Record<string, unknown>;
  registry: PropertyRegistryItem[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState<PropertyRow[]>(() => rowsFromProperties(properties));

  function emit(nextRows: PropertyRow[]) {
    setRows(nextRows);
    const next: Record<string, unknown> = {};
    for (const row of nextRows) {
      const key = row.key.trim();
      if (key) next[key] = row.value;
    }
    onChange(next);
  }

  function updateRow(id: string, patch: Partial<PropertyRow>) {
    emit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    emit(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((prev) => [...prev, { id: crypto.randomUUID(), key: "", value: "" }]);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Свойства подсказываются на основе данных из API, событий и предыдущих импортов.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Свойств пока нет</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const observedType = observedTypeFor(row.key, registry);
            return (
              <div key={row.id} className="flex items-center gap-2">
                <Input
                  list={REGISTRY_DATALIST_ID}
                  value={row.key}
                  placeholder="Ключ"
                  onChange={(e) => updateRow(row.id, { key: e.target.value })}
                  className="w-1/3"
                />
                {observedType === "bool" ? (
                  <div className="flex flex-1 items-center">
                    <Checkbox
                      checked={Boolean(row.value)}
                      onCheckedChange={(checked) => updateRow(row.id, { value: Boolean(checked) })}
                    />
                  </div>
                ) : observedType === "number" ? (
                  <Input
                    type="number"
                    value={typeof row.value === "number" ? row.value : ""}
                    onChange={(e) =>
                      updateRow(row.id, { value: e.target.value === "" ? "" : Number(e.target.value) })
                    }
                    className="flex-1"
                  />
                ) : observedType === "date" ? (
                  <Input
                    type="date"
                    value={typeof row.value === "string" ? row.value : ""}
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    className="flex-1"
                  />
                ) : (
                  <Input
                    value={typeof row.value === "string" || typeof row.value === "number" ? String(row.value) : ""}
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    className="flex-1"
                  />
                )}
                <Button type="button" variant="ghost" size="icon" onClick={() => removeRow(row.id)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <datalist id={REGISTRY_DATALIST_ID}>
        {registry.map((item) => (
          <option key={item.key} value={item.key} />
        ))}
      </datalist>

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        Добавить свойство
      </Button>
    </div>
  );
}

export default CustomPropertyEditor;
