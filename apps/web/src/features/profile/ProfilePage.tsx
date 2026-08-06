import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { useSession } from "@/lib/authClient";
import { apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const nameSchema = z.object({
  name: z.string().trim().min(1, "Имя обязательно").max(120),
});
type NameInput = z.infer<typeof nameSchema>;

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Введите текущий пароль"),
  newPassword: z.string().min(8, "Пароль должен быть не короче 8 символов").max(128),
});
type PasswordInput = z.infer<typeof passwordSchema>;

/**
 * D-24 v1 scope: display name + change password only. No email-change or
 * avatar control here by design -- those are deferred to v2.
 */
export default function ProfilePage() {
  const { data: session, refetch } = useSession();
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const nameForm = useForm<NameInput>({
    resolver: zodResolver(nameSchema),
    values: { name: session?.user.name ?? "" },
  });

  const passwordForm = useForm<PasswordInput>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "" },
  });

  async function onSubmitName(values: NameInput) {
    setNameError(null);
    try {
      await apiPost("/api/profile/name", values);
      await refetch();
      toast.success("Имя изменено");
    } catch {
      setNameError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
    }
  }

  async function onSubmitPassword(values: PasswordInput) {
    setPasswordError(null);
    try {
      await apiPost("/api/profile/password", values);
      passwordForm.reset({ currentPassword: "", newPassword: "" });
      toast.success("Пароль изменён");
    } catch {
      setPasswordError("Неверный текущий пароль. Проверьте данные и попробуйте ещё раз.");
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-display">Профиль</CardTitle>
          <CardDescription>Отображаемое имя видят участники ваших воркспейсов.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...nameForm}>
            <form onSubmit={(e) => void nameForm.handleSubmit(onSubmitName)(e)} className="space-y-4">
              <FormField
                control={nameForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Имя</FormLabel>
                    <FormControl>
                      <Input autoComplete="name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {nameError ? <p className="text-sm font-medium text-destructive">{nameError}</p> : null}
              <Button type="submit" disabled={nameForm.formState.isSubmitting}>
                {nameForm.formState.isSubmitting ? "Сохраняем…" : "Сохранить имя"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Смена пароля</CardTitle>
          <CardDescription>Введите текущий пароль, чтобы задать новый.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...passwordForm}>
            <form onSubmit={(e) => void passwordForm.handleSubmit(onSubmitPassword)(e)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Текущий пароль</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Новый пароль</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {passwordError ? (
                <p className="text-sm font-medium text-destructive">{passwordError}</p>
              ) : null}
              <Button type="submit" disabled={passwordForm.formState.isSubmitting}>
                {passwordForm.formState.isSubmitting ? "Меняем…" : "Сменить пароль"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
