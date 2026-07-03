import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { authClient } from "@/lib/authClient";
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

const resetPasswordSchema = z.object({
  password: z.string().min(8, "Пароль должен быть не короче 8 символов").max(128),
});
type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * D-03: consumes the token from the platform reset email's link
 * (`${WEB_URL}/reset-password?token=...`, built server-side in auth.ts)
 * directly via the query string -- no server-rendered redirect hop.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: ResetPasswordInput) {
    setServerError(null);
    if (!token) {
      setServerError("Ссылка для сброса пароля недействительна. Запросите новую.");
      return;
    }

    const { error } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });

    if (error) {
      setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
      return;
    }

    navigate("/login");
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Новый пароль</CardTitle>
          <CardDescription>Задайте новый пароль для вашего аккаунта.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="password"
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
              {serverError ? (
                <p className="text-sm font-medium text-destructive">{serverError}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Сохраняем…" : "Сохранить новый пароль"}
              </Button>
            </form>
          </Form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to="/login" className="text-primary underline-offset-4 hover:underline">
              Вернуться ко входу
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
