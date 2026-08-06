import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Building2, ChevronsUpDown, Plus } from "lucide-react";

import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

/** D-13: multi-workspace switcher, active workspace highlighted, «Создать воркспейс» item. */
export function WorkspaceSwitcher({ activeSlug }: { activeSlug: string }) {
  const navigate = useNavigate();

  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    // D-20: /api/workspaces (not better-auth's own organization.list) so a
    // soft-deleted workspace never reappears in the switcher.
    queryFn: () => apiGet<WorkspaceSummary[]>("/api/workspaces"),
  });

  const active = workspaces.find((w) => w.slug === activeSlug);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex w-full items-center justify-between gap-2 px-2"
        >
          <span className="flex items-center gap-2 overflow-hidden">
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-xs">
                {(active?.name ?? activeSlug).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-sm font-medium">
              {active?.name ?? activeSlug}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Воркспейсы</DropdownMenuLabel>
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            className={cn(
              "gap-2",
              workspace.slug === activeSlug && "bg-accent text-primary"
            )}
            onSelect={() => void navigate(`/w/${workspace.slug}`)}
          >
            <Building2 className="h-4 w-4" />
            <span className="truncate">{workspace.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2" onSelect={() => void navigate("/create-workspace")}>
          <Plus className="h-4 w-4" />
          Создать воркспейс
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
