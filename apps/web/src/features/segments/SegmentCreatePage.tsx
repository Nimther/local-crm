import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import type { SegmentDefinition } from "@mega-crm/shared-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSegment } from "@/features/segments/api";
import { createEmptySegmentDefinition, SegmentBuilder } from "@/features/segments/SegmentBuilder";

/**
 * Save-time validation (UI-SPEC copy contract) -- client-side only, the
 * server (03-02 Zod schemas + segments-core compiler) is the authority (see
 * plan's threat_model T-03-07). Returns the first violation found, or null.
 */
function validateDefinition(definition: SegmentDefinition): string | null {
  for (const group of definition.groups) {
    if (group.conditions.length === 0) {
      return "Добавьте хотя бы одно условие в каждую группу";
    }
    for (const cond of group.conditions) {
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

/**
 * New-segment page (SEGM-01/02/04): name field + SegmentBuilder + live count
 * + "Сохранить сегмент" save flow. On success, navigates back to the
 * segments list where the new segment is now visible (D-11).
 */
export function SegmentCreatePage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [definition, setDefinition] = useState<SegmentDefinition>(() => createEmptySegmentDefinition());
  const [nameError, setNameError] = useState<string | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createSegment(slug, { name: name.trim(), definition }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace", slug, "segments"] });
      toast.success("Сегмент создан");
      navigate(`/w/${slug}/segments`);
    },
  });

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Укажите название сегмента");
      return;
    }
    setNameError(null);

    const validationError = validateDefinition(definition);
    if (validationError) {
      setDefinitionError(validationError);
      return;
    }
    setDefinitionError(null);

    mutation.mutate();
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">Создать сегмент</h1>
        <p className="text-sm text-muted-foreground">Объедините контакты по свойствам профиля и поведению.</p>
      </div>

      <div className="max-w-sm space-y-2">
        <Label htmlFor="segment-name">Название сегмента</Label>
        <Input
          id="segment-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например, «VIP Россия»"
        />
        {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
      </div>

      <SegmentBuilder value={definition} onChange={setDefinition} slug={slug} />

      {definitionError ? <p className="text-sm font-medium text-destructive">{definitionError}</p> : null}

      <Button onClick={handleSave} disabled={mutation.isPending}>
        {mutation.isPending ? "Сохраняем…" : "Сохранить сегмент"}
      </Button>
    </div>
  );
}

export default SegmentCreatePage;
