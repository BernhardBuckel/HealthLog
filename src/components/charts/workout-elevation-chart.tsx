"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import {
  applyDisplayTransformUnrounded,
  getQuantityTransform,
} from "@/lib/measurements/display-transform";

/**
 * Workout elevation profile — a small cumulative-distance / altitude
 * area under the route map. Rendered ONLY through `chart-runtime.ts`.
 * Present only when ≥ 60 % of route coordinates carry altitude (the
 * caller gates it); partial altimeter data would draw a lie.
 */

export interface WorkoutElevationPoint {
  distanceM: number;
  altitude: number;
}

export function WorkoutElevationChart({
  points,
}: {
  points: WorkoutElevationPoint[];
}) {
  const { t } = useTranslations();
  const { preference } = useUnitDisplay();
  // Distance along the route in km or mi, altitude in m or ft — the same
  // registry the stat tiles read, so the axis and the tiles agree.
  const distance = getQuantityTransform("distance", preference);
  const elevation = getQuantityTransform("elevation", preference);
  const data = points.map((p) => ({
    dist: applyDisplayTransformUnrounded(p.distanceM, distance),
    alt: applyDisplayTransformUnrounded(p.altitude, elevation),
  }));

  return (
    <div className="h-24 w-full" data-slot="workout-elevation-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient
              id="workoutElevationFill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.4}
          />
          <XAxis
            dataKey="dist"
            type="number"
            domain={[0, "dataMax"]}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => Number(v).toFixed(1)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={["dataMin - 5", "dataMax + 5"]}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={36}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.875rem",
            }}
            labelFormatter={(d) =>
              `${Number(d).toFixed(2)} ${distance.displayUnit}`
            }
            formatter={(value) => [
              `${Math.round(Number(value))} ${elevation.displayUnit}`,
              t("insights.workouts.detail.elevationTitle"),
            ]}
          />
          <Area
            type="monotone"
            dataKey="alt"
            stroke="var(--chart-2)"
            strokeWidth={2}
            fill="url(#workoutElevationFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
