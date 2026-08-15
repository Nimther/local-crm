import type { ReactNode } from "react";
import { ErrorBoundary as SentryErrorBoundary } from "@sentry/react";
import { useLocation, useNavigate, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface RouteErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Contained fallback panel (OPS-17/D-11 boundary half) -- reads as a sibling
 * of `QueryErrorState` (same destructive border/background treatment,
 * card-shaped, sized to sit inside a route outlet), never a fourth error
 * language. Renders in place of the failing route's own subtree only --
 * `AppShell`'s nav/workspace-switcher are outside this component entirely
 * (see `App.tsx`: the boundary wraps each routed element, never the shell
 * route itself), so they keep rendering and stay usable.
 */
function RouteErrorFallback({ resetError }: { resetError: () => void }) {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug?: string }>();
  const workspaceHomeHref = slug ? `/w/${slug}` : "/";

  return (
    <div className="p-8">
      <Card className="border-destructive/50 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">Не удалось отобразить страницу</CardTitle>
          <CardDescription>
            Произошла непредвиденная ошибка при загрузке этого раздела. Остальная часть рабочего
            пространства продолжает работать.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button variant="outline" size="sm" onClick={resetError}>
            Повторить
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigate(workspaceHomeHref);
            }}
          >
            На главную рабочего пространства
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Route-level error boundary (OPS-17/D-11 boundary half; T-15-37's accepted
 * DoS disposition -- the fallback is a static panel, not a re-render loop).
 * Wraps `@sentry/react`'s OWN `ErrorBoundary` rather than a hand-rolled
 * `componentDidCatch` class (RESEARCH.md § Don't Hand-Roll) -- the catch
 * (`componentDidCatch` -> `captureReactException` -> the shared
 * `sentryBeforeSend` scrub, since `lib/sentry.ts` wires `beforeSend`
 * globally) / report / fallback wiring is already tested upstream by the
 * SDK itself.
 *
 * MUST be mounted INSIDE a routed element (see `App.tsx`'s `withSuspense`),
 * never wrapping `AppShell`/the `/w/:slug` shell route directly -- wrapping
 * the shell would take the nav/workspace-switcher down with the failing
 * child, defeating the whole point of a CONTAINED failure.
 *
 * MUST enclose the route's `Suspense` boundary, not be enclosed by it: a
 * failed lazy chunk import throws asynchronously in a way Suspense alone
 * cannot recover from (it would otherwise hang on the loading skeleton
 * forever) -- only a `componentDidCatch`-based boundary OUTSIDE the
 * Suspense actually catches that failure and shows the panel above.
 *
 * Reset-on-navigation: this installed `@sentry/react@10.70.0` does not
 * support `resetKeys`/`resetOnPropsChange` (verified against its own
 * shipped source -- `ErrorBoundaryProps` has no such field in this
 * version). `key={location.pathname}` on the underlying `SentryErrorBoundary`
 * is the standard React substitute: a changed `key` unmounts the old
 * (crashed) instance and mounts a fresh one, so navigating to a different
 * route clears a stale error panel without needing the SDK's own
 * mechanism. `RouteErrorBoundary` itself is a plain function component (no
 * state of its own) that re-renders on every navigation via `useLocation`,
 * which is what makes that `key` prop track the current path at all.
 */
export function RouteErrorBoundary({ children }: RouteErrorBoundaryProps) {
  const location = useLocation();

  return (
    <SentryErrorBoundary
      key={location.pathname}
      fallback={(errorData) => <RouteErrorFallback resetError={() => errorData.resetError()} />}
    >
      {children}
    </SentryErrorBoundary>
  );
}

export default RouteErrorBoundary;
