import { buildWorkbook, type Sheet } from "../../src/xlsx.js";

export interface Row2b {
  date: number;
  party: string;
  gstin?: string;
  vchNo?: string;
  docNo?: string;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
}

export function ser(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function c(x: unknown): string | number | null {
  if (x === undefined || x === null) return null;
  return x;
}

export function make2bWorkbook(opts: {
  period: string;
  sheetName?: string;
  gstin?: string;
  layout: "v1" | "v2" | "v3" | "v4";
  rows: Row2b[];
  totalsAsText?: boolean;
}): Buffer {
  const layouts = {
    v1: ["Date", "Particulars", "Party GSTIN/UIN", "Vch Type", "Vch No.", "Doc No.", "Doc Date", "Taxable Amount", "IGST", "CGST", "SGST/(+UTGST)", "Cess", "Tax Amount", "Invoice Amount"],
    v2: ["Date", "Particulars", "Party GSTIN/UIN", "Vch Type", "Vch No.", "Doc No.", "Doc Date", "Taxable Amount", "IGST", "CGST", "SGST/(+UTGST)", "Cess", "Tax Amount", "Invoice Amount", "ITC Available", "Reason for ITC Unavailability"],
    v3: ["Date", "Particulars", "Party GSTIN/UIN", "Vch Type", "Vch No.", "Taxable Amount", "IGST", "CGST", "SGST/(+UTGST)", "Cess", "Tax Amount", "Invoice Amount", "ITC Available", "Reason for ITC Unavailability"],
    v4: ["Date", "Particulars", "Party GSTIN/UIN", "Doc No.", "Doc Date", "Taxable Amount", "IGST", "CGST", "SGST/(+UTGST)", "Cess", "Tax Amount", "Invoice Amount", "GST Status"],
  } as const;

  const headers = layouts[opts.layout];
  const compoundSecond: Record<string, string> = {
    "Taxable Amount": "Amount",
    "Invoice Amount": "Amount",
    "SGST/(+UTGST)": "SGST",
  };

  const secondRow: (string | null)[] = headers.map((h) => compoundSecond[h] ?? null);

  const dataRows: (string | number | null)[][] = opts.rows.map((r) => {
    const base: (string | number | null)[] = [r.date, r.party, r.gstin ?? "33AAAAA0000A0Z0"];
    if (opts.layout === "v1" || opts.layout === "v2") {
      base.push("JV", c(r.vchNo), c(r.docNo), r.date);
    } else if (opts.layout === "v3") {
      base.push("JV", c(r.vchNo));
    } else {
      base.push(c(r.docNo), r.date);
    }
    base.push(r.date, r.igst ?? 0, r.cgst ?? 0, r.sgst ?? 0, r.cess ?? 0, 0, 0);
    if (opts.layout === "v2") base.push("Yes", "");
    if (opts.layout === "v4") base.push("");
    return base;
  });

  const totalIgst = opts.rows.reduce((s, r) => s + (r.igst ?? 0), 0);
  const totalCgst = opts.rows.reduce((s, r) => s + (r.cgst ?? 0), 0);
  const totalSgst = opts.rows.reduce((s, r) => s + (r.sgst ?? 0), 0);
  const totalCess = opts.rows.reduce((s, r) => s + (r.cess ?? 0), 0);
  const totals: (string | number | null)[] = ["Total", null, null, null, null, null, null, null, totalIgst, totalCgst, totalSgst, totalCess, 0, 0];
  if (opts.layout === "v2") totals.push("Yes", "");
  if (opts.layout === "v4") totals.push("");
  if (opts.totalsAsText) {
    for (let i = 8; i < totals.length; i++) totals[i] = String(totals[i] ?? 0);
  }

  const sheet: Sheet = {
    name: opts.sheetName ?? "Not Reflected",
    title: [
      "Test Entity",
      "GSTR-2B Reconciliation - Voucher Register",
      opts.period,
      `GST Registration: ${opts.gstin ?? "33AAAAA0000A0Z0"}`,
      "Vouchers of: Available Only in Books",
    ],
    columns: headers.map((h) => ({ header: h })),
    rows: [secondRow, ...dataRows, totals],
  };
  return buildWorkbook([sheet]);
}
