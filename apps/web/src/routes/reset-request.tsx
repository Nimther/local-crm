import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router";
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

const resetRequestSchema = z.object({
  email: z.string().trim().min(1, "Email обязателен").email("Введите корректный email"),
});
type ResetRequestInput = z.infer<typeof resetRequestSchema>;

/**
 * D-03: password-reset request. Always shows a generic success message
 * regardless of whether the email exists (T-01-11, no account enumeration).
 */
export default function ResetRequestPage() {
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<ResetRequestInput>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: ResetRequestInput) {
    await authClient.requestPasswordReset({
      email: values.email,
      redirectTo: `${window.location.origin}/login`,
    });
    setSubmitted(true);
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Восстановление пароля</CardTitle>
          <CardDescription>Укажите email, привязанный к вашему аккаунту.</CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <p className="text-sm text-muted-foreground">
              Если такой аккаунт существует, мы отправили письмо со ссылкой для сброса пароля.
            </p>
          ) : (
            <Form {...form}>
              <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
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
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Отправляем…" : "Отправить ссылку для сброса"}
                </Button>
              </form>
            </Form>
          )}
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
