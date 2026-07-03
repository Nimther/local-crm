import { useState } from "react";

import { Badge } from "@/components/ui/badge";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
};

export type MemberRowData =
  | {
      kind: "member";
      id: string;
      userId: string;
      name: string;
      email: string;
      role: string;
      isSelf: boolean;
    }
  | {
      kind: "invite";
      id: string;
      email: string;
      role: string;
    };

interface MemberRowProps {
  row: MemberRowData;
  /** D-17/D-18: the signed-in viewer's role in this workspace -- controls which actions render at all (hidden, not disabled, per UI-SPEC). */
  viewerRole: string;
  onRoleChange: (memberId: string, role: string) => void;
  onRemove: (memberId: string, name: string) => void;
  onRevoke: (invitationId: string, email: string) => void;
  onResend: (invitationId: string) => void;
  resendingId?: string | null;
}

/** A single team-page row: either a member (name/email/role select/remove) or a pending invite (email/role/revoke/resend). */
export function MemberRow({
  row,
  viewerRole,
  onRoleChange,
  onRemove,
  onRevoke,
  onResend,
  resendingId,
}: MemberRowProps) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const viewerIsOwner = viewerRole === "owner";
  const viewerCanManage = viewerRole === "owner" || viewerRole === "admin";

  if (row.kind === "invite") {
    return (
      <TableRow>
        <TableCell className="font-medium">{row.email}</TableCell>
        <TableCell>{ROLE_LABELS[row.role] ?? row.role}</TableCell>
        <TableCell>
          <Badge variant="secondary">Приглашение отправлено</Badge>
        </TableCell>
        <TableCell className="text-right">
          {viewerCanManage ? (
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resendingId === row.id}
                onClick={() => onResend(row.id)}
              >
                {resendingId === row.id ? "Отправляем…" : "Отправить повторно"}
              </Button>
              <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="text-destructive">
                    Отозвать
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Отозвать приглашение для {row.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Ссылка из письма перестанет работать. Приглашение можно отправить заново.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Отмена</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => onRevoke(row.id, row.email)}
                    >
                      Отозвать
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}
        </TableCell>
      </TableRow>
    );
  }

  // D-18: Admin/Owner controls are hidden entirely for a Member viewer, and
  // hidden for an Admin viewer looking at another Admin/Owner row (only the
  // Owner may touch those) -- never merely disabled, per the UI-SPEC.
  const targetIsOwnerOrAdmin = row.role === "owner" || row.role === "admin";
  const canManageThisRow = viewerCanManage && !row.isSelf && (viewerIsOwner || !targetIsOwnerOrAdmin);

  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="text-muted-foreground">{row.email}</TableCell>
      <TableCell>
        {canManageThisRow ? (
          <Select value={row.role} onValueChange={(value) => onRoleChange(row.id, value)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Участник</SelectItem>
              {viewerIsOwner ? <SelectItem value="admin">Администратор</SelectItem> : null}
              {viewerIsOwner ? <SelectItem value="owner">Владелец</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="secondary">{ROLE_LABELS[row.role] ?? row.role}</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        {canManageThisRow ? (
          <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="text-destructive">
                Удалить
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Удалить {row.name} из воркспейса?</AlertDialogTitle>
                <AlertDialogDescription>
                  Участник потеряет доступ ко всем данным воркспейса. Его можно пригласить снова.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Отмена</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => onRemove(row.id, row.name)}
                >
                  Удалить участника
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export default MemberRow;
