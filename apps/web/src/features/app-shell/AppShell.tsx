import { useState } from "react";
import { Outlet, useParams } from "react-router";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetHeader, SheetTrigger } from "@/components/ui/sheet";
import { VerifyEmailBanner } from "@/features/auth/VerifyEmailBanner";
import { WorkspaceNav } from "@/features/app-shell/WorkspaceNav";

/**
 * Sidebar + topbar shell wrapping every /w/:slug route; active workspace
 * comes from the URL (D-16).
 *
 * 21-08 (gap G-21-3): the fixed 256px sidebar is out of the layout below the
 * `md` breakpoint and reachable instead through a mobile drawer built on the
 * existing `Sheet` primitive (see `SendLogRowDrawer.tsx` for the project's
 * prior usage). Exactly one nav rendering exists in the DOM at any width --
 * the desktop aside is removed from rendering (not merely hidden) below
 * `md`, and the Sheet's content stays unmounted while closed -- otherwise
 * every existing spec's role-based nav queries (e.g.
 * `getByRole("link", { name: "Сегменты" })`) would hit a Playwright
 * strict-mode violation.
 */
export function AppShell() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col">
      <VerifyEmailBanner />
      <div className="flex items-center gap-2 border-b p-4 md:hidden">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Меню">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col p-4">
            <SheetHeader className="sr-only">
              <SheetTitle>Навигация</SheetTitle>
              <SheetDescription>Разделы воркспейса</SheetDescription>
            </SheetHeader>
            <WorkspaceNav slug={slug} onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
      <div className="flex flex-1">
        <aside className="hidden w-64 flex-col border-r bg-secondary/40 p-4 md:flex">
          <WorkspaceNav slug={slug} />
        </aside>
        <main className="min-w-0 flex-1 bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AppShell;
