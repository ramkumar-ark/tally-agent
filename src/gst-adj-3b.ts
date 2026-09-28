import { readWorkbook } from "./xlsx-read.js";

export type Head = { igst: number; cgst: number; sgst: number; cess: number; };

export interface ThreeBSummary {
  companyName: string; gstin: string; state: string;
  months: string[];
  outwardTaxable: Record<string, number>;
  outwardTax: Record<string, Head>;
  rcmTax: Record<string, Head>;
  itcRcm: Record<string, Head>;
  itcOther: Record<string, Head>;
  itcReversed: Record<string, Head>;
  netItc: Record<string, Head>;
  itcReclaimed: Record<string, Head>;
  tdsSectionPresent: boolean;
}

const MONTHS: Record<string, string> = {
  april: "04", may: "05", june: "06", july: "07",
  august: "08", september: "09", october: "10", november: "11",
  december: "12", january: "01", february: "02", march: "03",
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

const TAX_LABELS = ["igst", "cgst", "sgst", "cess"] as const;

function isTaxLabel(label: string): boolean {
  if (/(zero\s+rated)/i.test(label)) return false;
  for (const t of TAX_LABELS) {
    if (new RegExp(`^${t}\\b`).test(label)) return true;
  }
  return false;
}

const ANCHOR_SECTIONS: Record<string, string> = {
  "sales summary": "sales summary",
  "tax on outward supply": "outwardTax",
  "tax payable under rcm": "rcmTax",
  "input tax (reverse charge)": "itcRcm",
  "all other itc": "itcOther",
  "itc reversed": "itcReversed",
  "net itc available": "netItc",
  "(d)-1 itc reclaimed": "itcReclaimed",
  "(d)-2 ineligible": "(d)-2 ineligible",
  "table 12": "table 12",
  "payment of tax": "payment of tax",
};

const ANCHOR_TEXTS = Object.keys(ANCHOR_SECTIONS);

function fyFromTitle(title: string): string | null {
  const m = /f[\s.]*y[\s.]*(\d{4})\s*-\s*(\d{2,4})/.exec(title);
  return m ? m[1] : null;
}

export function parseThreeB(buf: Buffer): ThreeBSummary {
  const sheets = readWorkbook(buf);
  const sheet = sheets.find((s) => s.state === "visible") ?? sheets[0];
  if (!sheet) throw new Error('gst-adj: no "Summary Report" sheet found');

  let companyName = "";
  let gstin = "";
  let state = "";
  let fy = "";

  for (const row of sheet.rows) {
    if (row.row > 3) break;
    const cell0 = row.cells.get(0);
    const colA = cell0?.value ?? "";
    const cn = norm(String(colA));
    if (cn.startsWith("gstin")) {
      const raw = String(colA);
      const parts = raw.split(/\s+/);
      const gi = parts.findIndex((p) => norm(p) === "gstin");
      if (gi >= 0 && parts.length > gi + 1) gstin = parts[gi + 1];
      if (!gstin) {
        const alt = row.cells.get(1)?.value;
        if (typeof alt === "string" && alt.trim()) gstin = alt.trim();
      }
      const si = parts.findIndex((p) => norm(p) === "state");
      if (si >= 0 && parts.length > si + 1) state = parts.slice(si + 1).join(" ");
      if (!state) {
        let stateCol = -1;
        for (let c = 0; c < 14; c++) {
          if (norm(String(row.cells.get(c)?.value ?? "")) === "state") { stateCol = c; break; }
        }
        if (stateCol >= 0) {
          for (let c = stateCol + 1; c < 14; c++) {
            const v = row.cells.get(c)?.value;
            if (typeof v === "string" && v.trim()) { state = v.trim(); break; }
          }
        }
      }
    } else if (!companyName) {
      companyName = String(colA).trim();
    }
    const fyMatch = fyFromTitle(cn);
    if (fyMatch && !fy) fy = fyMatch;
  }

  if (!fy) throw new Error('gst-adj: sheet "Summary Report" row 1: cannot find F.Y. in title');

  const headerRow = sheet.rows.find((r) => r.row === 4);
  if (!headerRow) throw new Error('gst-adj: sheet "Summary Report" row 4: header row not found');

  const monthCol = new Map<string, number>();
  for (const [colIdx, cell] of headerRow.cells) {
    if (colIdx === 0) continue;
    const raw = cell.value === null || cell.value === undefined ? "" : String(cell.value);
    const n = norm(raw);
    let bound: string | null = null;
    for (const [m, mm] of Object.entries(MONTHS)) {
      if (n === m || n.startsWith(m + " ")) { bound = mm; break; }
    }
    if (!bound) {
      if (n === "total") continue;
      const colLetter = String.fromCharCode(65 + colIdx);
      throw new Error(`gst-adj: sheet "Summary Report" row 4 column ${colLetter}: expected a month header`);
    }
    const year = bound === "01" || bound === "02" || bound === "03" ? String(Number(fy) + 1) : fy;
    monthCol.set(`${year}-${bound}`, colIdx);
  }

  const months = [...monthCol.keys()].sort();

  const rowMapByRow = new Map<number, Map<number, string>>();
  for (const row of sheet.rows) {
    if (row.row <= 4) continue;
    const m = new Map<number, string>();
    for (const [colIdx, cell] of row.cells) {
      if (cell.value === null || cell.value === undefined) continue;
      m.set(colIdx, String(cell.value));
    }
    rowMapByRow.set(row.row, m);
  }

  const emptyHead = (): Head => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const emptyRecord = (): Record<string, Head> => {
    const r: Record<string, Head> = {};
    for (const m of months) r[m] = emptyHead();
    return r;
  };

  const outwardTaxable: Record<string, number> = {};
  const outwardTax = emptyRecord();
  const rcmTax = emptyRecord();
  const itcRcm = emptyRecord();
  const itcOther = emptyRecord();
  const itcReversed = emptyRecord();
  const netItc = emptyRecord();
  const itcReclaimed = emptyRecord();
  for (const m of months) outwardTaxable[m] = 0;

  let currentSection = "";
  const taxPosInSection = new Map<string, number>();
  let salesValueTaken = false;

  for (const row of sheet.rows) {
    if (row.row <= 4) continue;
    if (currentSection === "payment of tax") break;
    const rowMap = rowMapByRow.get(row.row);
    if (!rowMap) continue;
    const colA = rowMap.get(0) ?? "";
    const cn = norm(colA);

    if (isTaxLabel(cn)) {
      const pos = taxPosInSection.get(currentSection) ?? 0;
      taxPosInSection.set(currentSection, pos + 1);
      const tk = TAX_LABELS[pos % 4];
      if (tk) {
        for (const [m, c] of monthCol.entries()) {
          const raw = rowMap.get(c);
          if (raw === undefined) continue;
          const val = parseFloat(raw);
          if (!isNaN(val)) {
            switch (currentSection) {
              case "outwardTax": outwardTax[m][tk] += val; break;
              case "rcmTax": rcmTax[m][tk] += val; break;
              case "itcRcm": itcRcm[m][tk] += val; break;
              case "itcOther": itcOther[m][tk] += val; break;
              case "itcReversed": itcReversed[m][tk] += val; break;
              case "netItc": netItc[m][tk] += val; break;
              case "itcReclaimed": itcReclaimed[m][tk] += val; break;
            }
          }
        }
      }
      continue;
    }

    let matchedAnchor = "";
    for (const text of ANCHOR_TEXTS) {
      if (cn.includes(text)) { matchedAnchor = text; break; }
    }
    if (matchedAnchor) {
      const sec = ANCHOR_SECTIONS[matchedAnchor];
      if (sec === currentSection) {
        taxPosInSection.set(currentSection, (taxPosInSection.get(currentSection) ?? 0) + 4);
      } else {
        currentSection = sec;
        taxPosInSection.set(currentSection, 0);
      }
      continue;
    }

    if (currentSection === "sales summary") {
      if (!salesValueTaken) {
        salesValueTaken = true;
        for (const [m, c] of monthCol.entries()) {
          const raw = rowMap.get(c);
          if (raw === undefined) continue;
          const val = parseFloat(raw);
          if (!isNaN(val)) outwardTaxable[m] += val;
        }
      }
    }
  }

  for (const m of months) {
    for (const h of ["igst", "cgst", "sgst", "cess"] as const) {
      netItc[m][h] = itcRcm[m][h] + itcOther[m][h] - itcReversed[m][h];
    }
  }

  const tdsSectionPresent = sheet.rows.some((r) => {
    const rowMap = rowMapByRow.get(r.row);
    if (!rowMap) return false;
    const colA = rowMap.get(0) ?? "";
    return norm(colA).includes("table 12");
  });

  return {
    companyName, gstin, state, months,
    outwardTaxable, outwardTax, rcmTax, itcRcm, itcOther,
    itcReversed, netItc, itcReclaimed, tdsSectionPresent,
  };
}
