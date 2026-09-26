import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TDS_OPERATOR,
  parseDayBook,
  parseOperatorFile,
  type OperatorFile,
} from "../src/tds-file.js";

const load = async () => readFile("test/fixtures/tds_operator_file.json", "utf8");

describe("parseOperatorFile", () => {
  it("parses the happy path with normalized dates", async () => {
    const doc = parseOperatorFile(await load());
    expect(doc.sections).toEqual([
      { ledger: "Site Repairs Contract", section: "194C" },
      { ledger: "TDS Contractors", section: "194C", kind: "duty" },
      { ledger: "Consultancy Services", section: "194J" },
      { ledger: "Rent - Plant and Machinery", section: "194-I(a)" },
    ]);
    expect(doc.parties[0]).toEqual({
      ledger: "Sample Builders LLP",
      tdsApplicable: true,
      transporterDeclaration: false,
      deducteeFiledReturn: false,
    });
    expect(doc.parties.length).toBe(3);
    expect(doc.parties[1]).toEqual({
      ledger: "Sample Consultants",
      tdsApplicable: true,
      transporterDeclaration: false,
      deducteeFiledReturn: true,
    });
    expect(doc.certificates[0]).toEqual({
      ledger: "Sample Developers",
      section: "194-I(a)",
      rate: 2,
      from: "20250401",
      to: "20260331",
      limit: 400000,
    });
    expect(doc.challans[0]).toEqual({
      section: "194C",
      forMonth: "2025-05",
      depositDate: "20250616",
    });
    expect(doc.statements[0]).toEqual({
      form: "26Q",
      quarter: "Q1",
      filedDate: "20250820",
      tdsAmount: 5000,
    });
  });

  it("carries no section on a party row: there is no party→section mapping", async () => {
    const doc = parseOperatorFile(await load());
    for (const p of doc.parties) {
      expect((p as unknown as Record<string, unknown>).section).toBeUndefined();
    }
  });

  it("defaults the 194Q opt-out to applicable when the key is absent, honours an explicit false", async () => {
    const doc = JSON.parse(await load()) as Record<string, unknown>;
    expect(parseOperatorFile(JSON.stringify(doc)).section194QApplicable).toBe(true);
    expect(parseOperatorFile(JSON.stringify({ ...doc, section194QApplicable: false })).section194QApplicable).toBe(false);
    expect(parseOperatorFile(JSON.stringify({ ...doc, section194QApplicable: true })).section194QApplicable).toBe(true);
  });

  it("ignores a legacy parties[].section key: existing files still parse unchanged", async () => {
    const text = await load();
    const doc = JSON.parse(text) as Record<string, unknown>;
    const parties = (doc.parties as Array<Record<string, unknown>>).map((p) => ({ ...p }));
    parties[1].section = "MUMA04826B"; // even a nonsense value changes nothing
    const file = parseOperatorFile(JSON.stringify({ ...doc, parties }));
    expect(file.parties[1]).toMatchObject({
      ledger: "Sample Consultants",
      tdsApplicable: true,
      deducteeFiledReturn: true,
    });
  });

  it("defaults an absent tdsApplicable key to true (a party row has always meant a TDS party)", () => {
    const file = parseOperatorFile(
      JSON.stringify({ parties: [{ ledger: "Rent - Office Building" }] }),
    );
    expect(file.parties[0].tdsApplicable).toBe(true);
  });

  it("reads an explicit tdsApplicable=false and never treats an unrecognised key as false", () => {
    const file = parseOperatorFile(
      JSON.stringify({
        parties: [
          { ledger: "A", tdsApplicable: "no" },
          { ledger: "B", tdsApplicable: true },
        ],
      }),
    );
    expect(file.parties[0].tdsApplicable).toBe(false);
    expect(file.parties[1].tdsApplicable).toBe(true);
  });

  it("rejects a section unknown to the law table without echoing its value", async () => {
    const text = await load();
    const doc = JSON.parse(text) as Record<string, unknown>;
    const sections = (doc.sections as Array<Record<string, unknown>>).map((s) => ({ ...s }));
    sections[0].section = "MUMA04826B";
    const bad = JSON.stringify({ ...doc, sections });
    // Never echo the value: a malformed section string is a stray operator
    // value, and an error message is an outbound string.
    expect(() => parseOperatorFile(bad)).toThrow(/sections row 1: section is not a TDS section/);
    expect(() => parseOperatorFile(bad)).not.toThrow(/MUMA04826B/);
  });

  it("rejects a bare 194-I wherever a section is still read (the split keys are the only rent sections)", async () => {
    const text = await load();
    const doc = JSON.parse(text) as Record<string, unknown>;
    const certificates = [(doc.certificates as Array<Record<string, unknown>>)[0]];
    certificates[0] = { ...certificates[0], section: "194-I" };
    const bad = JSON.stringify({ ...doc, certificates });
    expect(() => parseOperatorFile(bad)).toThrow(/certificates row 1: section is not a TDS section/);
  });

  it("rejects a ledger kind outside Expense / TDS Duty", () => {
    const bad = JSON.stringify({
      sections: [{ ledger: "Rent - Plant and Machinery", section: "194-I(a)", kind: "Party" }],
    });
    expect(() => parseOperatorFile(bad)).toThrow(/ledger kind is not Expense or TDS Duty/);
  });

  it("propagates every flag the engine reads (transporter declaration, s.201(1) proviso)", async () => {
    const text = await load();
    const doc = JSON.parse(text) as Record<string, unknown>;
    const parties = (doc.parties as Array<Record<string, unknown>>).map((p) => ({ ...p }));
    parties[0].transporterDeclaration = true;
    const file = parseOperatorFile(JSON.stringify({ ...doc, parties }));
    expect(file.parties[0].transporterDeclaration).toBe(true);
    expect(file.parties[1].deducteeFiledReturn).toBe(true);
    expect(file.parties.find((p) => p.ledger === "Sample Builders LLP")!.transporterDeclaration).toBe(true);
  });

  it("rejects wholesale on a malformed row, citing the row index", () => {
    expect(() => parseOperatorFile("not json")).toThrow(/not valid JSON/);
    expect(() => parseOperatorFile("[]")).toThrow(/must be an object/);
  });
});

