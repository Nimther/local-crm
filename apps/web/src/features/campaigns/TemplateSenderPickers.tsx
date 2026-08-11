import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listCampaignSenders, listCampaignTemplates } from "@/features/campaigns/api";

const TEMPLATE_EMPTY_COPY =
  "Шаблоны не найдены — создайте Dynamic Template в SendGrid или введите template_id вручную.";
const SENDER_EMPTY_COPY = "Нет верифицированных отправителей — подтвердите адрес в SendGrid, затем обновите список.";

/**
 * D-16: template picker (Phase-3 popover+command combobox reused verbatim)
 * fed by GET /campaigns/sendgrid/templates, with an «Обновить список»
 * refetch button and a manual `template_id` text-input fallback for tenants
 * whose Dynamic Templates don't (yet) surface via the list.
 */
export function TemplatePicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | null;
  onChange: (templateId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const templatesQuery = useQuery({
    queryKey: ["workspace", slug, "campaign-templates"],
    queryFn: () => listCampaignTemplates(slug),
    enabled: Boolean(slug),
  });

  const templates = templatesQuery.data?.templates ?? [];
  const selected = templates.find((t) => t.id === value);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="space-y-2">
      <Label>Шаблон письма</Label>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" aria-expanded={open} className="w-72 justify-start">
              {selected ? selected.name : value || "Выберите шаблон"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command>
              <CommandInput placeholder="Поиск шаблона…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">{TEMPLATE_EMPTY_COPY}</p>
                </CommandEmpty>
                <CommandGroup heading="Dynamic Templates">
                  {templates.map((template) => (
                    <CommandItem
                      key={template.id}
                      value={`${template.name} ${template.id}`}
                      onSelect={() => choose(template.id)}
                    >
                      {template.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="outline"
          onClick={() => void templatesQuery.refetch()}
          disabled={templatesQuery.isFetching}
        >
          <RefreshCw className={templatesQuery.isFetching ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
          Обновить список
        </Button>
      </div>
      {!templatesQuery.isLoading && templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{TEMPLATE_EMPTY_COPY}</p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="template-id-manual" className="text-sm text-muted-foreground">
          Или введите template_id вручную
        </Label>
        <Input
          id="template-id-manual"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
          placeholder="d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />
      </div>
    </div>
  );
}

/**
 * D-17: verified-sender picker fed by GET /campaigns/sendgrid/senders (only
 * senders SendGrid itself has verified) -- no manual fallback, matching
 * D-17's "verified only" scope.
 */
export function SenderPicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | null;
  onChange: (fromSenderId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const sendersQuery = useQuery({
    queryKey: ["workspace", slug, "campaign-senders"],
    queryFn: () => listCampaignSenders(slug),
    enabled: Boolean(slug),
  });

  const senders = sendersQuery.data?.senders ?? [];
  const selected = senders.find((s) => String(s.id) === value);

  function choose(id: number) {
    onChange(String(id));
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="space-y-2">
      <Label>Отправитель</Label>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" aria-expanded={open} className="w-72 justify-start">
              {selected ? selected.nickname ?? selected.fromEmail : "Выберите отправителя"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command>
              <CommandInput placeholder="Поиск отправителя…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">{SENDER_EMPTY_COPY}</p>
                </CommandEmpty>
                <CommandGroup heading="Верифицированные отправители">
                  {senders.map((sender) => (
                    <CommandItem
                      key={sender.id}
                      value={`${sender.nickname ?? ""} ${sender.fromEmail}`}
                      onSelect={() => choose(sender.id)}
                    >
                      {sender.nickname ? `${sender.nickname} <${sender.fromEmail}>` : sender.fromEmail}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="outline"
          onClick={() => void sendersQuery.refetch()}
          disabled={sendersQuery.isFetching}
        >
          <RefreshCw className={sendersQuery.isFetching ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
          Обновить список
        </Button>
      </div>
      {!sendersQuery.isLoading && senders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{SENDER_EMPTY_COPY}</p>
      ) : null}
    </div>
  );
}
