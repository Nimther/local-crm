import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";

import { registerFromInviteSchema, type InvitePreview, type RegisterFromInviteInput } from "@mega-crm/shared-schemas";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { useSession } from "@/lib/authClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
};

function InviteMessageCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{children}</CardContent>
      </Card>
    </div>
  );
}

/**
 * D-10/D-11/D-12: resolves the invitation via the PUBLIC preview endpoint
 * (works before the invitee has any account/session), then renders one of
 * valid/expired/revoked/already-member, offering either
 * «Присоединиться к воркспейсу» (existing account, signed in with a
 * matching email) or «Создать аккаунт и присоединиться» (register-from-invite,
 * D-12 -- email pre-filled and locked to the invitation).
 */
export default function InviteAcceptPage() {
  const { invitationId = "" } = useParams<{ invitationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending } = useSession();
  const [serverError, setServerError] = useState<string | null>(null);

  const previewQuery = useQuery({
    queryKey: ["invite-preview", invitationId],
    queryFn: () => apiGet<InvitePreview>(`/api/invites/${invitationId}`),
    enabled: Boolean(invitationId),
    retry: false,
  });

  const registerForm = useForm<RegisterFromInviteInput>({
    resolver: zodResolver(registerFromInviteSchema),
    defaultValues: { name: "", password: "" },
  });

  async function goToWorkspace() {
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    if (previewQuery.data) {
      void navigate(`/w/${previewQuery.data.organizationSlug}`, { replace: true });
    }
  }

  const acceptMutation = useMutation({
    mutationFn: () => apiPost(`/api/invites/${invitationId}/accept`, {}),
    onSuccess: goToWorkspace,
    onError: () => {
      setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
    },
  });

  const registerMutation = useMutation({
    mutationFn: (values: RegisterFromInviteInput) => apiPost(`/api/invites/${invitationId}/register`, values),
    onSuccess: goToWorkspace,
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        setServerError("Аккаунт с этим email уже существует. Войдите или восстановите пароль.");
      } else {
        setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
      }
    },
  });

  if (previewQuery.isLoading || sessionPending) {
    return (
      <div className="flex min-h-screen items-start justify-center bg-background pt-12">
        <Card className="w-full max-w-sm">
          <CardContent className="space-y-4 p-8">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <InviteMessageCard title="Приглашение не найдено">
        Проверьте ссылку или попросите администратора воркспейса отправить приглашение заново.
      </InviteMessageCard>
    );
  }

  const preview = previewQuery.data;

  if (preview.status === "expired") {
    return (
      <InviteMessageCard title="Приглашение истекло">
        Срок действия приглашения истёк. Попросите администратора воркспейса отправить его заново.
      </InviteMessageCard>
    );
  }

  if (preview.status === "revoked") {
    return (
      <InviteMessageCard title="Приглашение недействительно">
        Это приглашение больше не действует. Попросите администратора воркспейса отправить новое.
      </InviteMessageCard>
    );
  }

  if (preview.status === "accepted") {
    return (
      <InviteMessageCard title="Приглашение уже принято">
        Это приглашение уже использовано.{" "}
        <Link to={`/w/${preview.organizationSlug}`} className="text-primary underline-offset-4 hover:underline">
          Перейти в воркспейс
        </Link>
      </InviteMessageCard>
    );
  }

  const signedInAsInvitee = Boolean(session && session.user.email.toLowerCase() === preview.email.toLowerCase());

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Приглашение в «{preview.organizationName}»</CardTitle>
          <CardDescription>
            Роль: {ROLE_LABELS[preview.role] ?? preview.role} · {preview.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {session ? (
            signedInAsInvitee ? (
              <>
                {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
                <Button
                  type="button"
                  className="w-full"
                  disabled={acceptMutation.isPending}
                  onClick={() => acceptMutation.mutate()}
                >
                  {acceptMutation.isPending ? "Присоединяемся…" : "Присоединиться к воркспейсу"}
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Это приглашение отправлено на {preview.email}, а вы вошли как {session.user.email}. Войдите под
                нужным аккаунтом, чтобы принять приглашение.
              </p>
            )
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Email: <span className="font-medium text-foreground">{preview.email}</span>
              </p>
              <Form {...registerForm}>
                <form
                  onSubmit={(e) => void registerForm.handleSubmit((values) => registerMutation.mutate(values))(e)}
                  className="space-y-4"
                >
                  <FormField
                    control={registerForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Имя</FormLabel>
                        <FormControl>
                          <Input placeholder="Ваше имя" autoComplete="name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={registerForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Пароль</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
                  <Button type="submit" className="w-full" disabled={registerForm.formState.isSubmitting}>
                    {registerForm.formState.isSubmitting ? "Создаём аккаунт…" : "Создать аккаунт и присоединиться"}
                  </Button>
                </form>
              </Form>
              <p className="text-center text-sm text-muted-foreground">
                Уже есть аккаунт?{" "}
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Войти
                </Link>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
