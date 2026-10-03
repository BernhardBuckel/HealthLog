"use client";

/**
 * The quick-entry forms, loaded when a sheet first opens rather than with the
 * page. The dashboard and the bottom bar's capture picker are on nearly every
 * authenticated paint, and both used to import all five forms eagerly (each
 * with react-hook-form, zod, its pickers and its own queries) for sheets most
 * visits never open.
 *
 * Client-only (`ssr: false`): every sheet is closed on the server render. The
 * options are inline object literals because the bundler requires them so.
 * The placeholder holds the sheet body's height while the chunk arrives so the
 * sheet does not grow under the finger. Same `next/dynamic` arrangement as
 * the Coach drawer mount.
 */
import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

function SheetBodySkeleton() {
  return (
    <div className="space-y-4" data-slot="quick-entry-form-loading">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  );
}

export const MeasurementForm = dynamic(
  () =>
    import("@/components/measurements/measurement-form").then((m) => ({
      default: m.MeasurementForm,
    })),
  { ssr: false, loading: SheetBodySkeleton },
);

export const MoodForm = dynamic(
  () =>
    import("@/components/mood/mood-form").then((m) => ({
      default: m.MoodForm,
    })),
  { ssr: false, loading: SheetBodySkeleton },
);

export const MedicationIntakeQuickAdd = dynamic(
  () =>
    import("@/components/dashboard/medication-intake-quick-add").then((m) => ({
      default: m.MedicationIntakeQuickAdd,
    })),
  { ssr: false, loading: SheetBodySkeleton },
);

export const ManualWorkoutForm = dynamic(
  () =>
    import("@/components/workouts/manual-workout-form").then((m) => ({
      default: m.ManualWorkoutForm,
    })),
  { ssr: false, loading: SheetBodySkeleton },
);

export const SymptomEntryForm = dynamic(
  () =>
    import("@/components/symptoms/symptom-entry-form").then((m) => ({
      default: m.SymptomEntryForm,
    })),
  { ssr: false, loading: SheetBodySkeleton },
);
