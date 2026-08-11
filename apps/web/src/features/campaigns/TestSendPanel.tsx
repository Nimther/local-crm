import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useSession } from "@/lib/authClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getCampaignTestSample, testSendCampaign, type CampaignResponse } from "@/features/campaigns/api";

const TEST_SEND_FAILURE =
  "Не удалось отправить тестовое письмо. Проверьте шаблон и отправителя, затем попробуйте снова.";
const INVALID_JSON_ERROR = "Некорректный JSON — исправьте синтаксис перед отправкой.";

/**
 * CAMP-04/D-18/D-19: editable monospace JSON prefilled from
 * getCampaignTestSample — the server's own buildContactTemplateData sample
 * built from a real segment contact (documented D-18 contact-profile shape),
 * never a UI-invented placeholder object. `to` defaults to the current
 * user's own email.
 */
export function TestSendPanel({ slug, campaign }: { slug: string; campaign: CampaignResponse }) {
  const { data: session } = useSession();
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
      testSendCampaign(slug, campaign.id, body),
    onSuccess: (result) => {
      setServerError(null);
      toast.success(`Тестовое письмо отправлено на ${result.to}`);
    },
    onError: () => setServerError(TEST_SEND_FAILURE),
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

        <Button type="button" onClick={handleSend} disabled={testSendMutation.isPending}>
          {testSendMutation.isPending ? "Отправляем…" : "Отправить тестовое письмо"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default TestSendPanel;
