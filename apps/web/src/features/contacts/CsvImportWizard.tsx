import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Download } from "lucide-react";

import type {
  CsvDryRunSummary,
  CsvImportStatus,
  CsvUploadResponse,
  DuplicatePolicy,
  PropertyRegistryItem,
} from "@mega-crm/shared-schemas";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TimezoneCombobox } from "./TimezoneCombobox";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const WRONG_TYPE_ERROR = "Не удалось прочитать файл. Загрузите CSV в кодировке UTF-8 или Windows-1251.";
const TOO_LARGE_ERROR =
  "Файл превышает допустимый размер. Разделите его на несколько файлов меньшего размера и загрузите по очереди.";
// Client-side pre-check only -- mirrors csv-import.routes.ts's UPLOAD_MAX_BYTES; the server remains authoritative.
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const SKIP_VALUE = "__skip__";
const CREATE_VALUE = "__create__";

const STANDARD_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "externalId", label: "External ID" },
  { value: "email", label: "Email" },
  { value: "firstName", label: "Имя" },
  { value: "lastName", label: "Фамилия" },
  { value: "phone", label: "Телефон" },
  { value: "city", label: "Город" },
  { value: "country", label: "Страна" },
  { value: "timezone", label: "Часовой пояс" },
  { value: "tags", label: "Теги (через запятую)" },
  { value: "subscriptionStatus", label: "Статус подписки" },
];

type WizardStep = "upload" | "mapping" | "dryrun" | "applying";

function extractErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (typeof body?.error === "string") return body.error;
  }
  return fallback;
}

/** Best-effort header->field guess so the mapping step isn't blank by default; every guess remains user-editable. */
function guessTarget(header: string): string {
  const normalized = header.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const guesses: Record<string, string> = {
    external_id: "externalId",
    externalid: "externalId",
    email: "email",
    e_mail: "email",
    first_name: "firstName",
    firstname: "firstName",
    last_name: "lastName",
    lastname: "lastName",
    phone: "phone",
    city: "city",
    country: "country",
    timezone: "timezone",
    time_zone: "timezone",
    tz: "timezone",
    tags: "tags",
    subscription_status: "subscriptionStatus",
  };
  return guesses[normalized] ?? SKIP_VALUE;
}

/** Multipart upload -- deliberately NOT apiPost (JSON-only): a dedicated fetch with credentials included. */
async function uploadCsvFile(slug: string, file: File): Promise<CsvUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`/api/workspaces/${slug}/imports`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const contentType = res.headers.get("content-type") ?? "";
  // res.json() is `any`; `unknown` keeps the narrowing below honest.
  const body: unknown = contentType.includes("application/json")
    ? await res.json()
    : undefined;
  if (!res.ok) {
    const message = (body as { error?: string } | undefined)?.error;
    throw new ApiError(res.status, message ?? `Request failed: ${res.status}`, body);
  }
  return body as CsvUploadResponse;
}

function StatCard({ label, value, destructive }: { label: string; value: number; destructive?: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("text-display font-semibold", destructive ? "text-destructive" : undefined)}>{value}</p>
      </CardContent>
    </Card>
  );
}

