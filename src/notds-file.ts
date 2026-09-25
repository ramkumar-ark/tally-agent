import {
  isNrSectionSpelling,
  NR_SECTIONS,
  RESIDENT_SECTIONS,
  type NotdsSheetKey,
} from "./notds.js";
import { NOTDS_CURE_REASONS, NOTDS_SHEET_KEYS } from "./notds-template.js";
import {
  accessors,
  amountCell,
  bindColumns,
  colLetter,
  dateCell,
  dataRows,
  enumCell,
  normHeader,
  raw,
  textCell,
  type CellRef,
} from "./tds-file.js";
import { readWorkbook, type GridCell } from "./xlsx-read.js";

/**
 * The clause 21(b) operator decisions workbook, parsed back. The error
 * contract is `src/tds-file.ts`'s: every fault cites the sheet, the Excel row
 * and the column letter with its header — never a cell value, which a stray
 * operator cell can make a PAN or an Aadhaar (R-P-9). Structural problems
 * reject the whole file: a half-read sheet can never drive a confident
 * compliance fill. Design of record: §4 (Task 6) of
 * docs/design/2026-09-24-no-tds-disallowance-design.md.
 */

export interface NotdsDecision {
  key: string; // matches NoTdsCandidateRow.key (`canonicalKey(party)|date|voucher|section`)
  include: boolean; // blank Include = true
  cure?: string; // the dropdown token, required when include === false
  residency: "R" | "NR";
  nrSection?: string; // required when residency === "NR" (Winman spelling)
  nature?: string;
  address?: string;
  city?: string;
  state?: string;
  pin?: string;
  country?: string;
  pan?: string;
  amountOverride?: number;
  reason?: string;
}

export interface NotdsManualRow {
  sheet: NotdsSheetKey;
  party: string;
  date: string;
  amount: number;
  deducted: number;
  deposited: number;
  section?: string;
  nature?: string;
  pan?: string;
  address?: string;
  city?: string;
  state?: string;
  pin?: string;
  country?: string;
}

export interface NotdsOperatorFile {
  decisions: Map<string, NotdsDecision>;
  manual: NotdsManualRow[];
}

/** What a blank/absent-sheet parse yields — the all-include, all-resident default. */
export const EMPTY_NOTDS_OPERATOR: NotdsOperatorFile = {
  decisions: new Map(),
  manual: [],
};

/** The template's Include cell: blank and Y mean include, N excludes, nothing else. */
function include(ref: CellRef, cell: GridCell | undefined): boolean {
  const s = String(raw(cell).value ?? "").trim().toLowerCase();
  if (s === "" || s === "y") return true;
  if (s === "n") return false;
  throw new Error(
    `template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): enter Y or N, or leave blank`,
  );
}

/**
 * Parse the No-TDS operator decisions workbook back. The Instructions and
 * hidden Lists sheets are never read; the Candidates and Manual Rows sheets
 * are each optional (a manual-only template, or rows the operator left
 * blank), a workbook carrying neither yields `EMPTY_NOTDS_OPERATOR`. Amount
 * Override and the three tax columns are numbers ≥ 0; dates come through
 * `dateCell`, so a `no date` cell rejects the file before any decision is
 * trusted. A missing NR Section on an NR row rejects the row, and the NR
 * Section spelling must sit on the NR sheet's 16-value list — a resident-list
 * spelling (Review Focus #3) is rejected there exactly like any unknown one.
 */
