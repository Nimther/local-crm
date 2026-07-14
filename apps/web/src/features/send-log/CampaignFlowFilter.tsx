import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "@mega-crm/shared-schemas";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { listCampaigns } from "@/features/campaigns/api";
import { listFlows } from "@/features/flows/api";
import { resolveSendTargetLabel, type SendTarget } from "./send-log-filters";

/**
 * 07-10 (gap closure, UAT Test 1): persistent «Кампания / цепочка» selector
 * for the send-log toolbar -- rendered unconditionally (unlike the deep-link
 * chips) so it survives «Сбросить фильтры» and lets the user re-apply a
 * campaign/flow filter from within the page. Modeled verbatim on
 * TimezoneCombobox.tsx's Popover+Command combobox structure.
 */
export function CampaignFlowFilter({
  slug,
  campaignId,
  flowId,
  onSelect,
}: {
  slug: string;
  campaignId: string | undefined;
  flowId: string | undefined;
  onSelect: (target: SendTarget | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const campaignsQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", "exhaustive-lookup"],
    queryFn: () => listCampaigns(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug),
  });
  const flowsQuery = useQuery({
    queryKey: ["workspace", slug, "flows", "exhaustive-lookup"],
    queryFn: () => listFlows(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug),
  });

  const campaigns = (campaignsQuery.data?.items ?? []).map((c) => ({ id: c.id, name: c.name }));
  const flows = (flowsQuery.data?.items ?? []).map((f) => ({ id: f.id, name: f.name }));

  const resolved = resolveSendTargetLabel(campaignId, flowId, campaigns, flows);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-expanded={open} className="justify-between font-normal">
          <span className={cn("max-w-40 truncate", !resolved && "text-muted-foreground")}>
            {resolved ? resolved.label : "Кампания / цепочка"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск кампании или цепочки…" />
          <CommandList>
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {campaignId || flowId ? (
              <CommandGroup heading="Действия">
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                >
                  Очистить
                </CommandItem>
              </CommandGroup>
            ) : null}
            {campaigns.length > 0 ? (
              <CommandGroup heading="Кампании">
                {campaigns.map((campaign) => (
                  <CommandItem
                    key={campaign.id}
                    value={campaign.name}
                    onSelect={() => {
                      onSelect({ kind: "campaign", id: campaign.id });
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", campaignId === campaign.id ? "opacity-100" : "opacity-0")} />
                    {campaign.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {flows.length > 0 ? (
              <CommandGroup heading="Цепочки">
                {flows.map((flow) => (
                  <CommandItem
                    key={flow.id}
                    value={flow.name}
                    onSelect={() => {
                      onSelect({ kind: "flow", id: flow.id });
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", flowId === flow.id ? "opacity-100" : "opacity-0")} />
                    {flow.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default CampaignFlowFilter;
