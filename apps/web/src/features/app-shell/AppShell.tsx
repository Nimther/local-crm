import { NavLink, Outlet, useParams } from "react-router";

import { Separator } from "@/components/ui/separator";
import { WorkspaceSwitcher } from "@/features/workspace-switcher/WorkspaceSwitcher";
import { VerifyEmailBanner } from "@/features/auth/VerifyEmailBanner";
import { cn } from "@/lib/utils";

const NAV_LINK_BASE = "rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-foreground";

/**
 * Active-nav-item accent (Phase 1's reservation, extended per 04-UI-SPEC for
 * «Кампании»): `NavLink`'s `isActive` drives the indigo-600 text + subtle
 * accent background instead of the resting muted-foreground color.
 */
function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return cn(NAV_LINK_BASE, isActive ? "bg-accent font-medium text-primary" : "text-muted-foreground");
}

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
          <NavLink to={`/w/${slug}/contacts`} className={navLinkClassName} end>
            Контакты
          </NavLink>
          <NavLink to={`/w/${slug}/segments`} className={navLinkClassName}>
            Сегменты
          </NavLink>
          <NavLink to={`/w/${slug}/campaigns`} className={navLinkClassName}>
            Кампании
          </NavLink>
          <NavLink to={`/w/${slug}/contacts/imports`} className={navLinkClassName}>
            Импорт CSV
          </NavLink>
          <NavLink to={`/w/${slug}/team`} className={navLinkClassName}>
            Команда
          </NavLink>
          <NavLink to={`/w/${slug}/settings/sendgrid`} className={navLinkClassName}>
            SendGrid
          </NavLink>
          <NavLink to={`/w/${slug}/settings/api-keys`} className={navLinkClassName}>
            API-ключи
          </NavLink>
          <NavLink to={`/w/${slug}/profile`} className={navLinkClassName}>
            Профиль
          </NavLink>
        </aside>
        <main className="flex-1 bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AppShell;
