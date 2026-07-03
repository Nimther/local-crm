import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";

import { queryClient } from "@/lib/queryClient";
import { useSession } from "@/lib/authClient";
import { apiGet } from "@/lib/api";
import type { WorkspaceListItem } from "@mega-crm/shared-schemas";
import { Toaster } from "@/components/ui/sonner";
import RegisterPage from "@/routes/register";
import LoginPage from "@/routes/login";
import CreateWorkspacePage from "@/routes/create-workspace";
import ResetRequestPage from "@/routes/reset-request";
import ResetPasswordPage from "@/routes/reset-password";
import InviteAcceptPage from "@/routes/invite-accept";
import { AppShell } from "@/features/app-shell/AppShell";
import { WorkspaceHome } from "@/features/workspace-home/WorkspaceHome";
import ProfilePage from "@/features/profile/ProfilePage";
import TeamPage from "@/features/team/TeamPage";
import SendGridKeySettings from "@/features/sendgrid-key/SendGridKeySettings";

/**
 * Resolves "/" for a signed-in user: no workspace yet -> /create-workspace
 * (D-14); has a workspace -> the first one at /w/{slug}. Signed-out users
 * fall through to /login.
 */
function RootRedirect() {
  const { data: session, isPending: sessionPending } = useSession();

  const { data: workspaces, isPending: workspacesPending } = useQuery({
    queryKey: ["workspaces"],
    // D-20: /api/workspaces (not better-auth's own organization.list) so a
    // soft-deleted workspace never gets redirected into.
    queryFn: () => apiGet<WorkspaceListItem[]>("/api/workspaces"),
    enabled: Boolean(session),
  });

  if (sessionPending || (session && workspacesPending)) {
    return null;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!workspaces || workspaces.length === 0) {
    return <Navigate to="/create-workspace" replace />;
  }

  return <Navigate to={`/w/${workspaces[0].slug}`} replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/create-workspace" element={<CreateWorkspacePage />} />
          <Route path="/reset" element={<ResetRequestPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/invite/:invitationId" element={<InviteAcceptPage />} />
          <Route path="/w/:slug" element={<AppShell />}>
            <Route index element={<WorkspaceHome />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings/sendgrid" element={<SendGridKeySettings />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
