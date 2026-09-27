// src/gst44-law.ts
/**
 * Form 3CD clause 44 — break-up of total expenditure into GST categories,
 * AY 2026-27. Design of record: docs/design/2026-09-24-gst-44-clause-44-design.md.
 * The four buckets mirror the Winman sheet's columns exactly:
 * exempt = "Towards supplies exempt from GST" (registered, no tax charged),
 * composition = "Towards supplies by Composition Supplier" (operator-only fact),
 * others = registered and GST charged (incl. reverse charge),
 * unregistered = no GSTIN in the ledger master and no operator status.
 * TRAP: the sheet's row-2 key REGISTEREDUNDERGST names the *unregistered*
 * column F — never map by key-name intuition.
 */
export type Gst44Bucket = "exempt" | "composition" | "others" | "unregistered";

export const GST44_BUCKETS: readonly Gst44Bucket[] = ["exempt", "composition", "others", "unregistered"];

export const GST44_SHEET = "Break-up of GST expenditure";
export const GST44_FORM_ID = "3CDGSTbreakup44";

export type Gst44RowKey = "capital" | "revenue";

export interface Clause44RowLaw {
  key: Gst44RowKey;
  /** The label Winman pre-fills in column A; writeSheetRows replaces rows >= 8 wholesale, so the engine re-writes it. */
  label: string;
}

export const CLAUSE_44_ROWS: readonly Clause44RowLaw[] = [
  { key: "capital", label: "Capital Expenditure" },
  { key: "revenue", label: "Revenue Expenditure" },
];

/** The GST Status sheet's dropdown vocabulary; `cell` is what the operator sees. */
export const GST44_TEMPLATE_STATUSES: ReadonlyArray<{ cell: string; key: Gst44Bucket }> = [
  { cell: "Exempt supplies", key: "exempt" },
  { cell: "Composition supplier", key: "composition" },
  { cell: "Registered - others", key: "others" },
  { cell: "Unregistered", key: "unregistered" },
];

/**
 * The captain's confirm points (C1-C6), carried in code so a run can print
 * them next to its findings — the pf-esi-law.ts convention. Full text:
 * design doc §4.
 */
export const GST44_CONFIRMS: readonly string[] = [
  "C1: clause 44 table per Notification 88/2020; applicability for AY 2026-27 to be confirmed by the captain before filing",
  "C2: the Capital/Revenue two-row split is Winman's presentation of the clause 44 table",
  "C3: Misc. Expenses (ASSET) debits count as revenue expenditure",
  "C4: Investments are not capital expenditure; capital = Fixed Assets root only",
  "C5: TOTALEXPENDITURE is the books total; the four split columns are unchanged and the unattributed gap is an informational finding, never spread",
  "C6: registered GSTIN with no tax charged defaults to the exempt bucket with an ambiguity finding; composition is an operator fact only",
];
