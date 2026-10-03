/**
 * The vault's kind vocabulary: one Lucide glyph per document kind, in the
 * fixed display order the type-chip rail and the cards share. Icons are
 * passed as components — the consuming primitive owns size and colour per
 * the design standards.
 */
import type { ComponentType } from "react";
import {
  ArrowRightLeft,
  File,
  FileText,
  FlaskConical,
  Pill,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Thermometer,
} from "lucide-react";

import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

/** Display order for the type-chip rail (everyday kinds first, OTHER last). */
export const DOCUMENT_KIND_ORDER: readonly InboundDocumentKindValue[] = [
  "DOCTOR_REPORT",
  "LAB_RESULT",
  "IMAGING",
  "DISCHARGE_LETTER",
  "PRESCRIPTION",
  "SICK_NOTE",
  "REFERRAL",
  "VACCINATION",
  "INSURANCE",
  "OTHER",
];

export const DOCUMENT_KIND_ICONS: Record<
  InboundDocumentKindValue,
  ComponentType<{ className?: string }>
> = {
  DOCTOR_REPORT: Stethoscope,
  DISCHARGE_LETTER: FileText,
  LAB_RESULT: FlaskConical,
  IMAGING: ScanLine,
  PRESCRIPTION: Pill,
  REFERRAL: ArrowRightLeft,
  INSURANCE: ShieldCheck,
  VACCINATION: Syringe,
  SICK_NOTE: Thermometer,
  OTHER: File,
};
