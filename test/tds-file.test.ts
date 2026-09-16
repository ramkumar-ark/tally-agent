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
