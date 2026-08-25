import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router";
import { loginSchema, type LoginInput } from "@mega-crm/shared-schemas";
import { authClient, useSession } from "@/lib/authClient";
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
 * Maps a sign-in failure to user-facing copy BY THE SHAPE OF THE FAILURE
 * (debug session `auth-session-lifecycle`).
 *
 * This used to be a blanket `if (error)` -> "wrong email or password", which
 * reported every failure as bad credentials — including the 429 the auth
 * rate-limit bucket returns. Users whose credentials were perfectly correct
 * were told their password was wrong. The server has always exposed the
 * discriminator this reads: a genuine credential failure is 401 with
 * `code: "INVALID_EMAIL_OR_PASSWORD"`, while a throttle is a 429 carrying no
 * better-auth code at all (pinned by
 * apps/api/src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts).
 *
 * Only the credential shape may blame the credentials; nothing else mentions
 * them.
 */
function signInErrorMessage(error: { status?: number; code?: string }): string {
  if (error.status === 401 || error.code === "INVALID_EMAIL_OR_PASSWORD") {
    return "Неверный email или пароль. Проверьте данные и попробуйте ещё раз.";
  }
  if (error.status === 429) {
    return "Слишком много попыток входа. Подождите минуту и войдите снова.";
  }
  return "Не удалось выполнить вход — сервис недоступен. Попробуйте позже.";
}

export default function LoginPage() {
  const { refetch: refetchSession } = useSession();
  const [serverError, setServerError] = useState<string | null>(null);
  const [awaitingSession, setAwaitingSession] = useState(false);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (error) {
      setServerError(signInErrorMessage(error));
      return;
    }

    // Deliberately NO navigate() here. The credentials are accepted, but the
    // auth client's session store does not hold the new session yet — it
    // refreshes itself on a deferred signal — so navigating to "/" now made
    // RootRedirect read the store's retained logged-out value and bounce
    // straight back here (the "the page just reloaded" symptom).
    //
    // Instead: ask the store to refresh, and let the RequireAnonymous guard
    // around this route perform the redirect the moment the store actually
    // HOLDS the session. Gated on the data being present, never on elapsed
    // time — and asking explicitly rather than relying on the auth client's
    // own deferred signal, so a successful sign-in can never be a silent
    // no-op. `awaitingSession` keeps the button in its pending state for the
    // gap until the guard takes over, so a successful submit can never look
    // submittable again (no double submit).
    setAwaitingSession(true);
    void refetchSession();
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Вход</CardTitle>
          <CardDescription>Войдите в свой аккаунт Mega CRM.</CardDescription>
        </CardHeader>
        <CardContent>
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
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Пароль</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {serverError ? (
                <p className="text-sm font-medium text-destructive">{serverError}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={isSubmitting || awaitingSession}>
                {isSubmitting || awaitingSession ? "Входим…" : "Войти"}
              </Button>
            </form>
          </Form>
          <div className="mt-4 flex flex-col items-center gap-2 text-sm text-muted-foreground">
            {/* 01-03 builds the /reset page itself; the link target 404s until then. */}
            <Link to="/reset" className="text-primary underline-offset-4 hover:underline">
              Забыли пароль?
            </Link>
            <p>
              Нет аккаунта?{" "}
              <Link to="/register" className="text-primary underline-offset-4 hover:underline">
                Зарегистрироваться
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
