import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The full IANA zone allowlist, sourced live from the runtime -- NEVER a
 * hardcoded list. Falls back to an empty list (rather than throwing) on a
 * runtime without `Intl.supportedValuesOf` (T-06-11-03: a free-text input is
 * never an acceptable fallback either way).
 */
const TIMEZONE_OPTIONS: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/**
 * Searchable command+popover combobox for an IANA timezone (06-UI-SPEC:
 * contact form + CSV mapping's standard-field target, workspace send
 * settings' default timezone) -- same interaction as the segment/template
 * pickers (Phase 3). Deliberately never a bare free-text input: this is the
 * client-side half of T-06-11-03's mitigation (the server independently
 * re-validates against `Intl.supportedValuesOf('timeZone')` too, 06-07).
 */
export function TimezoneCombobox({
  value,
  onChange,
  placeholder = "Выберите часовой пояс",
}: {
  value: string | null | undefined;
  onChange: (timezone: string | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-expanded={open} className="w-full justify-between font-normal">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск часового пояса…" />
          <CommandList>
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {value ? (
              <CommandGroup heading="Действия">
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  Очистить
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Часовые пояса">
              {TIMEZONE_OPTIONS.map((tz) => (
                <CommandItem
                  key={tz}
                  value={tz}
                  onSelect={() => {
                    onChange(tz);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === tz ? "opacity-100" : "opacity-0")} />
                  {tz}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default TimezoneCombobox;