describe("parseOperatorFile — clause-34 operator facts", () => {
  /** Invented shape-valid TAN fixture, like the template tests'; never a real one. */
  const TAN = "MUMO12345O";

  it("reads a shape-valid tan, compacting spaces and uppercasing, and leaves it absent when the key is", () => {
    const doc = parseOperatorFile(JSON.stringify({ tan: "mumo 12345 o" }));
    expect(doc.tan).toBe(TAN);
    expect(parseOperatorFile(JSON.stringify({})).tan).toBeUndefined();
  });

  it("rejects a malformed tan citing the JSON key, never the value", () => {
    const msg = (() => {
      try {
        parseOperatorFile(JSON.stringify({ tan: TAN.slice(0, 9) }));
        return "no error";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(msg).toMatch(/operator file "tan": not a TAN/);
    expect(msg).not.toContain(TAN.slice(0, 9));
  });

  it("reads tcsSections with the exact Winman nature strings", () => {
    const doc = parseOperatorFile(JSON.stringify({
      tcsSections: [
        { ledger: "Scrap Sales", nature: "Scrap" },
        { ledger: "Timber Sales", nature: "Timber-Others" },
      ],
    }));
    expect(doc.tcsSections).toEqual([
      { ledger: "Scrap Sales", nature: "Scrap" },
      { ledger: "Timber Sales", nature: "Timber-Others" },
    ]);
  });

  it("rejects a nature that is not an exact TCS_NATURES winman string, echoing nothing", () => {
    const bad = JSON.stringify({ tcsSections: [{ ledger: "Scrap Sales", nature: TAN }] });
    const msg = (() => {
      try {
        parseOperatorFile(bad);
        return "no error";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(msg).toMatch(/operator file tcsSections row 1: nature is not a TCS nature from the Winman dropdown/);
    expect(msg).not.toContain(TAN);
  });

  it("refuses a duplicate tcsSections ledger citing both row numbers", () => {
    const bad = JSON.stringify({
      tcsSections: [
        { ledger: "Scrap Sales", nature: "Scrap" },
        { ledger: "scrap sales", nature: "Scrap" },
      ],
    });
    expect(() => parseOperatorFile(bad)).toThrow(/tcsSections row 2: this ledger already appears in row 1/);
  });

  it("reads interestPaid rows with the two interest sheets' form union", () => {
    const doc = parseOperatorFile(JSON.stringify({
      interestPaid: [
        { form: "26Q", quarter: "Q1", amount: 12500, paidOn: "2025-07-21" },
        { form: "26QB", quarter: "Q2", amount: 500, paidOn: "20250815" },
        { form: "27EQ", quarter: "Q3", amount: "1,000", paidOn: "2025-12-30" },
      ],
    }));
    expect(doc.interestPaid).toEqual([
      { form: "26Q", quarter: "Q1", amount: 12500, paidOn: "20250721" },
      { form: "26QB", quarter: "Q2", amount: 500, paidOn: "20250815" },
      { form: "27EQ", quarter: "Q3", amount: 1000, paidOn: "20251230" },
    ]);
  });

  it("rejects an interestPaid form outside the union and a bad quarter", () => {
    expect(() => parseOperatorFile(
      JSON.stringify({ interestPaid: [{ form: "24QX", quarter: "Q1", amount: 1, paidOn: "20250721" }] }),
    )).toThrow(/interestPaid row 1: form is not one of the interest statement forms/);
    expect(() => parseOperatorFile(
      JSON.stringify({ interestPaid: [{ form: "26Q", quarter: "Q5", amount: 1, paidOn: "20250721" }] }),
    )).toThrow(/interestPaid row 1: quarter is not a calendar quarter/);
  });

  it("refuses a duplicate interestPaid (form, quarter) citing both row numbers", () => {
    const bad = JSON.stringify({
      interestPaid: [
        { form: "26Q", quarter: "Q1", amount: 1, paidOn: "20250721" },
        { form: "26q", quarter: "q1", amount: 2, paidOn: "20251017" },
      ],
    });
    expect(() => parseOperatorFile(bad)).toThrow(/interestPaid row 2: this form-and-quarter pair already appears in row 1/);
  });

  it("reads statements[].returnAccurate as Yes/No, absent when the key is", () => {
    const doc = parseOperatorFile(JSON.stringify({
      statements: [
        { form: "26Q", quarter: "Q1", filedDate: "20250820", tdsAmount: 5000, returnAccurate: "no" },
        { form: "24Q", quarter: "Q2", filedDate: "20251120", tdsAmount: 100, returnAccurate: true },
      ],
    }));
    expect(doc.statements[0].returnAccurate).toBe("No");
    expect(doc.statements[1].returnAccurate).toBe("Yes");
    expect(parseOperatorFile(JSON.stringify({
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250820", tdsAmount: 5000 }],
    })).statements[0].returnAccurate).toBeUndefined();
  });

  it("rejects a statements[].returnAccurate that is neither Yes nor No", () => {
    expect(() => parseOperatorFile(JSON.stringify({
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250820", tdsAmount: 5000, returnAccurate: "maybe" }],
    }))).toThrow(/statements row 1: returnAccurate is not Yes or No/);
  });
});

describe("parseDayBook", () => {
  it("accepts the upstream tally_get_vouchers row shape", () => {
    const rows = parseDayBook(
      JSON.stringify([
        {
          date: "2025-05-10",
          voucherType: "Purchase",
          voucherNumber: "P/2025-26/0012",
          partyLedgerName: "Sample Builders LLP",
          isCancelled: false,
          entries: [
            { LEDGERNAME: "Site Repairs Contract", AMOUNT: -250000 },
            { LEDGERNAME: "Sample Builders LLP", AMOUNT: 250000 },
          ],
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("20250510");
    expect(rows[0].voucherNumber).toBe("P/2025-26/0012");
    expect(rows[0].entries).toEqual([
      { ledger: "Site Repairs Contract", amount: 250000 },
      { ledger: "Sample Builders LLP", amount: -250000 },
    ]);
  });

  it("drops broken rows instead of throwing", () => {
    const rows = parseDayBook(
      JSON.stringify([null, { date: "no-date" }, { date: "2025-05-10", entries: [] }]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("EMPTY_TDS_OPERATOR", () => {
  it("is a valid parse of a blank file", () => {
    const empty: OperatorFile = EMPTY_TDS_OPERATOR;
    expect(empty.sections).toEqual([]);
    expect(empty.parties).toEqual([]);
  });
});
