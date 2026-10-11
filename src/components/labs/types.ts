import type {
  ReferenceRangeOrigin,
  ReferenceRangeStatus,
} from "@/lib/validations/labs";

/** A lab-result row as the list / create endpoints serialise it. */
export interface LabResultDto {
  id: string;
  /** v1.18.1 — link to the catalog marker (null for legacy free-text rows). */
  biomarkerId: string | null;
  panel: string | null;
  analyte: string;
  /** Numeric reading; null for a qualitative row (see `valueText`). v1.18.9. */
  value: number | null;
  /** v1.18.9 — qualitative result text ("negativ" / …); null for a numeric row. */
  valueText: string | null;
  unit: string;
  /**
   * True when the stored number was converted into the marker's unit from
   * another one; `sourceValue` and `sourceUnit` are then what the report
   * printed. A reading stored as stated has `converted: false` and two nulls.
   */
  converted: boolean;
  sourceValue: number | null;
  sourceUnit: string | null;
  /**
   * The window this reading is judged against and the one `rangeStatus` was
   * computed from: the range its own report printed when it carries one, the
   * catalog band otherwise. Render these and the range shown always matches
   * the verdict shown.
   */
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The catalog marker's band, so both windows can be drawn. */
  catalogReferenceLow: number | null;
  catalogReferenceHigh: number | null;
  /** The window the source report printed; the text verbatim, bounds when derivable. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  /** Which window is in force. */
  referenceOrigin: ReferenceRangeOrigin;
  /** True when the report's window and the catalog band state different limits. */
  referenceDivergesFromCatalog: boolean;
  takenAt: string;
  source: string;
  hasNote: boolean;
  rangeStatus: ReferenceRangeStatus;
  createdAt: string;
  updatedAt: string;
}

/** The single-resource detail DTO — carries the decrypted note. */
export interface LabResultDetailDto extends Omit<LabResultDto, "hasNote"> {
  note: string | null;
}

export interface LabResultListResponse {
  results: LabResultDto[];
  meta: { total: number; limit: number; offset: number };
}

/** A user-scoped Biomarker catalog entry as the API serialises it. */
export interface BiomarkerDto {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  /**
   * Which analyte the marker is, for converting a reading in another unit
   * (the unit-conversion registry's key), or null when it is none that is known.
   */
  analyteKey: string | null;
  hasContext: boolean;
  context: string | null;
  /** v1.22 — a hidden marker drops from the active list + lab-entry pickers. */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BiomarkerListResponse {
  biomarkers: BiomarkerDto[];
}
