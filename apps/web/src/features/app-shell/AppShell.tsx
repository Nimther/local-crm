import { Link, Outlet, useParams } from "react-router";

import { Separator } from "@/components/ui/separator";
import { WorkspaceSwitcher } from "@/features/workspace-switcher/WorkspaceSwitcher";
import { VerifyEmailBanner } from "@/features/auth/VerifyEmailBanner";

/** Sidebar + topbar shell wrapping every /w/:slug route; active workspace comes from the URL (D-16). */
export function AppShell() {
  const { slug = "" } = useParams<{ slug: string }>();

  return (
    <div className="flex min-h-screen flex-col">
      <VerifyEmailBanner />
      <div className="flex flex-1">
        <aside className="flex w-64 flex-col border-r bg-secondary/40 p-4">
          <WorkspaceSwitcher activeSlug={slug} />
          <Separator className="my-4" />
          <Link
            to={`/w/${slug}/team`}
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Команда
          </Link>
          <Link
            to={`/w/${slug}/settings/sendgrid`}
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            SendGrid
          </Link>
          <Link
            to={`/w/${slug}/settings/api-keys`}
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            API-ключи
          </Link>
          <Link
            to={`/w/${slug}/profile`}
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Профиль
          </Link>
        </aside>
        <main className="flex-1 bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AppShell;