/** Step 1 (D-15/D-19 context): styled dropzone-style file input + wrong-type/too-large client-side guard. */
function UploadStep({ slug, onUploaded }: { slug: string; onUploaded: (upload: CsvUploadResponse) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (f: File) => uploadCsvFile(slug, f),
    onSuccess: (data) => {
      setLocalError(null);
      onUploaded(data);
    },
    onError: (error: unknown) => {
      setLocalError(extractErrorMessage(error, WRONG_TYPE_ERROR));
    },
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setLocalError(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (!/\.csv$/i.test(selected.name)) {
      setLocalError(WRONG_TYPE_ERROR);
      setFile(null);
      return;
    }
    if (selected.size > UPLOAD_MAX_BYTES) {
      setLocalError(TOO_LARGE_ERROR);
      setFile(null);
      return;
    }
    setFile(selected);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Импорт контактов из CSV</CardTitle>
        <CardDescription>Загрузите CSV-файл с контактами — на следующем шаге вы сопоставите колонки.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 rounded-md border border-dashed p-6 text-center">
          <Input type="file" accept=".csv,text/csv" onChange={handleFileChange} />
          {file ? <p className="text-sm text-muted-foreground">Выбран файл: {file.name}</p> : null}
        </div>
        {localError ? <p className="text-sm font-medium text-destructive">{localError}</p> : null}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => file && uploadMutation.mutate(file)} disabled={!file || uploadMutation.isPending}>
          {uploadMutation.isPending ? "Загружаем…" : "Загрузить файл"}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface MappingRowState {
  header: string;
  target: string;
  newPropertyName: string;
}

/** Step 2 (D-15/D-19): per-column target select incl. «Создать новое свойство…» + duplicate policy + «Проверить файл». */
function MappingStep({
  slug,
  upload,
  onDryRun,
}: {
  slug: string;
  upload: CsvUploadResponse;
  onDryRun: (mapping: Record<string, string>, duplicatePolicy: DuplicatePolicy, summary: CsvDryRunSummary) => void;
}) {
  const registryQuery = useQuery({
    queryKey: ["workspace", slug, "property-registry"],
    queryFn: () => apiGet<PropertyRegistryItem[]>(`/api/workspaces/${slug}/property-registry`),
    enabled: Boolean(slug),
  });

  const [rows, setRows] = useState<MappingRowState[]>(() =>
    upload.headers.map((header) => ({ header, target: guessTarget(header), newPropertyName: "" }))
  );
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("update");
  const [defaultTimezone, setDefaultTimezone] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const registry = registryQuery.data ?? [];

  function updateRow(header: string, patch: Partial<MappingRowState>) {
    setRows((prev) => prev.map((row) => (row.header === header ? { ...row, ...patch } : row)));
  }

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const mapping: Record<string, string> = {};
      for (const row of rows) {
        if (row.target === SKIP_VALUE) continue;
        if (row.target === CREATE_VALUE) {
          const name = row.newPropertyName.trim();
          if (!name) continue;
          mapping[row.header] = name;
        } else {
          mapping[row.header] = row.target;
        }
      }
      const summary = await apiPost<CsvDryRunSummary>(`/api/workspaces/${slug}/imports/${upload.importId}/dry-run`, {
        mapping,
        duplicatePolicy,
        ...(defaultTimezone ? { defaultTimezone } : {}),
      });
      return { mapping, summary };
    },
    onSuccess: ({ mapping, summary }) => {
      setServerError(null);
      onDryRun(mapping, duplicatePolicy, summary);
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Сопоставление колонок</CardTitle>
        <CardDescription>
          Файл содержит {upload.totalRows} строк — сопоставьте колонки файла с полями контакта.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.header} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <div className="w-40 shrink-0">
                <p className="text-sm font-medium">{row.header}</p>
                <p className="truncate text-xs text-muted-foreground">{upload.previewRows[0]?.[row.header] ?? "—"}</p>
              </div>
              <Select value={row.target} onValueChange={(value) => updateRow(row.header, { target: value })}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SKIP_VALUE}>Не импортировать</SelectItem>
                  {STANDARD_FIELD_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                  {registry.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.key}
                    </SelectItem>
                  ))}
                  <SelectItem value={CREATE_VALUE}>Создать новое свойство…</SelectItem>
                </SelectContent>
              </Select>
              {row.target === CREATE_VALUE ? (
                <Input
                  placeholder="Название нового свойства"
                  value={row.newPropertyName}
                  onChange={(e) => updateRow(row.header, { newPropertyName: e.target.value })}
                  className="w-56"
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label>Если контакт уже существует</Label>
          <RadioGroup value={duplicatePolicy} onValueChange={(value) => setDuplicatePolicy(value as DuplicatePolicy)}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="update" id="duplicate-update" />
              <Label htmlFor="duplicate-update" className="font-normal">
                Обновить существующий контакт
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="skip" id="duplicate-skip" />
              <Label htmlFor="duplicate-skip" className="font-normal">
                Пропустить существующий контакт
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label>Часовой пояс по умолчанию</Label>
          <p className="text-xs text-muted-foreground">
            Применяется к импортируемым строкам, у которых нет собственного значения часового пояса.
          </p>
          <div className="max-w-xs">
            <TimezoneCombobox value={defaultTimezone} onChange={setDefaultTimezone} />
          </div>
        </div>

        {upload.previewRows.length > 0 ? (
          <div className="space-y-2">
            <Label>Предпросмотр строк</Label>
            <Table>
              <TableHeader>
                <TableRow>
                  {upload.headers.map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {upload.previewRows.slice(0, 20).map((r, idx) => (
                  <TableRow key={idx}>
                    {upload.headers.map((h) => (
                      <TableCell key={h}>{r[h] ?? ""}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => dryRunMutation.mutate()} disabled={dryRunMutation.isPending}>
          {dryRunMutation.isPending ? "Проверяем…" : "Проверить файл"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Step 3 (D-17): three Display-sized stat cards; «Применить импорт» is a deliberate, separate action. */
function DryRunSummaryStep({
  slug,
  importId,
  summary,
  onApplied,
}: {
  slug: string;
  importId: string;
  summary: CsvDryRunSummary;
  onApplied: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);

  const applyMutation = useMutation({
    mutationFn: () => apiPost(`/api/workspaces/${slug}/imports/${importId}/apply`, {}),
    onSuccess: () => {
      setServerError(null);
      toast.success("Импорт запущен");
      onApplied();
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Результат проверки файла</CardTitle>
        <CardDescription>
          Ничего ещё не записано — контакты будут созданы или обновлены только после подтверждения.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Будет создано" value={summary.willCreate} />
          <StatCard label="Будет обновлено" value={summary.willUpdate} />
          <StatCard label="Ошибок" value={summary.errorCount} destructive={summary.errorCount > 0} />
        </div>
        {summary.errorCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            {summary.errorCount} строк с ошибками — их можно скачать, исправить и загрузить повторно.
          </p>
        ) : null}
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending}>
          {applyMutation.isPending ? "Применяем…" : "Применить импорт"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * Step 4/5 (D-16/D-18): determinate progress bar polled via refetchInterval
 * -- safe to navigate away from and re-enter (this exact component is also
 * used by the history re-entry view below). Flips to the completion report
 * (counts + error-CSV download) once the status route reports done/failed.
 */
function ApplyProgressAndReport({ slug, importId }: { slug: string; importId: string }) {
  const toastFiredRef = useRef(false);

  const statusQuery = useQuery({
    queryKey: ["workspace", slug, "imports", importId],
    queryFn: () => apiGet<CsvImportStatus>(`/api/workspaces/${slug}/imports/${importId}`),
    refetchInterval: (query) => (query.state.data?.status === "applying" ? 1500 : false),
  });

  const status = statusQuery.data;

  useEffect(() => {
    if (status && (status.status === "done" || status.status === "failed") && !toastFiredRef.current) {
      toastFiredRef.current = true;
      toast.success("Импорт завершён");
    }
  }, [status]);

  if (!status) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Загружаем статус импорта…</CardContent>
      </Card>
    );
  }

  const isDone = status.status === "done" || status.status === "failed";

  if (!isDone) {
    const percent =
      status.totalRows > 0 ? Math.min(100, Math.round((status.processedRows / status.totalRows) * 100)) : 0;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Импорт выполняется
            <Badge variant="outline">Выполняется</Badge>
          </CardTitle>
          <CardDescription>
            Обработано {status.processedRows} из {status.totalRows} строк. Можно уйти со страницы — прогресс
            сохранится, и вы сможете вернуться к нему из истории импортов.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={percent} />
        </CardContent>
      </Card>
    );
  }

  const summary = status.summary ?? {};
  const errorCount = summary.errorCount ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          {status.status === "failed" ? "Импорт завершился с ошибкой" : "Импорт завершён"}
          <Badge
            variant="outline"
            className={
              status.status === "failed"
                ? "border-transparent bg-destructive/10 text-destructive"
                : "border-transparent bg-green-50 text-green-600"
            }
          >
            {status.status === "failed" ? "Ошибка" : "Готово"}
          </Badge>
        </CardTitle>
        <CardDescription>Файл «{status.fileName}» обработан.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Создано" value={summary.created ?? 0} />
          <StatCard label="Обновлено" value={summary.updated ?? 0} />
          {status.duplicatePolicy === "skip" ? <StatCard label="Пропущено" value={summary.skipped ?? 0} /> : null}
          <StatCard label="Ошибок" value={errorCount} destructive={errorCount > 0} />
        </div>
        {errorCount > 0 ? (
          <Button asChild variant="outline">
            <a href={`/api/workspaces/${slug}/imports/${importId}/errors`} download>
              <Download className="mr-2 h-4 w-4" />
              Скачать CSV с ошибками
            </a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Re-entry from history (D-16): resolves current status and jumps straight into progress/report, no mapping replay. */
function ImportReentryView({ slug, importId }: { slug: string; importId: string }) {
  const navigate = useNavigate();

  const statusQuery = useQuery({
    queryKey: ["workspace", slug, "imports", importId],
    queryFn: () => apiGet<CsvImportStatus>(`/api/workspaces/${slug}/imports/${importId}`),
  });

  const status = statusQuery.data;

  if (statusQuery.isLoading || !status) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Загружаем статус импорта…</CardContent>
      </Card>
    );
  }

  if (status.status === "applying" || status.status === "done" || status.status === "failed") {
    return <ApplyProgressAndReport slug={slug} importId={importId} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Импорт ещё не запущен</CardTitle>
        <CardDescription>
          Этот импорт ещё не был применён. Начните новый импорт, чтобы загрузить и сопоставить файл заново.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button type="button" onClick={() => void navigate(`/w/${slug}/contacts/import`)}>
          Загрузить файл
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * CSV import wizard (CONT-02, D-15..D-19): upload -> mapping -> dry-run
 * summary -> apply/progress -> report. When mounted with an `:id` param
 * (from CsvImportHistory), skips straight to the pollable progress/report
 * re-entry view (D-16) instead of replaying upload/mapping.
 */
export function CsvImportWizard() {
  const { slug = "", id } = useParams<{ slug: string; id?: string }>();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<WizardStep>("upload");
  const [upload, setUpload] = useState<CsvUploadResponse | null>(null);
  const [dryRunSummary, setDryRunSummary] = useState<CsvDryRunSummary | null>(null);

  function invalidateHistory() {
    return queryClient.invalidateQueries({ queryKey: ["workspace", slug, "imports"] });
  }

  if (id) {
    return (
      <div className="space-y-6 p-8">
        <div>
          <h1 className="text-display font-semibold">Импорт CSV</h1>
        </div>
        <ImportReentryView slug={slug} importId={id} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">Импорт CSV</h1>
        <p className="text-sm text-muted-foreground">Импортируйте контакты из CSV-файла.</p>
      </div>

      {step === "upload" ? (
        <UploadStep
          slug={slug}
          onUploaded={(data) => {
            setUpload(data);
            setStep("mapping");
            void invalidateHistory();
          }}
        />
      ) : null}

      {step === "mapping" && upload ? (
        <MappingStep
          slug={slug}
          upload={upload}
          onDryRun={(_mapping, _duplicatePolicy, summary) => {
            setDryRunSummary(summary);
            setStep("dryrun");
          }}
        />
      ) : null}

      {step === "dryrun" && upload && dryRunSummary ? (
        <DryRunSummaryStep
          slug={slug}
          importId={upload.importId}
          summary={dryRunSummary}
          onApplied={() => {
            setStep("applying");
            void invalidateHistory();
          }}
        />
      ) : null}

      {step === "applying" && upload ? <ApplyProgressAndReport slug={slug} importId={upload.importId} /> : null}
    </div>
  );
}

export default CsvImportWizard;
