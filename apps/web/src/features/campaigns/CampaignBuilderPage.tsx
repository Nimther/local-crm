import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { createCampaign, getCampaign, updateCampaign } from "@/features/campaigns/api";
import { listSegments } from "@/features/segments/api";
import { SenderPicker, TemplatePicker } from "@/features/campaigns/TemplateSenderPickers";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const MISSING_NAME_COPY = "Укажите название кампании";
const MISSING_SEGMENT_COPY = "Выберите сегмент-аудиторию";

/** D-01/D-05: segment combobox (Phase-3 popover+command pattern), audience section of the builder. */
function SegmentPicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | null;
  onChange: (segmentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "picker"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: 200 }),
    enabled: Boolean(slug),
  });

  const segments = segmentsQuery.data?.items ?? [];
  const selected = segments.find((s) => s.id === value);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-expanded={open} className="w-72 justify-start">
          {selected ? selected.name : "Выберите сегмент"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск сегмента…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>
              <p className="px-2 py-1.5 text-sm text-muted-foreground">Сегменты не найдены.</p>
            </CommandEmpty>
            <CommandGroup heading="Сегменты">
              {segments.map((segment) => (
                <CommandItem key={segment.id} value={segment.name} onSelect={() => choose(segment.id)}>
                  {segment.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Campaign builder (create draft + edit draft, CAMP-01): name + Аудитория
 * (segment picker) + Шаблон и отправитель (template/sender pickers) ->
 * «Сохранить черновик». Editing is only legal while status='draft' (D-08);
 * any other status shows a read-only notice. Used standalone for
 * /campaigns/new, and embedded (unmodified) by CampaignDetailPage's draft
 * view for /campaigns/:id, which renders the real launch/schedule actions +
 * test-send panel below it (04-08) — this component itself no longer shows
 * its own placeholder launch/schedule buttons (removed here to avoid a
 * duplicate, non-functional pair alongside CampaignDetailPage's real ones).
 * Structural analog: SegmentCreatePage.tsx.
 */
export function CampaignBuilderPage() {
  const { slug = "", id } = useParams<{ slug: string; id?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = Boolean(id);

  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [fromSenderId, setFromSenderId] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const campaignQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", id],
    queryFn: () => getCampaign(slug, id as string),
    enabled: Boolean(slug) && Boolean(id),
  });

  useEffect(() => {
    const campaign = campaignQuery.data;
    if (!campaign) return;
    setName(campaign.name);
    setSegmentId(campaign.segmentId);
    setTemplateId(campaign.templateId);
    setFromSenderId(campaign.fromSenderId);
  }, [campaignQuery.data]);

  const isDraft = !isEdit || campaignQuery.data?.status === "draft";

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        segmentId: segmentId as string,
        templateId,
        fromSenderId,
      };
      return isEdit ? updateCampaign(slug, id as string, body) : createCampaign(slug, body);
    },
    onSuccess: async (saved) => {
      setServerError(null);
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns"] });
      toast.success(isEdit ? "Черновик сохранён" : "Кампания создана");
      if (!isEdit) {
        navigate(`/w/${slug}/campaigns/${saved.id}`);
      }
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(MISSING_NAME_COPY);
      return;
    }
    setNameError(null);

    if (!segmentId) {
      setSegmentError(MISSING_SEGMENT_COPY);
      return;
    }
    setSegmentError(null);
    setServerError(null);

    saveMutation.mutate();
  }

  if (isEdit && campaignQuery.isLoading) {
    return (
      <div className="space-y-6 p-8">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">{isEdit ? "Изменить кампанию" : "Создать кампанию"}</h1>
        <p className="text-sm text-muted-foreground">
          Разовая email-рассылка через SendGrid Dynamic Templates по выбранному сегменту.
        </p>
      </div>

      {isEdit && !isDraft ? (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-700">
            Кампания не в статусе «Черновик» — редактирование, запуск, планирование и прогресс отправки доступны
            на детальной странице кампании.
          </CardContent>
        </Card>
      ) : null}

      <div className="max-w-sm space-y-2">
        <Label htmlFor="campaign-name">Название кампании</Label>
        <Input
          id="campaign-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например, «Летняя распродажа»"
          disabled={isEdit && !isDraft}
        />
        {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Аудитория</CardTitle>
          <CardDescription>Сегмент, на который будет отправлена рассылка.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <fieldset disabled={isEdit && !isDraft} className="space-y-2">
            <SegmentPicker slug={slug} value={segmentId} onChange={setSegmentId} />
          </fieldset>
          {segmentError ? <p className="text-sm text-destructive">{segmentError}</p> : null}
          <p className="text-sm text-muted-foreground">
            Точная оценка охвата аудитории появится на странице кампании после сохранения черновика.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Шаблон и отправитель</CardTitle>
          <CardDescription>SendGrid Dynamic Template и верифицированный отправитель для рассылки.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <fieldset disabled={isEdit && !isDraft} className="space-y-6">
            <TemplatePicker slug={slug} value={templateId} onChange={setTemplateId} />
            <SenderPicker slug={slug} value={fromSenderId} onChange={setFromSenderId} />
          </fieldset>
        </CardContent>
      </Card>

      {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saveMutation.isPending || (isEdit && !isDraft)}>
          {saveMutation.isPending ? "Сохраняем…" : "Сохранить черновик"}
        </Button>
      </div>
    </div>
  );
}

export default CampaignBuilderPage;
