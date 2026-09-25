import {
  accessors,
  amountCell,
  bindColumns,
  colLetter,
  dataRows,
  dateCell,
  enumCell,
  normHeader,
  raw,
  textCell,
  type CellRef,
} from "./tds-file.js";
import { readWorkbook, type GridSheet } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import type { LoansOperatorParty, LoansSheetRow } from "./loans.js";
import {
  NONAC_MODES,
  RECEIPT_MODES,
  type NonAcMode,
  type ReceiptMode,
} from "./loans-law.js";
import type { Sheet } from "./xlsx.js";

/**
 * The fillable loans operator template for clause 31 (l.269SS/l.269T) and
 * l.269ST — the Excel sibling of the TDS and 26AS mapping templates (Task 5).
 *
 * Like src/as26-template.ts it is written DIRECTLY by the workbook writer:
 * it carries real ledger names (and the operator's own PAN/Aadhaar entries)
 * on the operator's disk and nothing in it is ever masked; the reader side
 * reuses src/tds-file.ts's located/bind/read cell helpers so the error
 * contract matches the parser family exactly.
 */

export interface LoansTemplatePartyRow {
  ledger: string;
  panOrAadhaar?: string;
  address?: string;
  exempt?: "Y" | "";
  modeAccepted?: string;
  modeRepaid?: string;
}

export interface LoansTemplateSpecifiedSum {
  party: string;
  amount: number;
  panOrAadhaar?: string;
  address?: string;
  mode?: ReceiptMode;
  nonAcMode?: NonAcMode;
}

export interface LoansTemplateSt26 {
  party: string;
  type: "Payments" | "Receipts";
  date: string;
  amount: number;
  nature?: string;
  bearer?: "Y" | "";
}

export interface LoansTemplateParsed {
  parties: LoansOperatorParty[];
  specifiedSums: LoansSheetRow[];
  st26Declarations: LoansSheetRow[];
  defaultBankMode?: ReceiptMode;
}

const LEDGER_MODES: string[] = [...RECEIPT_MODES, "Cash-breach-declared"];

