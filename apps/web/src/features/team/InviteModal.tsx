import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";

import { inviteSchema, type InviteInput, type InviteResponse } from "@mega-crm/shared-schemas";
import { ApiError, apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** D-10/D-11: invite-by-email dialog, with a copyable fallback link shown after a successful send. */
export function InviteModal({ slug, canInviteAdmin }: { slug: string; canInviteAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  });

  const inviteMutation = useMutation({
    mutationFn: (values: InviteInput) => apiPost<InviteResponse>(`/api/workspaces/${slug}/invites`, values),
    onSuccess: (invite) => {
      setSent(invite);
      setServerError(null);
      queryClient.invalidateQueries({ queryKey: ["workspace", slug, "invites"] });
      toast.success("Приглашение отправлено");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiError && typeof error.message === "string" && error.message
          ? error.message
          : "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
      setServerError(message);
    },
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setSent(null);
      setCopied(false);
      setServerError(null);
      form.reset({ email: "", role: "member" });
    }
  }

  async function onSubmit(values: InviteInput) {
    await inviteMutation.mutateAsync(values);
  }

  async function handleCopy() {
    if (!sent) return;
    await navigator.clipboard.writeText(sent.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>Пригласить коллегу</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Пригласить коллегу</DialogTitle>
          <DialogDescription>Коллега получит письмо со ссылкой для входа в воркспейс.</DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Письмо отправлено на <span className="font-medium text-foreground">{sent.email}</span>. Если письмо не
              дошло, отправьте эту ссылку напрямую:
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={sent.inviteUrl} className="font-mono text-sm" />
              <Button type="button" variant="outline" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="mr-1 h-4 w-4" />
                    Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-4 w-4" />
                    Скопировать ссылку
                  </>
                )}
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Готово
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Роль</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="member">Участник</SelectItem>
                        {canInviteAdmin ? <SelectItem value="admin">Администратор</SelectItem> : null}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
              <DialogFooter>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? "Отправляем…" : "Отправить приглашение"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default InviteModal;
