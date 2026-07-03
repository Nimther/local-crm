import { Link } from "react-router";
import { Circle, CircleCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface OnboardingItem {
  id: string;
  label: string;
  href: string;
  done: boolean;
}

/**
 * D-23: extensible onboarding checklist — items are data, not inline JSX, so
 * later phases (contacts, campaigns) append entries without restructuring.
 * Done-detection for SendGrid/invites is wired in 01-05; both items default
 * to pending here.
 */
function buildItems(slug: string): OnboardingItem[] {
  return [
    {
      id: "sendgrid",
      label: "Подключите SendGrid",
      href: `/w/${slug}/settings/sendgrid`,
      done: false,
    },
    {
      id: "invite-team",
      label: "Пригласите команду",
      href: `/w/${slug}/team`,
      done: false,
    },
  ];
}

export function OnboardingChecklist({ slug }: { slug: string }) {
  const items = buildItems(slug);

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
