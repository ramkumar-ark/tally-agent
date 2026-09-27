import { buildWorkbook, type Sheet } from "../../src/xlsx.js";

export const MONTHS = ["April ", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];

export interface Row { label: string; values?: (number | null)[]; } // values: 12 month cells; null-filled
export function make3bWorkbook(opts?: {
  companyName?: string; gstin?: string; state?: string; months?: string[];
  rows?: Row[]; // appended after the standard rows when omitted
}): Buffer {
  const companyName = opts?.companyName ?? "Test Constructions";
  const gstin = opts?.gstin ?? "33AAAAA0000A0Z0";
  const state = opts?.state ?? "Tamil Nadu";
  const months = opts?.months ?? MONTHS;
  const rows = opts?.rows ?? [];
  const sheet: Sheet = {
    name: "Summary Report",
    title: [companyName, `GSTIN\t${gstin}\tState\t${state}`, "GSTR - 3B Summary Report - F.Y. 2025 - 2026"],
    columns: [{ header: "Particulars" }, ...months.map((m) => ({ header: m })), { header: "Total" }],
    rows: rows.map((r) => [r.label, ...(r.values ?? Array(12).fill(0)), null]),
  };
  return buildWorkbook([sheet]);
}

export const SECTIONS: Row[] = [
  { label: "Sales summary", values: Array(12).fill(1000) },
  { label: "Tax on outward supply — CGST", values: Array(12).fill(101.01) },
  { label: "Tax on outward supply — SGST", values: Array(12).fill(102.02) },
  { label: "IGST on outward supply", values: Array(12).fill(103.03) },
  { label: "Cess on outward supply", values: Array(12).fill(104.04) },
  { label: "Tax payable under RCM — IGST", values: Array(12).fill(11.11) },
  { label: "Tax payable under RCM — CGST", values: Array(12).fill(11.12) },
  { label: "Tax payable under RCM — SGST", values: Array(12).fill(11.13) },
  { label: "Tax payable under RCM — Cess", values: Array(12).fill(11.14) },
  { label: "Input tax (reverse charge) — IGST", values: Array(12).fill(21.21) },
  { label: "Input tax (reverse charge) — CGST", values: Array(12).fill(21.22) },
  { label: "Input tax (reverse charge) — SGST", values: Array(12).fill(21.23) },
  { label: "Input tax (reverse charge) — Cess", values: Array(12).fill(21.24) },
  { label: "All other ITC — IGST", values: Array(12).fill(31.31) },
  { label: "All other ITC — CGST", values: Array(12).fill(31.32) },
  { label: "All other ITC — SGST", values: Array(12).fill(31.33) },
  { label: "All other ITC — Cess", values: Array(12).fill(31.34) },
  { label: "ITC reversed)   as per rules 38", values: Array(12).fill(41.41) },
  { label: "ITC reversed)    (2) others", values: Array(12).fill(43.43) },
  { label: "Net ITC available (a-b) — IGST", values: Array(12).fill(51.51) },
  { label: "Net ITC available (a-b) — CGST", values: Array(12).fill(51.52) },
  { label: "Net ITC available (a-b) — SGST", values: Array(12).fill(51.53) },
  { label: "Net ITC available (a-b) — Cess", values: Array(12).fill(51.54) },
  { label: "(D)-1 ITC reclaimed which was reversed under Table 4(B)(2) — IGST", values: Array(12).fill(52.52) },
  { label: "(D)-1 ITC reclaimed which was reversed under Table 4(B)(2) — CGST", values: Array(12).fill(52.53) },
  { label: "(D)-1 ITC reclaimed which was reversed under Table 4(B)(2) — SGST", values: Array(12).fill(52.54) },
  { label: "(D)-1 ITC reclaimed which was reversed under Table 4(B)(2) — Cess", values: Array(12).fill(52.55) },
  { label: "(D)-2 ineligible ITC as per rules 42/43 — IGST", values: Array(12).fill(61.61) },
  { label: "(D)-2 ineligible ITC as per rules 42/43 — CGST", values: Array(12).fill(61.62) },
  { label: "(D)-2 ineligible ITC as per rules 42/43 — SGST", values: Array(12).fill(61.63) },
  { label: "(D)-2 ineligible ITC as per rules 42/43 — Cess", values: Array(12).fill(61.64) },
];
