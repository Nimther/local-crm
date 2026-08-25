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
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { QueryErrorState } from "@/components/QueryErrorState";

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

/**
 * Wraps a lazily-loaded route element in the shared route-level Suspense
 * fallback, itself wrapped by the route-level error boundary (OPS-17/D-11).
 * Ordering is load-bearing: `RouteErrorBoundary` MUST enclose `Suspense`,
 * not the reverse -- a failed lazy chunk import throws in a way only a
 * `componentDidCatch`-based boundary outside the Suspense can actually catch
 * (see `RouteErrorBoundary.tsx`'s own header comment). This wraps every
 * lazy route below UNIFORMLY (standalone auth/onboarding routes and every
 * route nested inside `/w/:slug`) -- `AppShell` and `RootRedirect` are
 * deliberately NOT passed through this helper, so the shell itself is never
 * wrapped by the same boundary as its children.
 */
function withSuspense(element: ReactNode) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteSuspenseFallback />}>{element}</Suspense>
    </RouteErrorBoundary>
  );
}

type SessionState = ReturnType<typeof useSession>;

/**
 * Collapses the auth client's session store into the only three states a
 * routing decision may be made from (debug session `auth-session-lifecycle`).
 *
 * The store's `data: null` conflates THREE different situations — never
 * fetched, fetched-and-logged-out, and fetch-failed — and reading it as a bare
 * boolean is the shared flaw behind both reported symptoms. A rate-limited
 * (429) `get-session` leaves `{ data: null, error, isPending: false }`, which
 * the old `if (!session)` read as "definitively signed out" and bounced a
 * still-authenticated user to /login; and the store's RETAINED logged-out
 * value made a just-succeeded sign-in look like a signed-out one.
 *
 * `unknown` therefore means "the session is not decided yet" — pending, in
 * flight, or the read failed — and must never be routed on. The one exception
 * is a 401: that is better-auth's definitive "this session is gone", so an
 * expired session still reaches the login form instead of a state that never
 * resolves.
 */
function resolveSessionStatus(session: SessionState): "authenticated" | "anonymous" | "unknown" {
  if (session.data) return "authenticated";
  if (session.error) return session.error.status === 401 ? "anonymous" : "unknown";
  if (session.isPending || session.isRefetching) return "unknown";
  return "anonymous";
}

/**
 * What to render while the session is `unknown`. Never the login page and
 * never a bare redirect — but never an unresolvable spinner either: a failed
 * session read (429 from the auth bucket, a 5xx, a dropped connection) gets an
 * explicit retry instead of a page that hangs.
 */
function SessionUnknownState({ session }: { session: SessionState }) {
  if (session.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <QueryErrorState
          title="Не удалось проверить сессию"
          detail="Попробуйте ещё раз — если ошибка повторится, обновите страницу."
          className="max-w-md"
          isFetching={session.isRefetching}
          onRetry={() => void session.refetch()}
        />
      </div>
    );
  }
  return <RouteSuspenseFallback />;
}

/**
 * Guards the routes that only make sense for a signed-out visitor. An
 * authenticated visitor is sent to "/" (which resolves on to their workspace),
 * and — per the debug session's Symptoms.expected — the login page is NOT
 * rendered while the session is still unknown.
 *
 * This is also what completes a successful sign-in: `login.tsx` deliberately
 * does not navigate itself (it cannot — the auth client's session store does
 * not hold the new session until its own refresh lands, so navigating on
 * `signIn.email()` resolving raced the store and bounced straight back here).
 * The single owner of the transition is this guard, and it fires only once the
 * store actually HOLDS the session.
 *
 * Scope note: only /login is guarded. /register and /reset are structurally
 * unguarded too, but they are not reachable into this defect — register.tsx
 * navigates to /create-workspace, not "/" — so they stay out of this fix.
 */
function RequireAnonymous({ children }: { children: ReactNode }) {
  const session = useSession();
  const status = resolveSessionStatus(session);

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }
  if (status === "unknown") {
    return <SessionUnknownState session={session} />;
  }
  return <>{children}</>;
}

/**
 * Resolves "/" for a signed-in user: no workspace yet -> /create-workspace
 * (D-14); has a workspace -> the first one at /w/{slug}. Signed-out users
 * fall through to /login.
 */
function RootRedirect() {
  const session = useSession();
  const sessionStatus = resolveSessionStatus(session);

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    // D-20: /api/workspaces (not better-auth's own organization.list) so a
    // soft-deleted workspace never gets redirected into.
    queryFn: () => apiGet<WorkspaceListItem[]>("/api/workspaces"),
    enabled: sessionStatus === "authenticated",
  });
  const { data: workspaces, isPending: workspacesPending, isError: workspacesIsError } = workspacesQuery;

  // An undecided session must not be routed on in either direction — that
  // conflation is what let a throttled/failed `get-session` masquerade as
  // "signed out" and send an authenticated user to the login form.
  if (sessionStatus === "unknown") {
    return <SessionUnknownState session={session} />;
  }

  if (sessionStatus === "anonymous") {
    return <Navigate to="/login" replace />;
  }

  if (workspacesPending) {
    return null;
  }

  // WR-01/OPS-17/D-11: a rejected fetch must not be treated as "no
  // workspace yet" -- that conflated shape would redirect an
  // already-signed-in user with real workspaces to /create-workspace on a
  // transient failure. Every sibling page in this phase's file set splits
  // isError from the empty-response case; this is the one root-level
  // router component that previously did not.
  if (workspacesIsError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <QueryErrorState
          title="Не удалось загрузить рабочие пространства"
          className="max-w-md"
          isFetching={workspacesQuery.isFetching}
          onRetry={() => void workspacesQuery.refetch()}
        />
      </div>
    );
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
      <Route path="/login" element={<RequireAnonymous>{withSuspense(<LoginPage />)}</RequireAnonymous>} />
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
