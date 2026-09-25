import { describe, expect, it } from "vitest";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import {
  buildLoansTemplateWorkbook,
  EMPTY_LOANS_TEMPLATE,
  parseLoansTemplate,
} from "../src/loans-file.js";
import { entry } from "./xlsx.test.js";

const errOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
};

/** A built template with chosen data rows spliced into its data-row arrays. */
const withRows = (
  rows: {
    parties?: Array<Array<string | number | null>>;
    specified?: Array<Array<string | number | null>>;
    st26?: Array<Array<string | number | null>>;
    settings?: Array<Array<string | number | null>>;
  },
  parties: { name: string }[] = [{ name: "Loan Creditor A" }, { name: "Loan Debtor B" }],
  opts: { defaultBankMode?: string } = {},
): Buffer => {
  const sheets: Sheet[] = buildLoansTemplateWorkbook(parties, opts as never).sheets;
  for (const s of sheets) {
    if (s.name === "Parties" && rows.parties) s.rows = rows.parties;
    else if (s.name === "Specified Sums" && rows.specified) s.rows = rows.specified;
    else if (s.name === "269ST" && rows.st26) s.rows = rows.st26;
    else if (s.name === "Settings" && rows.settings) s.rows = rows.settings;
  }
  return buildWorkbook(sheets);
};

describe("buildLoansTemplateWorkbook", () => {
  it("always writes the hidden Ledgers sheet and backs the ledger dropdown with its range", () => {
    const sheets = buildLoansTemplateWorkbook([{ name: "Loan Creditor A" }], {}).sheets;
    expect(sheets.find((s) => s.name === "Parties")).toBeDefined();
    expect(sheets.find((s) => s.name === "Specified Sums")).toBeDefined();
    expect(sheets.find((s) => s.name === "269ST")).toBeDefined();
    expect(sheets.find((s) => s.name === "Settings")).toBeDefined();
    const ledgers = sheets.find((s) => s.name === "Ledgers")!;
    expect(ledgers.rows).toEqual([["Loan Creditor A"]]);
    expect(ledgers.state).toBe("hidden");

    const buf = buildWorkbook(sheets);
    const workbookXml = entry(buf, "xl/workbook.xml");
    expect(workbookXml).toMatch(/sheet name="Ledgers"[^>]*state="hidden"/);
    // Parties is sheet 1: the dropdown binds to the Ledgers range (cross-sheet
    // reference, never a 255-char-capped inline name list).
    const xml = entry(buf, "xl/worksheets/sheet1.xml");
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$2</formula1>");
    // The mode dropdowns are inline list validations (no commas in the tokens).
    expect(xml).toContain("Cash-breach-declared");
  });

  it("writes an empty-but-present Ledgers sheet when no parties are known", () => {
    const ledgers = buildLoansTemplateWorkbook([], {}).sheets.find((s) => s.name === "Ledgers")!;
    expect(ledgers.rows).toEqual([]);
  });

  it("pre-fills the Settings Default bank mode from opts", () => {
    const sheets = buildLoansTemplateWorkbook([], { defaultBankMode: "RTGS" }).sheets;
    expect(sheets.find((s) => s.name === "Settings")!.rows).toEqual([
      ["Default bank mode", "RTGS"],
      ["Include exempt-party rows", null],
    ]);
  });
});

