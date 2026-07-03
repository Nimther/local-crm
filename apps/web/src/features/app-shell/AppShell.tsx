import { Outlet, useParams } from "react-router";

import { Separator } from "@/components/ui/separator";
import { WorkspaceSwitcher } from "@/features/workspace-switcher/WorkspaceSwitcher";

/** Sidebar + topbar shell wrapping every /w/:slug route; active workspace comes from the URL (D-16). */
export function AppShell() {
  const { slug = "" } = useParams<{ slug: string }>();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 flex-col border-r bg-secondary/40 p-4">
        <WorkspaceSwitcher activeSlug={slug} />
        <Separator className="my-4" />
      </aside>
      <main className="flex-1 bg-background">
        <Outlet />
      </main>
    </div>
  );
}

export default AppShell;
