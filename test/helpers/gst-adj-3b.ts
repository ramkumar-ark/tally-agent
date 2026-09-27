import { buildWorkbook, type Sheet } from "../../src/xlsx.js";

export const MONTHS = ["April ", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];

export interface Row { label: string; values?: (number | null)[]; }
export function make3bWorkbook(opts?: {
  companyName?: string; gstin?: string; state?: string; months?: string[];
  rows?: Row[];
}): Buffer {
  const companyName = opts?.companyName ?? "Test Constructions";
  const gstin = opts?.gstin ?? "33AAAAA0000A0Z0";
  const state = opts?.state ?? "Tamil Nadu";
  const months = opts?.months ?? MONTHS;
  const rows = opts?.rows ?? SECTIONS;
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
  { label: "(a) outward taxable supplies", values: Array(12).fill(1000) },
  { label: "Tax on outward supply", values: Array(12).fill(0) },
  { label: "IGST on outward supply", values: Array(12).fill(103.03) },
  { label: "CGST on outward supply", values: Array(12).fill(101.01) },
  { label: "SGST on outward supply", values: Array(12).fill(102.02) },
  { label: "Cess on outward supply", values: Array(12).fill(104.04) },
  { label: "Tax payable under RCM", values: Array(12).fill(0) },
  { label: "IGST under RCM", values: Array(12).fill(11.12) },
  { label: "CGST under RCM", values: Array(12).fill(11.11) },
  { label: "SGST under RCM", values: Array(12).fill(11.13) },
  { label: "Cess under RCM", values: Array(12).fill(11.14) },
  { label: "Input tax (reverse charge)", values: Array(12).fill(0) },
  { label: "IGST under reverse charge", values: Array(12).fill(21.22) },
  { label: "CGST under reverse charge", values: Array(12).fill(21.22) },
  { label: "SGST under reverse charge", values: Array(12).fill(21.21) },
  { label: "Cess under reverse charge", values: Array(12).fill(21.24) },
  { label: "All other ITC", values: Array(12).fill(0) },
  { label: "IGST all other ITC", values: Array(12).fill(31.32) },
  { label: "CGST all other ITC", values: Array(12).fill(31.31) },
  { label: "SGST all other ITC", values: Array(12).fill(31.33) },
  { label: "Cess all other ITC", values: Array(12).fill(31.34) },
  { label: "ITC reversed) as per rules 38", values: Array(12).fill(0) },
  { label: "IGST", values: Array(12).fill(41.41) },
  { label: "CGST", values: Array(12).fill(41.41) },
  { label: "SGST", values: Array(12).fill(41.41) },
  { label: "Cess", values: Array(12).fill(41.41) },
  { label: "ITC reversed) (2) others", values: Array(12).fill(0) },
  { label: "IGST", values: Array(12).fill(42.42) },
  { label: "CGST", values: Array(12).fill(43.43) },
  { label: "SGST", values: Array(12).fill(42.42) },
  { label: "Cess", values: Array(12).fill(43.43) },
  { label: "Net ITC available (a-b)", values: Array(12).fill(0) },
  { label: "IGST net ITC", values: Array(12).fill(51.51) },
  { label: "CGST net ITC", values: Array(12).fill(51.51) },
  { label: "SGST net ITC", values: Array(12).fill(51.52) },
  { label: "Cess net ITC", values: Array(12).fill(51.53) },
  { label: "(D)-1 ITC reclaimed", values: Array(12).fill(0) },
  { label: "IGST reclaimed", values: Array(12).fill(52.52) },
  { label: "CGST reclaimed", values: Array(12).fill(53.53) },
  { label: "SGST reclaimed", values: Array(12).fill(52.52) },
  { label: "Cess reclaimed", values: Array(12).fill(52.55) },
  { label: "(D)-2 ineligible ITC as per rules 42/43", values: Array(12).fill(61.61) },
  { label: "Table 12", values: Array(12).fill(0) },
  { label: "Payment of tax", values: Array(12).fill(0) },
];
