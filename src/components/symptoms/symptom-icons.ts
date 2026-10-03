import { createElement } from "react";
import {
  Activity,
  BatteryLow,
  Brain,
  CircleDot,
  Cookie,
  Drama,
  Droplet,
  Flame,
  Frown,
  Heart,
  HeartPulse,
  MoonStar,
  PersonStanding,
  Pill,
  Snowflake,
  Soup,
  Stethoscope,
  Tag,
  Thermometer,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { SymptomIconName } from "@/lib/symptoms/shared";

/**
 * A symptom's stored icon NAME to its Lucide component. Keyed by the
 * allowlist type, so an icon added to the allowlist without a component here
 * does not compile. The same names the cycle custom symptoms use and the iOS
 * client maps.
 */
const SYMPTOM_ICON_BY_NAME = {
  Tag,
  Activity,
  Heart,
  HeartPulse,
  Brain,
  Zap,
  Flame,
  Snowflake,
  Droplet,
  CircleDot,
  BatteryLow,
  MoonStar,
  PersonStanding,
  Drama,
  Frown,
  Cookie,
  Soup,
  Pill,
  Thermometer,
  Stethoscope,
} satisfies Record<SymptomIconName, LucideIcon>;

/** The component for a stored icon name; `Tag` for none or an unknown one. */
export function symptomIcon(name: string | null | undefined): LucideIcon {
  return (
    (name && (SYMPTOM_ICON_BY_NAME as Record<string, LucideIcon>)[name]) || Tag
  );
}

/**
 * A symptom's icon as an element. Looked up and created in one call so a
 * render never declares a component of its own.
 */
export function SymptomIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  return createElement(symptomIcon(name), {
    className,
    "aria-hidden": true,
  });
}
