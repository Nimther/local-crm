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
import {
  classifySendError,
  CONFLICT_REFRESH_NOTICE,
  illegalTransitionCopy,
  VERSION_CONFLICT_COPY,
  type SendConflictKind,
} from "@/features/campaigns/campaignSendConflict";
import { useCampaignDirtyState } from "@/features/campaigns/CampaignDirtyStateContext";

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
  // TMPL-02/D-08/D-09: which recoverable 409 kind (if any) the last attempt
  // hit. The message itself is composed at RENDER time from the live
  // `campaign` prop below, not captured here -- the invalidation this
  // triggers has already refreshed it by the time it renders.
  const [conflict, setConflict] = useState<SendConflictKind | null>(null);

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
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
      toast.success("Кампания отправлена");
      onOpenChange(false);
    },
    onError: async (err) => {
      const kind = classifySendError(err);
      if (kind) {
        // D-08/D-09: the dialog stays OPEN and the mutation is never
        // re-invoked here -- only the marketer's next click may resend
        // (T-20-06-01). The refetch below is what makes the live
        // `campaign.status` read in the render below the fresh one.
        setServerError(null);
        setConflict(kind);
        await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
        toast(CONFLICT_REFRESH_NOTICE);
        return;
      }
      setConflict(null);
      setServerError(GENERIC_ERROR);
    },
  });

  // D-09: read from the LIVE campaign prop, not a value captured when the
  // error arrived -- the invalidation above has already refreshed it.
  const conflictMessage =
    conflict === "version_conflict"
      ? VERSION_CONFLICT_COPY
      : conflict === "illegal_transition"
        ? illegalTransitionCopy(campaign.status)
        : null;
  const errorMessage = conflictMessage ?? serverError;

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

        {errorMessage ? <p className="text-sm font-medium text-destructive">{errorMessage}</p> : null}

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
  // TMPL-02/D-08/D-09: same shape as LaunchConfirmDialog's -- rendered from
  // the live `campaign` prop below, never captured at error time.
  const [conflict, setConflict] = useState<SendConflictKind | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const scheduleMutation = useMutation({
    // TMPL-02/D-06: echo back the version this dialog is displaying -- the
    // schedule route now requires it and compares it under lock, the same
    // uniform precondition contract launchMutation uses.
    mutationFn: (scheduledAt: string) =>
      scheduleCampaign(slug, campaign.id, { scheduledAt, expectedVersion: campaign.version }),
    onSuccess: async () => {
      setServerError(null);
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
      toast.success("Кампания запланирована");
      handleOpenChange(false);
    },
    onError: async (err) => {
      const kind = classifySendError(err);
      if (kind) {
        // D-08/D-09: stays open, never re-invokes the mutation -- only a
        // fresh click may resend (T-20-06-01).
        setServerError(null);
        setConflict(kind);
        await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
        toast(CONFLICT_REFRESH_NOTICE);
        return;
      }
      setConflict(null);
      setServerError(GENERIC_ERROR);
    },
  });

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setValue("");
      setDateError(null);
      setServerError(null);
      setConflict(null);
    }
  }

  // D-09: read from the LIVE campaign prop -- the invalidation above has
  // already refreshed it by the time this renders.
  const conflictMessage =
    conflict === "version_conflict"
      ? VERSION_CONFLICT_COPY
      : conflict === "illegal_transition"
        ? illegalTransitionCopy(campaign.status)
        : null;
  const errorMessage = conflictMessage ?? serverError;

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
    setConflict(null);
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

        {errorMessage ? <p className="text-sm font-medium text-destructive">{errorMessage}</p> : null}

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

  // TMPL-01/D-01/D-02: the dirty gate composes with the existing
  // completeness/permission gates (any one disables the action); when both
  // an incomplete-field reason and the dirty reason apply, the incomplete
  // reason wins and is the ONLY line shown -- one line, one element, never
  // both stacked.
  const { isDirty, blockReason: dirtyBlockReason } = useCampaignDirtyState();
  const incompleteReason = computeIncompleteReason(campaign);
  const reason = incompleteReason ?? dirtyBlockReason;
  const disabled = !canLaunch || Boolean(incompleteReason) || isDirty;

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

      {reason ? <p className="text-sm text-destructive">{reason}</p> : null}

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
