import { lazy, Suspense, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createBrowserRouter, createRoutesFromElements, Route, Navigate, RouterProvider } from "react-router";

import { queryClient } from "@/lib/queryClient";
import { useSession } from "@/lib/authClient";
import { apiGet } from "@/lib/api";
import type { WorkspaceListItem } from "@mega-crm/shared-schemas";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/features/app-shell/AppShell";
import { RouteSuspenseFallback } from "@/components/RouteSuspenseFallback";

// D-14 (OPS-16): every feature/route page is lazily loaded, uniformly, with
// no per-route eager/lazy judgement calls. RootRedirect, AppShell and the
// queryClient/useSession/apiGet imports above stay eager -- they are shell,
// not feature code.
const RegisterPage = lazy(() => import("@/routes/register"));
const LoginPage = lazy(() => import("@/routes/login"));
const CreateWorkspacePage = lazy(() => import("@/routes/create-workspace"));
const ResetRequestPage = lazy(() => import("@/routes/reset-request"));
const ResetPasswordPage = lazy(() => import("@/routes/reset-password"));
const InviteAcceptPage = lazy(() => import("@/routes/invite-accept"));
const WorkspaceDashboard = lazy(() => import("@/features/dashboard/WorkspaceDashboard"));
const ProfilePage = lazy(() => import("@/features/profile/ProfilePage"));
const TeamPage = lazy(() => import("@/features/team/TeamPage"));
const SendGridKeySettings = lazy(() => import("@/features/sendgrid-key/SendGridKeySettings"));
const ApiKeysSettings = lazy(() => import("@/features/api-keys/ApiKeysSettings"));
const ContactsListPage = lazy(() => import("@/features/contacts/ContactsListPage"));
const ContactDetailPage = lazy(() => import("@/features/contacts/ContactDetailPage"));
const CsvImportWizard = lazy(() => import("@/features/contacts/CsvImportWizard"));
const CsvImportHistory = lazy(() => import("@/features/contacts/CsvImportHistory"));
const SegmentsListPage = lazy(() => import("@/features/segments/SegmentsListPage"));
const SegmentCreatePage = lazy(() => import("@/features/segments/SegmentCreatePage"));
const SegmentDetailPage = lazy(() => import("@/features/segments/SegmentDetailPage"));
const CampaignsListPage = lazy(() => import("@/features/campaigns/CampaignsListPage"));
const CampaignBuilderPage = lazy(() => import("@/features/campaigns/CampaignBuilderPage"));
const CampaignDetailPage = lazy(() => import("@/features/campaigns/CampaignDetailPage"));
const SendSettingsPage = lazy(() => import("@/features/campaigns/SendSettingsPage"));
const FlowsListPage = lazy(() => import("@/features/flows/list/FlowsListPage"));
const FlowDetailPage = lazy(() => import("@/features/flows/detail/FlowDetailPage"));
const SendLogPage = lazy(() => import("@/features/send-log/SendLogPage"));

/** Wraps a lazily-loaded route element in the shared route-level Suspense fallback. */
function withSuspense(element: ReactNode) {
  return <Suspense fallback={<RouteSuspenseFallback />}>{element}</Suspense>;
}

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

// Pattern 2 (RESEARCH.md, Pitfall 1): the data-router migration is the hard
// prerequisite for plan 15-09's useBlocker -- useBlocker throws under the
// declarative <BrowserRouter> tree. The <Route> JSX tree itself is
// unchanged in shape/nesting/paths from the previous <Routes> form.
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/register" element={withSuspense(<RegisterPage />)} />
      <Route path="/login" element={withSuspense(<LoginPage />)} />
      <Route path="/create-workspace" element={withSuspense(<CreateWorkspacePage />)} />
      <Route path="/reset" element={withSuspense(<ResetRequestPage />)} />
      <Route path="/reset-password" element={withSuspense(<ResetPasswordPage />)} />
      <Route path="/invite/:invitationId" element={withSuspense(<InviteAcceptPage />)} />
      <Route path="/w/:slug" element={<AppShell />}>
        <Route index element={withSuspense(<WorkspaceDashboard />)} />
        <Route path="contacts" element={withSuspense(<ContactsListPage />)} />
        <Route path="contacts/imports" element={withSuspense(<CsvImportHistory />)} />
        <Route path="contacts/import" element={withSuspense(<CsvImportWizard />)} />
        <Route path="contacts/import/:id" element={withSuspense(<CsvImportWizard />)} />
        <Route path="contacts/:id" element={withSuspense(<ContactDetailPage />)} />
        <Route path="segments" element={withSuspense(<SegmentsListPage />)} />
        <Route path="segments/new" element={withSuspense(<SegmentCreatePage />)} />
        <Route path="segments/:id" element={withSuspense(<SegmentDetailPage />)} />
        <Route path="campaigns" element={withSuspense(<CampaignsListPage />)} />
        <Route path="campaigns/new" element={withSuspense(<CampaignBuilderPage />)} />
        <Route path="campaigns/:id" element={withSuspense(<CampaignDetailPage />)} />
        <Route path="flows" element={withSuspense(<FlowsListPage />)} />
        <Route path="flows/:id" element={withSuspense(<FlowDetailPage />)} />
        <Route path="send-log" element={withSuspense(<SendLogPage />)} />
        <Route path="team" element={withSuspense(<TeamPage />)} />
        <Route path="profile" element={withSuspense(<ProfilePage />)} />
        <Route path="settings/sendgrid" element={withSuspense(<SendGridKeySettings />)} />
        <Route path="settings/api-keys" element={withSuspense(<ApiKeysSettings />)} />
        <Route path="settings/sending" element={withSuspense(<SendSettingsPage />)} />
      </Route>
    </>
  )
);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