describe("parseLoansTemplate", () => {
  it("parses the blank generated template as EMPTY_LOANS_TEMPLATE", () => {
    expect(parseLoansTemplate(buildWorkbook(buildLoansTemplateWorkbook([], {}).sheets))).toEqual(
      EMPTY_LOANS_TEMPLATE,
    );
  });

  it("round-trips party facts, a specified sum, a bearer 269ST row and the Settings default", () => {
    const parsed = parseLoansTemplate(
      withRows(
        {
          parties: [["Loan Creditor A", "AAAPL1234A", "12 Site Road", "Y", "Net Banking", ""]],
          specified: [["Loan Debtor B", 125000.5, "", "", "IMPS", ""]],
          st26: [["Loan Creditor A", "Receipts", "20251014", 250000, "instalment", "Y"]],
        },
        [{ name: "Loan Creditor A" }, { name: "Loan Debtor B" }],
        { defaultBankMode: "RTGS" },
      ),
    );
    expect(parsed.parties).toEqual([
      {
        ledger: "Loan Creditor A",
        panOrAadhaar: "AAAPL1234A",
        address: "12 Site Road",
        exempt: true,
        modeOverrideAccepted: "Net Banking",
        modeOverrideRepaid: undefined,
      },
    ]);
    expect(parsed.specifiedSums).toEqual([
      {
        party: "Loan Debtor B",
        amount: 125000.5,
        mode: "IMPS",
      },
    ]);
    expect(parsed.st26Declarations).toEqual([
      {
        party: "Loan Creditor A",
        type: "Receipts",
        date: "20251014",
        amount: 250000,
        nature: "instalment",
        bearer: "Y",
      },
    ]);
    expect(parsed.defaultBankMode).toBe("RTGS");
  });

  it("rejects a bad mode enum citing the cell address, never the value", () => {
    const msg = errOf(() =>
      parseLoansTemplate(withRows({ parties: [["Loan Creditor A", "", "", "", "Bitcoin三百", ""]] })),
    );
    expect(msg).toMatch(/^template Parties row 2, column E \(Mode accepted\): /);
    expect(msg).not.toContain("Bitcoin");
  });

  it("rejects a duplicate ledger row citing both row numbers", () => {
    const msg = errOf(() =>
      parseLoansTemplate(
        withRows({
          parties: [
            ["Loan Debtor B"],
            ["Loan Creditor A"],
            ["Loan Debtor B"],
          ],
        }),
      ),
    );
    expect(msg).toMatch(/^template Parties row 4, column A \(Tally ledger\): .* row 2/);
  });

  it("rejects blank required fields on 269ST, citing the address only", () => {
    expect(
      errOf(() => parseLoansTemplate(withRows({ st26: [["", "Receipts", "20251014", 100, "", ""]] }))),
    ).toMatch(/^template 269ST row 2, column A \(Tally ledger\): required cell is blank$/);
    expect(
      errOf(() => parseLoansTemplate(withRows({ st26: [["Party P", "", "20251014", 100, "", ""]] }))),
    ).toMatch(/^template 269ST row 2, column B \(Type\): /);
    expect(
      errOf(() => parseLoansTemplate(withRows({ st26: [["Party P", "Receipts", "", 100, "", ""]] }))),
    ).toMatch(/^template 269ST row 2, column C \(Date\): required cell is blank$/);
    expect(
      errOf(() =>
        parseLoansTemplate(withRows({ st26: [["Party P", "Receipts", "20251014", null, "", ""]] })),
      ),
    ).toMatch(/^template 269ST row 2, column D \(Amount\): required cell is blank$/);
  });

  it("rejects a bad Settings Default bank mode citing the address, and parses a valid one when Settings is the only carrier", () => {
    const msg = errOf(() =>
      parseLoansTemplate(withRows({ settings: [["Default bank mode", "Carrier Pigeon"]] }, [], {})),
    );
    expect(msg).toMatch(/^template Settings row 2, column B \(Value\): /);
    expect(msg).not.toContain("Carrier Pigeon");
    const ok = parseLoansTemplate(withRows({ settings: [["Default bank mode", "NEFT"]] }, [], {}));
    expect(ok.defaultBankMode).toBe("NEFT");
  });

  it("leaves defaultBankMode undefined when the Settings value is blank", () => {
    const parsed = parseLoansTemplate(
      withRows({ settings: [["Default bank mode", ""]] }, [{ name: "Loan Creditor A" }]),
    );
    expect(parsed.defaultBankMode).toBeUndefined();
  });

  it("rejects a workbook that lost a required sheet, naming only sheet names", () => {
    const sheets = buildLoansTemplateWorkbook([], {}).sheets.filter((s) => s.name !== "Specified Sums");
    const msg = errOf(() => parseLoansTemplate(buildWorkbook(sheets)));
    expect(msg).toMatch(/^template sheet missing: .*Parties, Specified Sums, 269ST/);
    expect(msg).toContain("Settings");
  });
});
