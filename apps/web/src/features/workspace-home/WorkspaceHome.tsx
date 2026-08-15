import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import { apiGet } from "@/lib/api";
import type { WorkspaceResponse } from "@mega-crm/shared-schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { OnboardingChecklist } from "@/features/onboarding/OnboardingChecklist";

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
};

/** Renders live server data (workspace name + role) fetched via TanStack Query. */
export function WorkspaceHome() {
  const { slug } = useParams<{ slug: string }>();

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // OPS-17/D-11: split the previously-conflated isLoading/!data branch --
  // a failed fetch is Retry-able (QueryErrorState); a successful fetch that
  // legitimately found no workspace is a fact, not a failure (EmptyState).
  if (isError) {
    return (
      <div className="p-8">
        <QueryErrorState title="Не удалось загрузить воркспейс" isFetching={isFetching} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8">
        <EmptyState title="Воркспейс не найден" />
      </div>
    );
  }

  const roleLabel = ROLE_LABELS[data.role] ?? data.role;

  return (
    <div className="space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-display flex items-center gap-3">
            {data.name}
            <Badge variant="secondary" className="align-middle text-sm font-medium">
              {roleLabel}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Ваш воркспейс: <span className="font-mono">/w/{data.slug}</span>
        </CardContent>
      </Card>
      <OnboardingChecklist slug={data.slug} />
    </div>
  );
}

export default WorkspaceHome;
