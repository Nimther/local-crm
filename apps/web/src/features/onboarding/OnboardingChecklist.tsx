import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleCheck } from "lucide-react";

import type { SendgridKeyStatus } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MemberListItem {
  id: string;
}

export interface OnboardingItem {
  id: string;
  label: string;
  href: string;
  done: boolean;
}

/**
 * D-23: extensible onboarding checklist -- items are data, not inline JSX,
 * so later phases (contacts, campaigns) append entries without
 * restructuring. Done-detection is wired here: «Подключите SendGrid» reads
 * the live GET status (01-05), «Пригласите команду» reads the live member
 * count (01-04) -- neither is hardcoded.
 */
function buildItems(
  slug: string,
  sendgridConnected: boolean,
  hasSecondMember: boolean
): OnboardingItem[] {
  return [
    {
      id: "sendgrid",
      label: "Подключите SendGrid",
      href: `/w/${slug}/settings/sendgrid`,
      done: sendgridConnected,
    },
    {
      id: "invite-team",
      label: "Пригласите команду",
      href: `/w/${slug}/team`,
      done: hasSecondMember,
    },
  ];
}

export function OnboardingChecklist({ slug }: { slug: string }) {
  const sendgridQuery = useQuery({
    queryKey: ["workspace", slug, "sendgrid-key"],
    queryFn: () => apiGet<SendgridKeyStatus>(`/api/workspaces/${slug}/sendgrid-key`),
    enabled: Boolean(slug),
  });

  const membersQuery = useQuery({
    queryKey: ["workspace", slug, "members"],
    queryFn: () => apiGet<MemberListItem[]>(`/api/workspaces/${slug}/members`),
    enabled: Boolean(slug),
  });

  const items = buildItems(
    slug,
    Boolean(sendgridQuery.data?.connected),
    (membersQuery.data?.length ?? 0) > 1
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Настройте воркспейс</CardTitle>
        <CardDescription>
          Чеклист с пунктами — в следующих фазах добавятся пункты про контакты и кампании.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.id}
            to={item.href}
            className="flex items-center gap-3 rounded-md p-2 text-sm hover:bg-accent"
          >
            {item.done ? (
              <CircleCheck className="h-4 w-4 text-primary" />
            ) : (
              <Circle className={cn("h-4 w-4 text-muted-foreground")} />
            )}
            <span>{item.label}</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export default OnboardingChecklist;
