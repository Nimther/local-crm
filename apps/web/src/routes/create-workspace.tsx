import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { createWorkspaceSchema, type CreateWorkspaceInput, type WorkspaceResponse } from "@mega-crm/shared-schemas";
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

/** D-14/D-16: dedicated onboarding step; on success navigates to /w/{slug}. */
export default function CreateWorkspacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<CreateWorkspaceInput>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CreateWorkspaceInput) {
    setServerError(null);
    try {
      const workspace = await apiPost<WorkspaceResponse>("/api/workspaces", values);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      navigate(`/w/${workspace.slug}`);
    } catch {
      setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background pt-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-display">Создание воркспейса</CardTitle>
          <CardDescription>Воркспейс — это пространство вашей команды в Mega CRM.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Название воркспейса</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme" autoComplete="organization" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {serverError ? (
                <p className="text-sm font-medium text-destructive">{serverError}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Создаём…" : "Создать воркспейс"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
