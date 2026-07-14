import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { DashboardTrendPoint } from "@/features/dashboard/api";

/**
 * 07-UI-SPEC Chart Palette -- fixed order (sent -> delivered -> opened),
 * never cycled or reassigned. #2A78D6 is a chart-only hue; #4F46E5/#16A34A
 * intentionally reuse the brand accent + existing success badge hue as
 * chart-scoped categorical identity (see UI-SPEC's reuse-vs-reservation
 * note). Validated via the dataviz skill's validate_palette.js (all 6
 * checks PASS).
 */
const SERIES = [
  { key: "sent", label: "Отправлено", color: "#2A78D6" },
  { key: "delivered", label: "Доставлено", color: "#4F46E5" },
  { key: "opened", label: "Открыто", color: "#16A34A" },
] as const;

/** Native Date/Intl formatting -- no date-math library (RESEARCH.md A1). */
function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
}

/** Tooltip/legend/axis text stays in text tokens (muted-foreground), never the series color -- dataviz skill's "text never wears the data color" rule. */
function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-card p-3 text-sm shadow-md">
      <p className="mb-1 font-medium text-foreground">{formatDay(label ?? "")}</p>
      {SERIES.map((series) => {
        const point = payload.find((p) => p.dataKey === series.key);
        return (
          <div key={series.key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ backgroundColor: series.color }}
              />
              {series.label}
            </span>
            <span className="tabular-nums font-medium text-foreground">{point?.value ?? 0}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 07-07/ANLT-04: send/deliver/open daily trend, three fixed-order series
 * (dataviz skill: categorical hues never cycled), legend always visible,
 * crosshair tooltip. Presentational only -- receives the pre-fetched dense
 * series as props (WorkspaceDashboard owns the fetch).
 */
export function TrendChart({ data }: { data: DashboardTrendPoint[] }) {
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
        <Tooltip content={<TrendTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 14, color: "hsl(var(--muted-foreground))" }}
          formatter={(value) => SERIES.find((s) => s.key === value)?.label ?? value}
        />
        {SERIES.map((series) => (
          <Area
            key={series.key}
            type="monotone"
            dataKey={series.key}
            name={series.key}
            stroke={series.color}
            strokeWidth={2}
            fill={series.color}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default TrendChart;