export function parseNotdsTemplate(buf: Buffer): NotdsOperatorFile {
  const sheets = readWorkbook(buf);
  const find = (name: string) =>
    sheets.find((s) => normHeader(s.name) === normHeader(name));

  const decisions: Map<string, NotdsDecision> = new Map();
  const manual: NotdsManualRow[] = [];

  const candsSheet = find("Candidates");
  if (candsSheet) {
    const cols = accessors(
      bindColumns(candsSheet, [
        { header: "Key" },
        { header: "PAN" },
        { header: "Include" },
        { header: "Cure Reason" },
        { header: "Residency" },
        { header: "NR Section" },
        { header: "Nature of Payment" },
        { header: "Address" },
        { header: "City" },
        { header: "State" },
        { header: "PIN" },
        { header: "Country" },
        { header: "Amount Override", aliases: ["Amount override", "Override"] },
        { header: "Notes" },
      ]),
    );
    const seenCands = new Map<string, number>(); // candidate key → first Excel row
    for (const r of dataRows(candsSheet)) {
      const at = (header: string): CellRef => ({
        sheet: candsSheet,
        row: r,
        col: cols.get(header)!,
        header,
      });
      const key = textCell(at("Key"), r.cells.get(cols.get("Key")!));
      if (key === undefined) {
        throw new Error(
          `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Key")!)} (Key): required cell is blank`,
        );
      }
      const prevRow = seenCands.get(key);
      if (prevRow !== undefined) {
        throw new Error(
          `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Key")!)} (Key): this candidate key already appears in row ${prevRow}`,
        );
      }

      const dec: NotdsDecision = {
        key,
        include: include(at("Include"), r.cells.get(cols.get("Include")!)),
        residency: "R",
      };
      const cure = textCell(at("Cure Reason"), r.cells.get(cols.get("Cure Reason")!));
      if (cure !== undefined) {
        const hit = NOTDS_CURE_REASONS.find((a) => a.toLowerCase() === cure.toLowerCase());
        if (hit === undefined) {
          throw new Error(
            `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Cure Reason")!)} (Cure Reason): not a cure reason — use the dropdown`,
          );
        }
        dec.cure = hit;
      }
      if (!dec.include && dec.cure === undefined) {
        throw new Error(
          `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Cure Reason")!)} (Cure Reason): required when Include is N — pick a cure reason`,
        );
      }
      const residency = textCell(at("Residency"), r.cells.get(cols.get("Residency")!));
      if (residency !== undefined) {
        const hit = ["R", "NR"].find((a) => a.toLowerCase() === residency.toLowerCase());
        if (hit === undefined) {
          throw new Error(
            `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Residency")!)} (Residency): enter R or NR, or leave blank`,
          );
        }
        dec.residency = hit as "R" | "NR";
      }
      for (const [header, field] of [
        ["Nature of Payment", "nature"],
        ["Address", "address"],
        ["City", "city"],
        ["State", "state"],
        ["PIN", "pin"],
        ["Country", "country"],
        ["PAN", "pan"],
        ["Notes", "reason"],
      ] as const) {
        const v = textCell(at(header), r.cells.get(cols.get(header)!));
        if (v !== undefined) dec[field] = v;
      }
      if (dec.residency === "NR") {
        const nr = textCell(at("NR Section"), r.cells.get(cols.get("NR Section")!));
        if (nr === undefined) {
          throw new Error(
            `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("NR Section")!)} (NR Section): required when Residency is NR — pick the TDS section`,
          );
        }
        if (!isNrSectionSpelling(nr)) {
          throw new Error(
            `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("NR Section")!)} (NR Section): not a TDS section for a non-resident deductee — use the dropdown`,
          );
        }
        dec.nrSection = nr;
      }
      const override = raw(r.cells.get(cols.get("Amount Override")!));
      if (override.value !== null && String(override.value).trim() !== "") {
        const n = amountCell(at("Amount Override"), override);
        if (n < 0) {
          throw new Error(
            `template ${candsSheet.name} row ${r.row}, column ${colLetter(cols.get("Amount Override")!)} (Amount Override): amount cannot be negative`,
          );
        }
        dec.amountOverride = n;
      }
      decisions.set(key, dec);
      seenCands.set(key, r.row);
    }
  }

  const manualSheet = find("Manual Rows");
  if (manualSheet) {
    const cols = accessors(
      bindColumns(manualSheet, [
        { header: "Sheet" },
        { header: "Party" },
        { header: "Date" },
        { header: "Amount" },
        { header: "Tax/Levy Deducted" },
        { header: "Tax/Levy Deposited" },
        { header: "Section" },
        { header: "Nature of Payment" },
        { header: "PAN/Aadhaar" },
        { header: "Address" },
        { header: "City" },
        { header: "State" },
        { header: "PIN" },
        { header: "Country" },
        { header: "Notes" },
      ]),
    );
    const seen = new Map<string, number>(); // sheet|party|date|amount → Excel row
    for (const r of dataRows(manualSheet)) {
      const at = (header: string): CellRef => ({
        sheet: manualSheet,
        row: r,
        col: cols.get(header)!,
        header,
      });
      const sheetKey = enumCell(
        at("Sheet"),
        r.cells.get(cols.get("Sheet")!),
        [...NOTDS_SHEET_KEYS],
        "not a clause 21(b) sheet — use the dropdown",
      ) as NotdsSheetKey;
      const party = textCell(at("Party"), r.cells.get(cols.get("Party")!));
      if (party === undefined) {
        throw new Error(
          `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get("Party")!)} (Party): required cell is blank`,
        );
      }
      const date = dateCell(at("Date"), r.cells.get(cols.get("Date")!));
      const amount = amountCell(at("Amount"), r.cells.get(cols.get("Amount")!));
      const deducted = amountCell(at("Tax/Levy Deducted"), r.cells.get(cols.get("Tax/Levy Deducted")!));
      const deposited = amountCell(at("Tax/Levy Deposited"), r.cells.get(cols.get("Tax/Levy Deposited")!));
      for (const [header, n] of [["Amount", amount], ["Tax/Levy Deducted", deducted], ["Tax/Levy Deposited", deposited]] as const) {
        if (n < 0) {
          throw new Error(
            `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get(header)!)} (${header}): amount cannot be negative`,
          );
        }
      }

      const dupKey = `${normHeader(sheetKey)}|${normHeader(party)}|${date}|${amount}`;
      if (seen.has(dupKey)) {
        throw new Error(
          `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get("Party")!)} (Party): this sheet-party-date-amount row already appears in row ${seen.get(dupKey)}`,
        );
      }
      seen.set(dupKey, r.row);

      const row: NotdsManualRow = { sheet: sheetKey, party, date, amount, deducted, deposited };
      const section = textCell(at("Section"), r.cells.get(cols.get("Section")!));
      // Per-sheet law: the resident sheet validates against its 32-value list,
      // the NR sheet against the 16-value NR list; the levy and salary sheets
      // take no section at all — a filled one is rejected rather than
      // silently dropped (the whole-file-reject contract).
      if (sheetKey === "40(a)(ia) to resident") {
        if (section !== undefined && !RESIDENT_SECTIONS.some((s) => s.toLowerCase() === section.toLowerCase())) {
          throw new Error(
            `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get("Section")!)} (Section): not a TDS section for sheet "${sheetKey}" — use the dropdown`,
          );
        }
        if (section !== undefined) row.section = section;
      } else if (sheetKey === "40(a)(i) to non-resident") {
        if (section !== undefined && !NR_SECTIONS.some((s) => s.toLowerCase() === section.toLowerCase())) {
          throw new Error(
            `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get("Section")!)} (Section): not a TDS section for sheet "${sheetKey}" — use the dropdown`,
          );
        }
        if (section !== undefined) row.section = section;
      } else if (section !== undefined) {
        throw new Error(
          `template ${manualSheet.name} row ${r.row}, column ${colLetter(cols.get("Section")!)} (Section): sheet "${sheetKey}" takes no section — leave the column blank`,
        );
      }
      for (const [header, field] of [
        ["Nature of Payment", "nature"],
        ["PAN/Aadhaar", "pan"],
        ["Address", "address"],
        ["City", "city"],
        ["State", "state"],
        ["PIN", "pin"],
        ["Country", "country"],
      ] as const) {
        const v = textCell(at(header), r.cells.get(cols.get(header)!));
        if (v !== undefined) row[field] = v;
      }
      manual.push(row);
    }
  }

  return { decisions, manual };
}
