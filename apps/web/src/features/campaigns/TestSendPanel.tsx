import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useSession } from "@/lib/authClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CONFLICT_REFRESH_NOTICE, VERSION_CONFLICT_COPY, classifySendError } from "@/features/campaigns/campaignSendConflict";
import { useCampaignDirtyState } from "@/features/campaigns/CampaignDirtyStateContext";
import { getCampaignTestSample, testSendCampaign, type CampaignResponse } from "@/features/campaigns/api";

const TEST_SEND_FAILURE =
  "Не удалось отправить тестовое письмо. Проверьте шаблон и отправителя, затем попробуйте снова.";
const INVALID_JSON_ERROR = "Некорректный JSON — исправьте синтаксис перед отправкой.";

/**
 * Phase 11 (D-11, plan 11-10): deliberately weaker than "отправлено". The
 * route (`POST .../test-send`) returns `202 { queued: true, to }` BEFORE the
 * SendGrid call happens — the actual send runs later in a BullMQ job
 * (`kind='test'`, `apps/worker/src/queues/send-dispatch.ts`). A timeout or
 * connection reset during that call produces an outcome this UI never
 * observes: `processSendJob` returns `SendJobResult`'s `{ outcome: "unknown" }`
 * variant, logged for an operator but never surfaced back to this panel (no
 * polling/result-callback surface exists, and building one is out of scope
 * here — see 11-10-PLAN.md's flagged assumption). Since this UI cannot tell
 * "queued" from "queued and ambiguously never confirmed" apart, the copy
 * below never claims delivery, and always carries D-11's guidance: check the
 * inbox before manually re-sending, because an outcome the platform could
 * not determine is never re-sent automatically.
 */
const TEST_SEND_QUEUED_DESCRIPTION =
  "Если письмо не появится в течение пары минут, проверьте папку «Спам» и повторите отправку вручную — при неопределённом исходе платформа не повторяет отправку автоматически.";

/**
 * CAMP-04/D-18/D-19: editable monospace JSON prefilled from
 * getCampaignTestSample — the server's own buildContactTemplateData sample
 * built from a real segment contact (documented D-18 contact-profile shape),
 * never a UI-invented placeholder object. `to` defaults to the current
 * user's own email.
 */
export function TestSendPanel({ slug, campaign }: { slug: string; campaign: CampaignResponse }) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  // TMPL-01/D-01/D-02: an unsaved form edit blocks test-send the same way it
  // blocks launch/schedule -- the test sample and dynamic_template_data
  // preview stay visible, only the send action itself is gated.
  const { isDirty, blockReason: dirtyBlockReason } = useCampaignDirtyState();
  const [to, setTo] = useState("");
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const sampleQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", campaign.id, "test-sample"],
    queryFn: () => getCampaignTestSample(slug, campaign.id),
  });

  useEffect(() => {
    if (sampleQuery.data) {
      setJson(JSON.stringify(sampleQuery.data.sample, null, 2));
    }
  }, [sampleQuery.data]);

  useEffect(() => {
    if (session?.user.email && !to) {
      setTo(session.user.email);
    }
  }, [session, to]);

  const testSendMutation = useMutation({
    mutationFn: (body: { to?: string; dynamicTemplateData?: Record<string, unknown> }) =>
      // TMPL-02/D-06/D-11: echo back the version this panel is displaying --
      // the route now requires it and compares it under lock, the same
      // uniform precondition contract launch/schedule use.
      testSendCampaign(slug, campaign.id, { ...body, expectedVersion: campaign.version }),
    onSuccess: (result) => {
      setServerError(null);
      // TMPL-02: the route may have persisted a resolved sender under the
      // lock and bumped the version -- without this the browser would keep
      // the pre-bump value and the marketer's next launch would 409
      // through no fault of their own. Safe against clobbering unsaved
      // edits: a dirty campaign form blocks test-send (plan 20-05).
      void queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns", campaign.id] });
      toast.success(`Тестовое письмо поставлено в очередь на ${result.to}`, {
        description: TEST_SEND_QUEUED_DESCRIPTION,
      });
    },
    onError: async (err) => {
      // TMPL-02/D-08/D-11: same classification and uniform copy the launch/
      // schedule dialogs use. `illegal_transition` is not reachable here --
      // test-send performs no status transition -- so it falls through to
      // the existing generic test-send failure copy rather than getting
      // invented copy. No retry option is added; the marketer's next click
      // is the only thing that may resend (T-20-06-01).
      const kind = classifySendError(err);
      if (kind === "version_conflict") {
        setServerError(VERSION_CONFLICT_COPY);
        await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns"] });
        toast(CONFLICT_REFRESH_NOTICE);
        return;
      }
      setServerError(TEST_SEND_FAILURE);
    },
  });

  function handleSend() {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = json.trim() ? (JSON.parse(json) as Record<string, unknown>) : undefined;
    } catch {
      setJsonError(INVALID_JSON_ERROR);
      return;
    }
    setJsonError(null);
    setServerError(null);
    testSendMutation.mutate({ to: to.trim() || undefined, dynamicTemplateData: parsed });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Тестовое письмо</CardTitle>
        <CardDescription>Отправьте письмо с этим шаблоном себе, чтобы проверить оформление.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-2">
          <Label htmlFor="test-send-to">Получатель</Label>
          <Input id="test-send-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-send-json">dynamic_template_data</Label>
          <p className="text-sm text-muted-foreground">
            Это пример данных реального контакта из сегмента кампании (включая его email) — письмо всё равно уйдёт на
            адрес, указанный в поле «Получатель» выше.
          </p>
          {sampleQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Textarea
              id="test-send-json"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              className="font-mono text-sm"
              rows={12}
            />
          )}
          {jsonError ? <p className="text-sm text-destructive">{jsonError}</p> : null}
        </div>

        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        {dirtyBlockReason ? <p className="text-sm text-destructive">{dirtyBlockReason}</p> : null}

        <Button type="button" onClick={handleSend} disabled={testSendMutation.isPending || isDirty}>
          {testSendMutation.isPending ? "Отправляем…" : "Отправить тестовое письмо"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default TestSendPanel;
