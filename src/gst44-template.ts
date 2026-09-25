// src/gst44-template.ts
import { buildWorkbook, type CellValue, type Sheet } from "./xlsx.js";
import { GST44_TEMPLATE_STATUSES } from "./gst44-law.js";

/** The generated, fillable clause-44 operator template. Same channel as the
 * PF/ESI template: written through the project's own writer directly — NOT the
 * de-masking writeWorkbook — since a blank template was never masked. The
 * dropdown vocabulary is the four buckets; a row the operator fills is the
 * authoritative status for that ledger (composition is unknowable from books,
 * design C6). The Ledger dropdown is backed by the Ledgers sheet range — an
 * inline list is capped at 255 characters and cannot carry a real company's
 * ledger names (see the 26AS template notes in AGENTS.md). */

export const GST44_STATUS_SHEET = "GST Status";
export const LEDGER_SHEET = "Ledgers";

export function buildGst44Template(opts: { company?: string; ledgers?: string[] } = {}): Buffer {
  const ledgers = opts.ledgers ?? [];
  const lastLedgerRow = ledgers.length + 1;
  const instructionRows: string[] = [
    opts.company ? `GST clause 44 operator template for ${opts.company}.` : "GST clause 44 operator template.",
    "Leave a ledger's row out and the review derives its GST status from the Tally master GSTIN plus the tax actually charged on each voucher (registered + tax -> Registered - others; registered + no tax -> Exempt supplies; no GSTIN -> Unregistered).",
    "Fill a row ONLY when you know better than the books - a composition dealer (never derivable from the books), a status correction, or Tally is unreachable.",
    "One row per ledger; a second row for the same ledger is rejected.",
    "GST Status: pick from the dropdown - Exempt supplies, Composition supplier, Registered - others, Unregistered.",
    "Privacy: this file carries supplier facts only. Never paste its rows into chat - pass its path to the review tool; the file is read inside the gateway.",
    ...(ledgers.length > 0
      ? ["The Ledger column has a dropdown of this company's ledger names, backed by the Ledgers sheet."]
      : ["The Ledgers sheet is empty because no ledger list was available - type the ledger name exactly as it appears in Tally."]),
  ];
  const statusSheet: Sheet = {
    name: GST44_STATUS_SHEET,
    columns: [
      {
        header: "Ledger",
        width: 40,
        format: "text",
        ...(ledgers.length > 0 ? { validation: { formula: `Ledgers!$A$2:$A$${lastLedgerRow}` } } : {}),
      },
      {
        header: "GST Status",
        width: 20,
        format: "text",
        validation: { list: GST44_TEMPLATE_STATUSES.map((s) => s.cell) },
      },
    ],
    rows: [],
  };
  return buildWorkbook([
    { name: "Instructions", columns: [{ header: "How to fill this template", width: 110, format: "text" }], rows: instructionRows.map((line) => [line]) },
    statusSheet,
    { name: LEDGER_SHEET, columns: [{ header: "Ledger", width: 40, format: "text" }], rows: ledgers.map((l) => [l]) },
  ]);
}

export function gst44TemplateFileName(company: string | undefined, date: string): string {
  const name = (company ?? "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `gst-44-operator-template-${name}-${date}.xlsx`;
}
