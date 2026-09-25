import { describe, expect, it } from "vitest";
import {
  EMPTY_NOTDS_OPERATOR,
  parseNotdsTemplate,
  type NotdsOperatorFile,
} from "../src/notds-file.js";
import { buildNotdsTemplate } from "../src/notds-template.js";
import type { NoTdsCandidateRow, NotdsSheetKey } from "../src/notds.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";

/**
 * Template-parse tests over workbooks built with the generator's headers
 * through the project's own writer (the test/tds-template-parse.test.ts
 * precedent: the reader holds no grid→Buffer writer, so "mutating a
 * buildNotdsTemplate output" means rebuilding the same sheets with mutated
 * cells). Planted PAN-shaped strings ride the offending cells of the fault
 * cases and every assertion checks the message never echoes the value —
 * those strings are invented fixtures, never a real identifier.
 */
const PAN = "ABCCS1234A";

function message(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type CellRow = Array<string | number | null>;

const candidate = (over: Partial<NoTdsCandidateRow> = {}): NoTdsCandidateRow => ({
  key: "samplebasicsllp|20260115|2|194-I(a)",
  party: "Sample Basics LLP",
  date: "20260115",
  voucherNumber: "2",
  gross: 100000,
  tdsDone: 0,
  tdsDeposited: 0,
  depositDate: null,
  section: "194-I(a)",
  liability: 20000,
  pan: null,
  panFromGstin: false,
  ...over,
});

const CAND_HEADERS = [
  "Key", "Party", "Date", "Voucher", "Section",
  "Gross", "TDS Done", "TDS Deposited", "Deposit Date", "Liability", "PAN",
  "Include", "Cure Reason", "Residency", "NR Section",
  "Nature of Payment", "Address", "City", "State", "PIN", "Country",
  "Amount Override", "Notes",
];

const MANUAL_HEADERS = [
  "Sheet", "Party", "Date", "Amount", "Tax/Levy Deducted", "Tax/Levy Deposited",
  "Section", "Nature of Payment", "PAN/Aadhaar", "Address", "City", "State",
  "PIN", "Country", "Notes",
];

const dataSheet = (name: string, headers: string[], rows: CellRow[]): Sheet => ({
  name,
  columns: headers.map((header) => ({ header })),
  rows,
});

/** A workbook shaped like the generator's, with the requested sheets omitted. */
function wb(
  candidates: CellRow[] = [],
  manual: CellRow[] = [],
  omit: string[] = [],
): Buffer {
  const sheets: Sheet[] = [
    { name: "Instructions", columns: [{ header: "How to fill this template" }], rows: [["fill me"]] },
  ].concat(
    omit.includes("Candidates")
      ? []
      : [{ name: "Candidates", columns: CAND_HEADERS.map((header) => ({ header })), rows: candidates }],
  ).concat(
    omit.includes("Manual Rows")
      ? []
      : [{ name: "Manual Rows", columns: MANUAL_HEADERS.map((header) => ({ header })), rows: manual }],
  );
  return buildWorkbook(sheets);
}

const manualRow = (
  sheet: NotdsSheetKey,
  over: Partial<Record<string, string | number | null>> = {},
): CellRow => [
  sheet,
  (over.Party as string) ?? "Sample Traders",
  (over.Date as string) ?? "2026-02-05",
  (over.Amount as number) ?? 40000,
  (over["Tax/Levy Deducted"] as number) ?? null,
  (over["Tax/Levy Deposited"] as number) ?? null,
  (over.Section as string) ?? null,
  (over["Nature of Payment"] as string) ?? null,
  (over["PAN/Aadhaar"] as string) ?? null,
  (over.Address as string) ?? null,
  (over.City as string) ?? null,
  (over.State as string) ?? null,
  (over.PIN as string) ?? null,
  (over.Country as string) ?? null,
  (over.Notes as string) ?? null,
];

const candidateRow = (over: Partial<Record<string, string | number | null>> = {}): CellRow => [
  (over.Key as string) ?? "samplebasicsllp|20260115|2|194-I(a)",
  (over.Party as string) ?? "Sample Basics LLP",
  (over.Date as string) ?? "2026-01-15",
  (over.Voucher as string) ?? "2",
  (over.Section as string) ?? "194I (a)",
  (over.Gross as number) ?? 100000,
  (over["TDS Done"] as number) ?? null,
  (over["TDS Deposited"] as number) ?? null,
  (over["Deposit Date"] as string) ?? null,
  (over.Liability as number) ?? 20000,
  (over.PAN as string) ?? null,
  (over.Include as string) ?? null,
  (over["Cure Reason"] as string) ?? null,
  (over.Residency as string) ?? null,
  (over["NR Section"] as string) ?? null,
  (over["Nature of Payment"] as string) ?? null,
  (over.Address as string) ?? null,
  (over.City as string) ?? null,
  (over.State as string) ?? null,
  (over.PIN as string) ?? null,
  (over.Country as string) ?? null,
  (over["Amount Override"] as number) ?? null,
  (over.Notes as string) ?? null,
];

const EMPTY: NotdsOperatorFile = EMPTY_NOTDS_OPERATOR;

describe("parseNotdsTemplate — blank sheets and missing sheets", () => {
  it("parses the freshly generated blank template to EMPTY_NOTDS_OPERATOR", () => {
    expect(parseNotdsTemplate(buildNotdsTemplate({ company: "Sample Company", candidates: [], generatedOn: "20260925" })))
      .toEqual({ decisions: new Map(), manual: [] });
    expect(EMPTY.decisions.size).toBe(0);
    expect(EMPTY.manual).toEqual([]);
  });

  it("treats a Candidates sheet with rows but no decisions as all-include resident", () => {
    const op = parseNotdsTemplate(buildNotdsTemplate({ company: "c", candidates: [candidate()], generatedOn: "20260925" }));
    expect([...op.decisions.entries()]).toEqual([
      [
        "samplebasicsllp|20260115|2|194-I(a)",
        { key: "samplebasicsllp|20260115|2|194-I(a)", include: true, residency: "R" },
      ],
    ]);
    expect(op.manual).toEqual([]);
  });

  it("returns the empty result when neither data sheet exists", () => {
    expect(parseNotdsTemplate(wb([], [], ["Candidates", "Manual Rows"]))).toEqual({ decisions: new Map(), manual: [] });
  });

  it("treats a missing Manual Rows sheet as no manual rows", () => {
    const op = parseNotdsTemplate(wb([candidateRow({ Include: "N", "Cure Reason": "threshold" })], [], ["Manual Rows"]));
    expect(op.manual).toEqual([]);
    expect([...op.decisions.values()][0]).toMatchObject({ include: false, cure: "threshold" });
  });

  it("treats a missing Candidates sheet as no decisions", () => {
    const op = parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { Section: "194J" })], ["Candidates"]));
    expect(op.decisions.size).toBe(0);
    expect(op.manual).toEqual([{
      sheet: "40(a)(ia) to resident",
      party: "Sample Traders",
      date: "20260205",
      amount: 40000,
      deducted: 0,
      deposited: 0,
      section: "194J",
    }]);
  });
});

