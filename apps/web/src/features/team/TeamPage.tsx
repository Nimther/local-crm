import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "sonner";

import type { WorkspaceResponse } from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useSession } from "@/lib/authClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InviteModal } from "@/features/team/InviteModal";
import { MemberRow, type MemberRowData } from "@/features/team/MemberRow";
import { DeleteWorkspaceDialog } from "@/features/team/DeleteWorkspaceDialog";

interface MemberListItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface InviteListItem {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  inviteUrl: string;
}

/** Team page (TENANT-02/03): member table + pending-invite rows, role-gated actions (D-17/D-18). */
export function TeamPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });

  const membersQuery = useQuery({
    queryKey: ["workspace", slug, "members"],
    queryFn: () => apiGet<MemberListItem[]>(`/api/workspaces/${slug}/members`),
    enabled: Boolean(slug),
  });

  const invitesQuery = useQuery({
    queryKey: ["workspace", slug, "invites"],
    queryFn: () => apiGet<InviteListItem[]>(`/api/workspaces/${slug}/invites`),
    enabled: Boolean(slug),
  });

  function invalidateTeam() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace", slug, "members"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace", slug, "invites"] }),
    ]);
  }

  const roleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      apiPost(`/api/workspaces/${slug}/members/${memberId}/role`, { role }),
    onSuccess: () => {
      toast.success("Роль изменена");
      void invalidateTeam();
    },
    onError: () => {
      toast.error("Не удалось изменить роль. Попробуйте ещё раз.");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => apiDelete(`/api/workspaces/${slug}/members/${memberId}`),
    onSuccess: () => {
      toast.success("Участник удалён");
      void invalidateTeam();
    },
    onError: () => {
      toast.error("Не удалось удалить участника. Попробуйте ещё раз.");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) =>
      apiPost(`/api/workspaces/${slug}/invites/${invitationId}/revoke`, {}),
    onSuccess: () => {
      toast.success("Приглашение отозвано");
      void invalidateTeam();
    },
    onError: () => {
      toast.error("Не удалось отозвать приглашение. Попробуйте ещё раз.");
    },
  });

  const resendMutation = useMutation({
    mutationFn: (invitationId: string) =>
      apiPost(`/api/workspaces/${slug}/invites/${invitationId}/resend`, {}),
    onSuccess: () => {
      toast.success("Приглашение отправлено");
      void invalidateTeam();
    },
    onError: () => {
      toast.error("Не удалось отправить приглашение повторно.");
    },
  });

  if (workspaceQuery.isLoading || membersQuery.isLoading || invitesQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const viewerRole = workspaceQuery.data?.role ?? "member";
  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const isEmpty = members.length <= 1 && invites.length === 0;

  // OPS-17/D-11: the roster table below merges membersQuery and
  // invitesQuery into one `rows` array -- a failure on either with no
  // prior data means the roster cannot be honestly assembled, so both
  // queries gate the same region-level QueryErrorState rather than
  // rendering a partial/misleading table.
  const isFullyErrored =
    (membersQuery.isError && !membersQuery.data) || (invitesQuery.isError && !invitesQuery.data);
  const isStaleErrored =
    !isFullyErrored &&
    ((membersQuery.isError && Boolean(membersQuery.data)) || (invitesQuery.isError && Boolean(invitesQuery.data)));

  const rows: MemberRowData[] = [
    ...members.map<MemberRowData>((m) => ({
      kind: "member" as const,
      id: m.id,
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      isSelf: m.userId === session?.user.id,
    })),
    ...invites.map<MemberRowData>((inv) => ({
      kind: "invite" as const,
      id: inv.id,
      email: inv.email,
      role: inv.role,
    })),
  ];

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Команда</h1>
          <p className="text-sm text-muted-foreground">Участники и приглашения воркспейса.</p>
        </div>
        {canManage ? <InviteModal slug={slug} canInviteAdmin={viewerRole === "owner"} /> : null}
      </div>

      {isFullyErrored ? (
        <QueryErrorState
          title="Не удалось загрузить команду"
          isFetching={membersQuery.isFetching || invitesQuery.isFetching}
          onRetry={() => {
            void membersQuery.refetch();
            void invitesQuery.refetch();
          }}
        />
      ) : (
        <div className="space-y-6">
          {isStaleErrored ? (
            <QueryErrorState
              title="Не удалось обновить команду"
              detail="Показаны последние загруженные данные."
              isFetching={membersQuery.isFetching || invitesQuery.isFetching}
              onRetry={() => {
                void membersQuery.refetch();
                void invitesQuery.refetch();
              }}
            />
          ) : null}
          {isEmpty ? (
            <EmptyState
              title="В воркспейсе пока только вы"
              description="Пригласите коллег — они получат письмо со ссылкой для входа."
              action={canManage ? <InviteModal slug={slug} canInviteAdmin={viewerRole === "owner"} /> : undefined}
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Имя</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Роль</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <MemberRow
                        key={`${row.kind}-${row.id}`}
                        row={row}
                        viewerRole={viewerRole}
                        onRoleChange={(memberId, role) => roleMutation.mutate({ memberId, role })}
                        onRemove={(memberId) => removeMutation.mutate(memberId)}
                        onRevoke={(invitationId) => revokeMutation.mutate(invitationId)}
                        onResend={(invitationId) => resendMutation.mutate(invitationId)}
                        resendingId={resendMutation.isPending ? (resendMutation.variables ?? null) : null}
                      />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {viewerRole === "owner" && workspaceQuery.data ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Опасная зона</CardTitle>
            <CardDescription>Удаление воркспейса необратимо.</CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteWorkspaceDialog slug={slug} workspaceName={workspaceQuery.data.name} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default TeamPage;
