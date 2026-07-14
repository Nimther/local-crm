import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { DashboardGrowthPoint } from "@/features/dashboard/api";

/** Contact-growth chart: brand indigo, single series -- UI-SPEC's chart palette. */
const GROWTH_COLOR = "#4F46E5";

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
}

function GrowthTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-card p-3 text-sm shadow-md">
      <p className="mb-1 font-medium text-foreground">{formatDay(label ?? "")}</p>
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: GROWTH_COLOR }} />
          Контактов всего
        </span>
        <span className="tabular-nums font-medium text-foreground">{payload[0]?.value ?? 0}</span>
      </div>
    </div>
  );
}

/**
 * 07-07/ANLT-04: cumulative contact-base growth. Single series -- per the
 * dataviz skill, a single-series chart needs no legend box; the card title
 * («Рост базы контактов») names it. Presentational only.
 */
export function GrowthChart({ data }: { data: DashboardGrowthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="0" />
        <XAxis
          dataKey="day"
          tickFormatter={formatDay}
          tick={{ fontSize: 14, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 14, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip content={<GrowthTooltip />} />
        <Area
          type="monotone"
          dataKey="cumulativeContacts"
          name="cumulativeContacts"
          stroke={GROWTH_COLOR}
          strokeWidth={2}
          fill={GROWTH_COLOR}
          fillOpacity={0.12}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default GrowthChart;