describe("parseNotdsTemplate — candidate decisions", () => {
  it("parses Include=N with a cure token, residency NR with a valid NR section, and every optional field", () => {
    const op = parseNotdsTemplate(
      wb([
        candidateRow({
          Key: "sampleoverseas|20260120|5|195",
          Include: "N",
          "Cure Reason": "deposited-by-return-date",
          Residency: "NR",
          "NR Section": "195",
          "Nature of Payment": "royalty",
          Address: "12 Marine Drive",
          City: "Mumbai",
          State: "Maharashtra",
          PIN: "400001",
          Country: "India",
          PAN: PAN,
          "Amount Override": 110000,
          Notes: "deposit landed after the due date",
        }),
      ]),
    );
    const d = op.decisions.get("sampleoverseas|20260120|5|195")!;
    expect(d).toEqual({
      key: "sampleoverseas|20260120|5|195",
      include: false,
      cure: "deposited-by-return-date",
      residency: "NR",
      nrSection: "195",
      nature: "royalty",
      address: "12 Marine Drive",
      city: "Mumbai",
      state: "Maharashtra",
      pin: "400001",
      country: "India",
      pan: PAN,
      amountOverride: 110000,
      reason: "deposit landed after the due date",
    });
  });

  it("keys decisions by the template's candidate key (the round-trip contract)", () => {
    const op = parseNotdsTemplate(
      wb([
        candidateRow({ Key: "samplebasicsllp|20260115|2|194-I(a)" }),
        candidateRow({ Key: "samplecomponents|20260211|7|194C" }),
      ]),
    );
    expect([...op.decisions.keys()]).toEqual([
      "samplebasicsllp|20260115|2|194-I(a)",
      "samplecomponents|20260211|7|194C",
    ]);
  });

  it("rejects a blank Key cell, citing row and column", () => {
    const row = candidateRow();
    (row as CellRow)[0] = null;
    const msg = message(() => parseNotdsTemplate(wb([row])));
    expect(msg).toMatch(/template Candidates row 2, column A \(Key\): required cell is blank/);
  });

  it("rejects a duplicate candidate key, citing the earlier row", () => {
    const msg = message(() => parseNotdsTemplate(wb([
      candidateRow({ Key: "a|1|1|194C" }),
      candidateRow({ Key: "a|1|1|194C" }),
    ])));
    expect(msg).toMatch(/template Candidates row 3, column A \(Key\): this candidate key already appears in row 2/);
  });
});

