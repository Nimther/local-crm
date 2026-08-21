import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  cancelCampaign,
  getCampaignAudienceBreakdown,
  launchCampaign,
  scheduleCampaign,
  type CampaignResponse,
} from "@/features/campaigns/api";
import { AudienceBreakdown } from "@/features/campaigns/AudienceBreakdown";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const MEMBER_TOOLTIP = "Только Owner или Admin может запускать кампании.";
const PAST_DATE_ERROR = "Выберите дату и время в будущем";

function campaignsQueryKey(slug: string) {
  return ["workspace", slug, "campaigns"];
}

/**
 * D-04: launch-confirm dialog — fetches the audience breakdown while open,
 * shows the Display-size sendable count + non-zero exclusions before ever
 * calling launchCampaign. Primary indigo action, not destructive (sending is
 * the expected main action, per 04-UI-SPEC's destructive-confirmations table).
 */
export function LaunchConfirmDialog({
  slug,
  campaign,
  open,
  onOpenChange,
}: {
  slug: string;
  campaign: CampaignResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const breakdownQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", campaign.id, "audience-breakdown"],
    queryFn: () => getCampaignAudienceBreakdown(slug, campaign.id),
    enabled: open,
  });

  const launchMutation = useMutation({
    // TMPL-02/D-06: echo back the version this dialog is displaying -- the
    // launch route now requires it and compares it under lock.
    mutationFn: () => launchCampaign(slug, campaign.id, { expectedVersion: campaign.version }),
    onSuccess: async () => {
      setServerError(null);
      await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
      toast.success("Кампания отправлена");
      onOpenChange(false);
    },
    onError: () => setServerError(GENERIC_ERROR),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Отправить кампанию «{campaign.name}» сейчас?</DialogTitle>
          <DialogDescription>Будет отправлено письмо каждому подходящему получателю сегмента.</DialogDescription>
        </DialogHeader>

        {breakdownQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : breakdownQuery.data ? (
          <AudienceBreakdown data={breakdownQuery.data} />
        ) : null}

        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            type="button"
            disabled={launchMutation.isPending || breakdownQuery.isLoading}
            onClick={() => launchMutation.mutate()}
          >
            {launchMutation.isPending ? "Отправляем…" : "Отправить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-06: schedule dialog — native datetime-local input, timezone caption
 * derived from Intl.DateTimeFormat().resolvedOptions().timeZone, past-date
 * inline error, and the local value converted to a UTC ISO string
 * (`new Date(value).toISOString()`) before scheduleCampaign ever sees it.
 */
export function ScheduleDialog({
  slug,
  campaign,
  open,
  onOpenChange,
}: {
  slug: string;
  campaign: CampaignResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const scheduleMutation = useMutation({
    mutationFn: (scheduledAt: string) => scheduleCampaign(slug, campaign.id, { scheduledAt }),
    onSuccess: async () => {
      setServerError(null);
      await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
      toast.success("Кампания запланирована");
      handleOpenChange(false);
    },
    onError: () => setServerError(GENERIC_ERROR),
  });

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setValue("");
      setDateError(null);
      setServerError(null);
    }
  }

  function handleConfirm() {
    if (!value) {
      setDateError(PAST_DATE_ERROR);
      return;
    }
    const local = new Date(value);
    if (Number.isNaN(local.getTime()) || local.getTime() <= Date.now()) {
      setDateError(PAST_DATE_ERROR);
      return;
    }
    setDateError(null);
    setServerError(null);
    scheduleMutation.mutate(local.toISOString());
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Запланировать «{campaign.name}»</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="scheduled-at">Дата и время отправки</Label>
          <Input
            id="scheduled-at"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="text-sm text-muted-foreground">Время указано в вашем часовом поясе ({timezone})</p>
          {dateError ? <p className="text-sm text-destructive">{dateError}</p> : null}
        </div>

        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" disabled={scheduleMutation.isPending} onClick={handleConfirm}>
            {scheduleMutation.isPending ? "Планируем…" : "Запланировать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-07/D-09: one AlertDialog covering both cancel semantics, selected by the
 * campaign's current status — «Остановить отправку» (red-600, D-09,
 * irreversible) while sending, «Отменить запланированную отправку» (default
 * button, reversible, returns to draft) while scheduled.
 */
export function CancelDialog({
  slug,
  campaign,
  open,
  onOpenChange,
}: {
  slug: string;
  campaign: CampaignResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isSending = campaign.status === "sending";

  const cancelMutation = useMutation({
    mutationFn: () => cancelCampaign(slug, campaign.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
      toast.success(isSending ? "Отправка остановлена" : "Кампания отменена");
      onOpenChange(false);
    },
    onError: () => toast.error(GENERIC_ERROR),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isSending
              ? `Остановить отправку кампании «${campaign.name}»?`
              : `Отменить запланированную отправку «${campaign.name}»?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isSending
              ? "Оставшиеся письма отправлены не будут. Уже отправленные письма отозвать нельзя. Кампания перейдёт в статус «Отменена» с итоговым числом отправленных писем."
              : "Кампания вернётся в черновик. Вы сможете отредактировать её и запланировать заново."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{isSending ? "Продолжить отправку" : "Не отменять"}</AlertDialogCancel>
          <AlertDialogAction
            disabled={cancelMutation.isPending}
            className={isSending ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            onClick={(e) => {
              e.preventDefault();
              cancelMutation.mutate();
            }}
          >
            {isSending ? "Остановить отправку" : "Отменить кампанию"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** D-08: template+sender+audience completeness — sender is satisfied by fromSenderId OR fromEmail (04-05/STATE.md precedent). */
function computeIncompleteReason(campaign: CampaignResponse): string | null {
  if (!campaign.segmentId) return "Выберите сегмент-аудиторию";
  if (!campaign.templateId) return "Выберите шаблон письма";
  if (!campaign.fromSenderId && !campaign.fromEmail) return "Выберите отправителя";
  return null;
}

/**
 * CAMP-02/CAMP-03: the draft-view action row — a send-now/schedule
 * radio-group (Phase-2 pattern) plus a single primary button that opens the
 * matching dialog. Disabled with the Owner/Admin tooltip for Members
 * (T-04-08-01 defense-in-depth — the server route is the authoritative gate)
 * and with inline copy when template/sender/audience aren't all chosen yet.
 */
export function LaunchScheduleActions({
  slug,
  campaign,
  canLaunch,
}: {
  slug: string;
  campaign: CampaignResponse;
  canLaunch: boolean;
}) {
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const incompleteReason = computeIncompleteReason(campaign);
  const disabled = !canLaunch || Boolean(incompleteReason);

  return (
    <div className="space-y-3">
      <RadioGroup value={mode} onValueChange={(next) => setMode(next as "now" | "schedule")}>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="now" id="launch-mode-now" />
          <Label htmlFor="launch-mode-now" className="font-normal">
            Отправить сейчас
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="schedule" id="launch-mode-schedule" />
          <Label htmlFor="launch-mode-schedule" className="font-normal">
            Запланировать на дату и время
          </Label>
        </div>
      </RadioGroup>

      {incompleteReason ? <p className="text-sm text-destructive">{incompleteReason}</p> : null}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex">
              <Button
                type="button"
                disabled={disabled}
                onClick={() => (mode === "now" ? setConfirmOpen(true) : setScheduleOpen(true))}
              >
                {mode === "now" ? "Отправить сейчас" : "Запланировать"}
              </Button>
            </span>
          </TooltipTrigger>
          {!canLaunch ? <TooltipContent>{MEMBER_TOOLTIP}</TooltipContent> : null}
        </Tooltip>
      </TooltipProvider>

      <LaunchConfirmDialog slug={slug} campaign={campaign} open={confirmOpen} onOpenChange={setConfirmOpen} />
      <ScheduleDialog slug={slug} campaign={campaign} open={scheduleOpen} onOpenChange={setScheduleOpen} />
    </div>
  );
}
