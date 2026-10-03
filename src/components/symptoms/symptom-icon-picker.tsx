"use client";

/**
 * The icon picker a person-named symptom is given an icon with. One source for
 * the three places that offer it (the symptoms add chip, the symptom edit
 * sheet, and the cycle sheet's custom-symptom popover), which all draw from
 * the same allowlist: 44 px targets on a phone, 36 px from `sm`, and each icon
 * named in the reader's language rather than by its Lucide component name.
 */
import { useTranslations } from "@/lib/i18n/context";
import { SYMPTOM_ICON_ALLOWLIST } from "@/lib/symptoms/shared";
import { cn } from "@/lib/utils";

import { symptomIcon } from "./symptom-icons";

export function SymptomIconPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (name: string) => void;
  /** The radiogroup's accessible name (the visible field label). */
  label: string;
}) {
  const { t } = useTranslations();
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="radiogroup"
      aria-label={label}
    >
      {SYMPTOM_ICON_ALLOWLIST.map((name) => {
        const IconC = symptomIcon(name);
        const selected = value === name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(`symptoms.icons.${name}`)}
            onClick={() => onChange(name)}
            className={cn(
              "focus-visible:ring-ring/50 grid size-11 place-items-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none sm:size-9",
              selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <IconC className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