describe("parseNotdsTemplate — Include and Cure Reason", () => {
  it("rejects an Include outside Y/N/blank", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ Include: "maybe" })])));
    expect(msg).toMatch(/template Candidates row 2, column L \(Include\): enter Y or N, or leave blank/);
  });

  it("rejects Include=N with no Cure Reason, citing the cell", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ Include: "N" })])));
    expect(msg).toMatch(/template Candidates row 2, column M \(Cure Reason\): required when Include is N — pick a cure reason/);
  });

  it("rejects a Cure Reason outside the token list and never echoes the value", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ "Cure Reason": PAN })])));
    expect(msg).toMatch(/template Candidates row 2, column M \(Cure Reason\): not a cure reason — use the dropdown/);
    expect(msg).not.toContain(PAN);
  });

  it("accepts a blank Cure Reason on an include (blank Include = Y) row", () => {
    const op = parseNotdsTemplate(wb([candidateRow({})]));
    expect([...op.decisions.values()][0]).toMatchObject({ include: true });
    expect([...op.decisions.values()][0]).not.toHaveProperty("cure");
  });
});

describe("parseNotdsTemplate — residency and NR Section (Review Focus #3)", () => {
  it("rejects a Residency outside R/NR/blank", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ Residency: "NRI" })])));
    expect(msg).toMatch(/template Candidates row 2, column N \(Residency\): enter R or NR, or leave blank/);
  });

  it("rejects an NR row with no NR Section, citing the row", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ Residency: "NR" })])));
    expect(msg).toMatch(/template Candidates row 2, column O \(NR Section\): required when Residency is NR/);
  });

  it("rejects a resident-list spelling on an NR row and never echoes it", () => {
    const msg = message(() => parseNotdsTemplate(wb([
      candidateRow({ Residency: "NR", "NR Section": "194I (a)" }),
    ])));
    expect(msg).toMatch(/template Candidates row 2, column O \(NR Section\): not a TDS section for a non-resident deductee — use the dropdown/);
    expect(msg).not.toContain("194I");
  });

  it("accepts an NR row with a valid NR-list spelling", () => {
    const op = parseNotdsTemplate(wb([
      candidateRow({ Key: "o|1|1|195", Residency: "NR", "NR Section": "194LBA(3)" }),
    ]));
    expect([...op.decisions.values()][0]).toMatchObject({ residency: "NR", nrSection: "194LBA(3)" });
  });
});

describe("parseNotdsTemplate — amounts", () => {
  it("rejects a negative Amount Override", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ "Amount Override": -5 })])));
    expect(msg).toMatch(/template Candidates row 2, column V \(Amount Override\): amount cannot be negative/);
  });

  it("rejects a non-numeric Amount Override", () => {
    const msg = message(() => parseNotdsTemplate(wb([candidateRow({ "Amount Override": "many" })])));
    expect(msg).toMatch(/template Candidates row 2, column V \(Amount Override\): not a number/);
  });
});

