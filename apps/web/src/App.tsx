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
import ApiKeysSettings from "@/features/api-keys/ApiKeysSettings";
import ContactsListPage from "@/features/contacts/ContactsListPage";
import ContactDetailPage from "@/features/contacts/ContactDetailPage";
import CsvImportWizard from "@/features/contacts/CsvImportWizard";
import CsvImportHistory from "@/features/contacts/CsvImportHistory";
import SegmentsListPage from "@/features/segments/SegmentsListPage";
import SegmentCreatePage from "@/features/segments/SegmentCreatePage";
import SegmentDetailPage from "@/features/segments/SegmentDetailPage";
import CampaignsListPage from "@/features/campaigns/CampaignsListPage";
import CampaignBuilderPage from "@/features/campaigns/CampaignBuilderPage";
import CampaignDetailPage from "@/features/campaigns/CampaignDetailPage";
import SendSettingsPage from "@/features/campaigns/SendSettingsPage";
import FlowsListPage from "@/features/flows/list/FlowsListPage";
import FlowDetailPage from "@/features/flows/detail/FlowDetailPage";

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
            <Route path="contacts" element={<ContactsListPage />} />
            <Route path="contacts/imports" element={<CsvImportHistory />} />
            <Route path="contacts/import" element={<CsvImportWizard />} />
            <Route path="contacts/import/:id" element={<CsvImportWizard />} />
            <Route path="contacts/:id" element={<ContactDetailPage />} />
            <Route path="segments" element={<SegmentsListPage />} />
            <Route path="segments/new" element={<SegmentCreatePage />} />
            <Route path="segments/:id" element={<SegmentDetailPage />} />
            <Route path="campaigns" element={<CampaignsListPage />} />
            <Route path="campaigns/new" element={<CampaignBuilderPage />} />
            <Route path="campaigns/:id" element={<CampaignDetailPage />} />
            <Route path="flows" element={<FlowsListPage />} />
            <Route path="flows/:id" element={<FlowDetailPage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings/sendgrid" element={<SendGridKeySettings />} />
            <Route path="settings/api-keys" element={<ApiKeysSettings />} />
            <Route path="settings/sending" element={<SendSettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