/** Dedupe ledger names canonically, keeping the first spelling seen. */
function dedupeLedgers(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n.trim();
    if (!t) continue;
    const k = canonicalKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function ledgersSheet(ledgers: string[]): Sheet {
  return {
    name: "Ledgers",
    // Hidden always: it is the dropdown's backing range, not an operator page.
    // Rows are data only — the header comes from columns in buildWorkbook.
    state: "hidden",
    columns: [{ header: "Tally ledger", width: 40, format: "text" }],
    rows: ledgers.map((l) => [l]),
  };
}

const ledgerValidation = (lastRow: number): Sheet["columns"][number]["validation"] => ({
  formula: `Ledgers!$A$2:$A$${lastRow}`,
});

/**
 * Build the template's sheets (fed to buildWorkbook by the caller). The
 * `Ledgers` sheet carries the known loan parties and backs every ledger
 * column's dropdown by a range reference; the mode columns ride inline list
 * validations (the mode tokens contain no commas, unlike ledger names).
 */
export function buildLoansTemplateWorkbook(
  parties: { name: string }[],
  opts: { defaultBankMode?: ReceiptMode },
): { sheets: Sheet[] } {
  const ledgers = dedupeLedgers(parties.map((p) => p.name));
  const ledgerCol = (
    width: number,
    withValidation: boolean,
  ): Sheet["columns"][number] => ({
    header: "Tally ledger",
    width,
    format: "text",
    ...(withValidation ? { validation: ledgerValidation(ledgers.length + 1) } : {}),
  });
  const ledgerModeDropdown = { list: LEDGER_MODES };

  const sheets: Sheet[] = [
    {
      name: "Parties",
      columns: [
        ledgerCol(34, ledgers.length > 0),
        { header: "PAN or Aadhaar", width: 20, format: "text" },
        { header: "Address", width: 34, format: "text" },
        { header: "Exempt", width: 8, format: "text" },
        { header: "Mode accepted", width: 22, format: "text", validation: ledgerModeDropdown },
        { header: "Mode repaid", width: 22, format: "text", validation: ledgerModeDropdown },
      ],
      rows: ledgers.map((l) => [l]),
    },
    {
      name: "Specified Sums",
      columns: [
        ledgerCol(34, ledgers.length > 0),
        { header: "Amount", width: 14, format: "money" },
        { header: "PAN or Aadhaar", width: 20, format: "text" },
        { header: "Address", width: 34, format: "text" },
        { header: "Mode", width: 22, format: "text", validation: { list: [...RECEIPT_MODES] } },
        {
          header: "Non-ac mode",
          width: 22,
          format: "text",
          validation: { list: [...NONAC_MODES] },
        },
      ],
      rows: [],
    },
    {
      name: "269ST",
      columns: [
        ledgerCol(34, ledgers.length > 0),
        { header: "Type", width: 10, format: "text", validation: { list: ["Payments", "Receipts"] } },
        { header: "Date", width: 12, format: "text" },
        { header: "Amount", width: 14, format: "money" },
        { header: "Nature", width: 30, format: "text" },
        { header: "Bearer", width: 8, format: "text" },
      ],
      rows: [],
    },
    {
      name: "Settings",
      columns: [
        { header: "Setting", width: 30, format: "text" },
        { header: "Value", width: 22, format: "text", validation: { list: [...RECEIPT_MODES, "Y"] } },
      ],
      rows: [
        ["Default bank mode", opts.defaultBankMode ?? null],
        ["Include exempt-party rows", null],
      ],
    },
    ledgersSheet(ledgers),
  ];
  return { sheets };
}

/** Same contract as src/tds-file.ts's locatedSheet, with the loans sheet list. */
function needSheet(sheets: GridSheet[], name: string): GridSheet {
  const s = sheets.find((x) => normHeader(x.name) === normHeader(name));
  if (!s) {
    throw new Error(
      `template sheet missing: the workbook must carry Parties, Specified Sums, 269ST and Settings — ` +
        `this file has: ${sheets.map((x) => x.name).join(", ") || "none"}`,
    );
  }
  return s;
}

/**
 * Parse a filled loans operator template. Blank rows are skipped (the blank
 * generated template parses as EMPTY_LOANS_TEMPLATE); a non-blank row with a
 * blank required field, a bad mode token or a duplicate ledger refuses and
 * cites the sheet, row, column and header — never a cell value.
 */
export function parseLoansTemplate(buf: Buffer): LoansTemplateParsed {
  const sheets = readWorkbook(buf);

  const partiesSheet = needSheet(sheets, "Parties");
  const partyCols = accessors(
    bindColumns(partiesSheet, [
      { header: "Tally ledger" },
      { header: "PAN or Aadhaar" },
      { header: "Address" },
      { header: "Exempt" },
      { header: "Mode accepted" },
      { header: "Mode repaid" },
    ]),
  );
  const seenLedger = new Map<string, number>();
  const parties: LoansOperatorParty[] = dataRows(partiesSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({
      sheet: partiesSheet,
      row: r,
      col,
      header,
    });
    const ledgerCol = partyCols.get("Tally ledger")!;
    const ledger = textCell(at(ledgerCol, "Tally ledger"), r.cells.get(ledgerCol));
    if (ledger === undefined) {
      throw new Error(
        `template Parties row ${r.row}, column ${colLetter(ledgerCol)} (Tally ledger): required cell is blank`,
      );
    }
    const key = canonicalKey(ledger);
    if (seenLedger.has(key)) {
      throw new Error(
        `template Parties row ${r.row}, column A (Tally ledger): this ledger already appears in row ${seenLedger.get(key)} — one row per loan party`,
      );
    }
    seenLedger.set(key, r.row);

    const panCol = partyCols.get("PAN or Aadhaar")!;
    // A numeric-looking PAN/Aadhaar means Excel mangled the column; it is
    // never echoed either way — textCell cites the address only.
    const panValue = textCell(at(panCol, "PAN or Aadhaar"), r.cells.get(panCol));

    const exemptCol = partyCols.get("Exempt")!;
    let exempt: boolean | undefined;
    const exemptRaw = String(raw(r.cells.get(exemptCol)).value ?? "").trim().toLowerCase();
    if (exemptRaw === "y" || exemptRaw === "yes") exempt = true;
    else if (exemptRaw !== "") {
      throw new Error(
        `template Parties row ${r.row}, column ${colLetter(exemptCol)} (Exempt): enter Y or leave it blank`,
      );
    }

    const modeCol = (header: string): string | undefined => {
      const col = partyCols.get(header)!;
      const ref = at(col, header);
      const v = String(raw(r.cells.get(col)).value ?? "").trim().toLowerCase();
      if (v === "") return undefined;
      return enumCell(ref, r.cells.get(col), LEDGER_MODES, "not a receipt mode — use the dropdown");
    };
    const accepted = modeCol("Mode accepted");
    const repaid = modeCol("Mode repaid");

    const row: LoansOperatorParty = { ledger };
    if (panValue !== undefined) row.panOrAadhaar = panValue;
    if (exempt === true) row.exempt = true;
    if (accepted !== undefined) row.modeOverrideAccepted = accepted as LoansOperatorParty["modeOverrideAccepted"];
    if (repaid !== undefined) row.modeOverrideRepaid = repaid as LoansOperatorParty["modeOverrideRepaid"];
    const addressCol = partyCols.get("Address")!;
    const address = textCell(at(addressCol, "Address"), r.cells.get(addressCol));
    if (address !== undefined) row.address = address;
    return row;
  });

  const specifiedSheet = needSheet(sheets, "Specified Sums");
  const specCols = accessors(
    bindColumns(specifiedSheet, [
      { header: "Tally ledger" },
      { header: "Amount" },
      { header: "PAN or Aadhaar" },
      { header: "Address" },
      { header: "Mode" },
      { header: "Non-ac mode" },
    ]),
  );
  const specifiedSums: LoansSheetRow[] = dataRows(specifiedSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({
      sheet: specifiedSheet,
      row: r,
      col,
      header,
    });
    const partyCol = specCols.get("Tally ledger")!;
    const party = textCell(at(partyCol, "Tally ledger"), r.cells.get(partyCol));
    if (party === undefined) {
      throw new Error(
        `template Specified Sums row ${r.row}, column ${colLetter(partyCol)} (Tally ledger): required cell is blank`,
      );
    }
    const amountCol = specCols.get("Amount")!;
    const amountRaw = raw(r.cells.get(amountCol)).value;
    if (amountRaw === null || String(amountRaw).trim() === "") {
      throw new Error(
        `template Specified Sums row ${r.row}, column ${colLetter(amountCol)} (Amount): required cell is blank`,
      );
    }
    const amount = amountCell(at(amountCol, "Amount"), r.cells.get(amountCol));

    const optionalText = (header: string): string | undefined => {
      const col = specCols.get(header)!;
      return textCell(at(col, header), r.cells.get(col));
    };
    const modeOf = (header: string, allowed: readonly string[], when: string): string | undefined => {
      const col = specCols.get(header)!;
      const ref = at(col, header);
      if (String(raw(r.cells.get(col)).value ?? "").trim() === "") return undefined;
      return enumCell(ref, r.cells.get(col), allowed as string[], when);
    };

    const row: LoansSheetRow = { party, amount };
    const pan = optionalText("PAN or Aadhaar");
    if (pan !== undefined) row.panAlias = pan;
    const address = optionalText("Address");
    if (address !== undefined) row.address = address;
    const mode = modeOf("Mode", RECEIPT_MODES, "not a receipt mode — use the dropdown");
    if (mode !== undefined) row.mode = mode as ReceiptMode;
    const nonAc = modeOf("Non-ac mode", NONAC_MODES, "not a non-account-payee mode — use the dropdown");
    if (nonAc !== undefined) row.nonAcMode = nonAc as NonAcMode;
    return row;
  });

  const st26Sheet = needSheet(sheets, "269ST");
  const st26Cols = accessors(
    bindColumns(st26Sheet, [
      { header: "Tally ledger" },
      { header: "Type" },
      { header: "Date" },
      { header: "Amount" },
      { header: "Nature" },
      { header: "Bearer" },
    ]),
  );
  const st26Declarations: LoansSheetRow[] = dataRows(st26Sheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({
      sheet: st26Sheet,
      row: r,
      col,
      header,
    });
    const partyCol = st26Cols.get("Tally ledger")!;
    const party = textCell(at(partyCol, "Tally ledger"), r.cells.get(partyCol));
    if (party === undefined) {
      throw new Error(
        `template 269ST row ${r.row}, column ${colLetter(partyCol)} (Tally ledger): required cell is blank`,
      );
    }
    const typeCol = st26Cols.get("Type")!;
    const type = enumCell(
      at(typeCol, "Type"),
      r.cells.get(typeCol),
      ["Payments", "Receipts"],
      "use the dropdown (Payments or Receipts)",
    ) as LoansSheetRow["type"];
    const dateCol = st26Cols.get("Date")!;
    const dateRaw = raw(r.cells.get(dateCol)).value;
    if (dateRaw === null || String(dateRaw).trim() === "") {
      throw new Error(
        `template 269ST row ${r.row}, column ${colLetter(dateCol)} (Date): required cell is blank`,
      );
    }
    const date = dateCell(at(dateCol, "Date"), r.cells.get(dateCol));
    const amountCol = st26Cols.get("Amount")!;
    const amountRaw = raw(r.cells.get(amountCol)).value;
    if (amountRaw === null || String(amountRaw).trim() === "") {
      throw new Error(
        `template 269ST row ${r.row}, column ${colLetter(amountCol)} (Amount): required cell is blank`,
      );
    }
    const amount = amountCell(at(amountCol, "Amount"), r.cells.get(amountCol));

    const natureCol = st26Cols.get("Nature")!;
    const nature = textCell(at(natureCol, "Nature"), r.cells.get(natureCol));
    const bearerCol = st26Cols.get("Bearer")!;
    let bearer: "Y" | "" | undefined;
    const bearerRaw = String(raw(r.cells.get(bearerCol)).value ?? "").trim().toLowerCase();
    if (bearerRaw === "y" || bearerRaw === "yes") bearer = "Y";
    else if (bearerRaw !== "") {
      throw new Error(
        `template 269ST row ${r.row}, column ${colLetter(bearerCol)} (Bearer): enter Y or leave it blank`,
      );
    }

    const row: LoansSheetRow = { party, amount, type, date };
    if (nature !== undefined) row.nature = nature;
    if (bearer) row.bearer = bearer;
    return row;
  });

  const parsed: LoansTemplateParsed = { parties, specifiedSums, st26Declarations };

  // Settings is last-read and optional: a template filled before it existed
  // (or an operator-deleted sheet) leaves every setting undefined; Task 3's
  // DEFAULT_BANK_MODE fallback covers an absent mode downstream.
  const settingsSheet = sheets.find((x) => normHeader(x.name) === normHeader("Settings"));
  if (settingsSheet) {
    let defaultBankModeRow = 0;
    const settingsCols = accessors(
      bindColumns(settingsSheet, [{ header: "Setting" }, { header: "Value" }]),
    );
    for (const r of dataRows(settingsSheet)) {
      const at = (col: number, header: string): CellRef => ({
        sheet: settingsSheet,
        row: r,
        col,
        header,
      });
      const settingCol = settingsCols.get("Setting")!;
      const setting = textCell(at(settingCol, "Setting"), r.cells.get(settingCol));
      if (setting === undefined) {
        throw new Error(
          `template Settings row ${r.row}, column ${colLetter(settingCol)} (Setting): required cell is blank`,
        );
      }
      const s = normHeader(setting);
      const valueCol = settingsCols.get("Value")!;
      const value = textCell(at(valueCol, "Value"), r.cells.get(valueCol));
      if (s === "default bank mode") {
        if (value !== undefined) {
          if (parsed.defaultBankMode !== undefined) {
            throw new Error(
              `template Settings row ${r.row}, column ${colLetter(valueCol)} (Value): "Default bank mode" already set in row ${defaultBankModeRow}`,
            );
          }
          parsed.defaultBankMode = enumCell(
            at(valueCol, "Value"),
            r.cells.get(valueCol),
            [...RECEIPT_MODES],
            "not a receipt mode — use the dropdown",
          ) as ReceiptMode;
          defaultBankModeRow = r.row;
        }
      } else if (s !== "include exempt-party rows") {
        throw new Error(
          `template Settings row ${r.row}, column ${colLetter(settingCol)} (Setting): not a known setting — the settings are "Default bank mode" and "Include exempt-party rows"`,
        );
      }
    }
  }

  if (parsed.defaultBankMode === undefined) delete parsed.defaultBankMode;
  return parsed;
}

export const EMPTY_LOANS_TEMPLATE: LoansTemplateParsed = {
  parties: [],
  specifiedSums: [],
  st26Declarations: [],
};