describe("parseNotdsTemplate — manual rows", () => {
  it("parses a manual row with the section the resident list carries", () => {
    const op = parseNotdsTemplate(
      wb([], [manualRow("40(a)(ia) to resident", { Section: "194I (a)", "Nature of Payment": "rent", "PAN/Aadhaar": PAN, City: "Navsari", "Tax/Levy Deducted": 4000, "Tax/Levy Deposited": 4000 })]),
    );
    expect(op.manual).toEqual([{
      sheet: "40(a)(ia) to resident",
      party: "Sample Traders",
      date: "20260205",
      amount: 40000,
      deducted: 4000,
      deposited: 4000,
      section: "194I (a)",
      nature: "rent",
      pan: PAN,
      city: "Navsari",
    }]);
  });

  it("needs no section on the two levy/salary sheets and rejects a resident-list section on the NR sheet", () => {
    const levy = parseNotdsTemplate(wb([], [manualRow("40(a)(ib) - Equalisation Levy")]));
    expect(levy.manual[0]?.sheet).toBe("40(a)(ib) - Equalisation Levy");
    const salary = parseNotdsTemplate(wb([], [manualRow("40(a)(iii)")]));
    expect(salary.manual[0]).toMatchObject({ sheet: "40(a)(iii)" });

    const msg = message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(i) to non-resident", { Section: "194C" })])));
    expect(msg).toMatch(/template Manual Rows row 2, column G \(Section\): not a TDS section for sheet "40\(a\)\(i\) to non-resident" — use the dropdown/);
    expect(msg).not.toContain("194C");
  });

  it("rejects a resident-list mismatch on the resident sheet", () => {
    const msg = message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { Section: "195" })])));
    expect(msg).toMatch(/template Manual Rows row 2, column G \(Section\): not a TDS section for sheet/);
  });

  it("rejects a filled Section on a sheet that takes none", () => {
    const msg = message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(iii)", { Section: "192" })])));
    expect(msg).toMatch(/template Manual Rows row 2, column G \(Section\): sheet "40\(a\)\(iii\)" takes no section/);
  });

  it("rejects an unknown Sheet value and never echoes the value", () => {
    const row = manualRow("40(a)(ia) to resident");
    row[0] = PAN;
    const msg = message(() => parseNotdsTemplate(wb([], [row])));
    expect(msg).toMatch(/template Manual Rows row 2, column A \(Sheet\): not a clause 21\(b\) sheet — use the dropdown/);
    expect(msg).not.toContain(PAN);
  });

  it("rejects a duplicate manual sheet-party-date-amount tuple citing both rows", () => {
    const msg = message(() => parseNotdsTemplate(wb([], [
      manualRow("40(a)(ia) to resident"),
      manualRow("40(a)(ia) to resident", { Party: "Sample Traders" }),
    ])));
    expect(msg).toMatch(/template Manual Rows row 3, column B \(Party\): this sheet-party-date-amount row already appears in row 2/);
  });

  it("rejects a non-date, an unknown date, and a negative amount on a manual row", () => {
    expect(message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { Date: "no date" })]))))
      .toMatch(/template Manual Rows row 2, column C \(Date\): not a date/);
    expect(message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { Amount: -10 })]))))
      .toMatch(/template Manual Rows row 2, column D \(Amount\): amount cannot be negative/);
    expect(message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { "Tax/Levy Deducted": -1 })]))))
      .toMatch(/template Manual Rows row 2, column E \(Tax\/Levy Deducted\): amount cannot be negative/);
    expect(message(() => parseNotdsTemplate(wb([], [manualRow("40(a)(ia) to resident", { "Tax/Levy Deposited": -1 })]))))
      .toMatch(/template Manual Rows row 2, column F \(Tax\/Levy Deposited\): amount cannot be negative/);
  });

  it("rejects a blank Party on a manual row", () => {
    const row = manualRow("40(a)(ia) to resident");
    (row as CellRow)[1] = null;
    const msg = message(() => parseNotdsTemplate(wb([], [row])));
    expect(msg).toMatch(/template Manual Rows row 2, column B \(Party\): required cell is blank/);
  });
});
