import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { registerSchema, type RegisterInput } from "@mega-crm/shared-schemas";
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

/**
 * D-14: registration is followed by a separate onboarding step
 * (create-workspace) — a freshly registered user never has a workspace yet.
 */
export default function RegisterPage() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: RegisterInput) {
    setServerError(null);
    const { error } = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
    });

    if (error) {
      // better-auth's core USER_ALREADY_EXISTS message; see 01-UI-SPEC.md Error states.
      if (error.message?.toLowerCase().includes("already exists")) {
        setServerError("Аккаунт с этим email уже существует. Войдите или восстановите пароль.");
      } else {
        setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
      }
      return;
    }

    navigate("/create-workspace");
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Регистрация</CardTitle>
          <CardDescription>Создайте аккаунт, чтобы начать работу с Mega CRM.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
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
              {serverError ? (
                <p className="text-sm font-medium text-destructive">{serverError}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Регистрируем…" : "Зарегистрироваться"}
              </Button>
            </form>
          </Form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Уже есть аккаунт?{" "}
            <Link to="/login" className="text-primary underline-offset-4 hover:underline">
              Войти
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
