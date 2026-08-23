import { NavLink } from "react-router";

import { Separator } from "@/components/ui/separator";
import { WorkspaceSwitcher } from "@/features/workspace-switcher/WorkspaceSwitcher";
import { cn } from "@/lib/utils";

const NAV_LINK_BASE = "rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-foreground";

/**
 * Active-nav-item accent (Phase 1's reservation, extended per 04-UI-SPEC for
 * «Кампании»): `NavLink`'s `isActive` drives the indigo-600 text + subtle
 * accent background instead of the resting muted-foreground color.
 */
export function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return cn(NAV_LINK_BASE, isActive ? "bg-accent font-medium text-primary" : "text-muted-foreground");
}

/**
 * The nav destination list shared by the desktop sidebar and the mobile
 * drawer (21-08, gap G-21-3): the WorkspaceSwitcher, a Separator, and the
 * eleven workspace NavLinks. `onNavigate` is invoked on every link click so
 * the mobile drawer can close itself after a navigation; the desktop aside
 * simply omits it.
 */
export function WorkspaceNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  return (
    <>
      <WorkspaceSwitcher activeSlug={slug} />
      <Separator className="my-4" />
      <NavLink to={`/w/${slug}/contacts`} className={navLinkClassName} end onClick={onNavigate}>
        Контакты
      </NavLink>
      <NavLink to={`/w/${slug}/segments`} className={navLinkClassName} onClick={onNavigate}>
        Сегменты
      </NavLink>
      <NavLink to={`/w/${slug}/campaigns`} className={navLinkClassName} onClick={onNavigate}>
        Кампании
      </NavLink>
      <NavLink to={`/w/${slug}/flows`} className={navLinkClassName} onClick={onNavigate}>
        Цепочки
      </NavLink>
      <NavLink to={`/w/${slug}/send-log`} className={navLinkClassName} onClick={onNavigate}>
        Журнал отправок
      </NavLink>
      <NavLink to={`/w/${slug}/contacts/imports`} className={navLinkClassName} onClick={onNavigate}>
        Импорт CSV
      </NavLink>
      <NavLink to={`/w/${slug}/team`} className={navLinkClassName} onClick={onNavigate}>
        Команда
      </NavLink>
      <NavLink to={`/w/${slug}/settings/sendgrid`} className={navLinkClassName} onClick={onNavigate}>
        SendGrid
      </NavLink>
      <NavLink to={`/w/${slug}/settings/sending`} className={navLinkClassName} onClick={onNavigate}>
        Настройки отправки
      </NavLink>
      <NavLink to={`/w/${slug}/settings/api-keys`} className={navLinkClassName} onClick={onNavigate}>
        API-ключи
      </NavLink>
      <NavLink to={`/w/${slug}/profile`} className={navLinkClassName} onClick={onNavigate}>
        Профиль
      </NavLink>
    </>
  );
}

export default WorkspaceNav;
