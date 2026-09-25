import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_GST44, type OperatorGst44 } from "../src/gst44.js";
import type { DayBookInput } from "../src/tds-daybook.js";
import type { VoucherRow } from "../src/downstream.js";

// Synthetic ledgers, parties, GSTINs and figures only: real operator facts
// never appear in the repo (captain ruling, pf-esi.test.ts convention).
const ROOT = "\u0004 Primary";
const GROUPS = [
  { name: "Sundry Creditors", parent: ROOT },
  { name: "Indirect Expenses", parent: ROOT },
  { name: "Purchase Accounts", parent: ROOT },
  { name: "Duties & Taxes", parent: ROOT },
  { name: "Input GST", parent: "Duties & Taxes" },
];
const MASTERS = [
  { name: "Nova Traders", parent: "Sundry Creditors", openingBalance: 0, closingBalance: 0 },
  { name: "Prime Haulage", parent: "Sundry Creditors", openingBalance: 0, closingBalance: 0 },
  { name: "Site Materials", parent: "Purchase Accounts", openingBalance: 0, closingBalance: 0 },
  { name: "Input IGST A/c", parent: "Input GST", openingBalance: 0, closingBalance: 0 },
];
// Invented GSTIN of the allowed test shape: its segment matching, not a real
// supplier's registration number.
const GSTIN_REG = "27AAAAA0000A1Z5";
const LEDGERS_TAX = [
  { name: "Nova Traders", parent: "Sundry Creditors", gstin: GSTIN_REG, state: "Maharashtra", pan: "AAAAA0000A", isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
  { name: "Prime Haulage", parent: "Sundry Creditors", gstin: null, state: "Maharashtra", pan: null, isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
];
const v = (
  party: string | null,
  voucherNumber: string,
  entries: Array<[string, number]>,
): VoucherRow => ({
  date: "20250405", voucherType: "Purchase", voucherNumber,
  partyLedgerName: party ?? "", cancelled: false,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount })),
});

const stubFor = (vouchers: VoucherRow[], ledgersTaxMock?: () => never) =>
  Object.assign(fakeDownstream(), {
    groups: async () => GROUPS,
    ledgers: async () => MASTERS,
    vouchers: async () => vouchers,
    ...(ledgersTaxMock ? { ledgersTax: ledgersTaxMock } : { ledgersTax: async () => LEDGERS_TAX }),
  } as never);

describe("gst44Review (session)", () => {
  it("masks the happy path: live GSTINs drive the buckets and no real name or GSTIN escapes", async () => {
    const stub = stubFor([
      v("Nova Traders", "P-1", [
        ["Site Materials", 30000],
        ["Input IGST A/c", 5400],
        ["Nova Traders", -35400],
      ]),
      v("Prime Haulage", "P-2", [
        ["Site Materials", 12000],
        ["Prime Haulage", -12000],
      ]),
    ]);
    const session = createSession(stub, EMPTY_OVERRIDES);
    const result = await session.gst44Review({
      fromDate: "20250401",
      toDate: "20250630",
      operator: EMPTY_GST44,
    });
    expect(result.gstinSource).toBe("live");
    expect(result.booksSource).toBe("live");
    const [capital, revenue] = result.rows;
    expect(capital).toMatchObject({ label: "Capital Expenditure", total: 0 });
    expect(revenue).toMatchObject({ label: "Revenue Expenditure", total: 42000, others: 30000, unregistered: 12000, exempt: 0, composition: 0 });
    // Parties were pseudonymed under the "other" role first, so the
    // pre-registered alias (Ledger N) is what the result carries.
    expect(result.parties.map((p) => p.party).sort()).toEqual(["Ledger 1", "Ledger 2"]);

    // The privacy invariant: neither the invented GSTIN nor either real party
    // name may appear anywhere in the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/27AAAAA0000A1Z5/);
    expect(serialized).not.toContain("Nova Traders");
    expect(serialized).not.toContain("Prime Haulage");
    expect(serialized).toContain("Ledger ");
    expect(result.confirms.length).toBe(6);
  });

  describe("hard degradation (no GSTIN evidence)", () => {
    const ledgerstaxDown = () => {
      throw new Error("tally down");
    };
    const voucher = v("Nova Traders", "P-9", [
      ["Site Materials", 5000],
      ["Nova Traders", -5000],
    ]);

    it("rejects when the template covers none of the spend-carrying parties", async () => {
      const session = createSession(stubFor([voucher], ledgerstaxDown), EMPTY_OVERRIDES);
      await expect(
        session.gst44Review({ fromDate: "20250401", toDate: "20250630", operator: EMPTY_GST44 }),
      ).rejects.toThrow(/no supplier GST-status evidence/);
      await expect(
        session.gst44Review({ fromDate: "20250401", toDate: "20250630", operator: EMPTY_GST44 }),
      ).rejects.toThrow(/tb_write_gst44_template/);
    });

    it("succeeds on the operator status alone, marking the party's override bucket", async () => {
      const operator: OperatorGst44 = { statuses: [{ ledger: "Nova Traders", status: "composition" }] };
      const session = createSession(stubFor([voucher], ledgerstaxDown), EMPTY_OVERRIDES);
      const result = await session.gst44Review({ fromDate: "20250401", toDate: "20250630", operator });
      expect(result.gstinSource).toBe("none");
      expect(result.parties[0]).toMatchObject({
        override: true,
        ambiguous: false,
        revenue: { composition: 5000, exempt: 0, others: 0, unregistered: 0 },
      });
      expect(result.rows[1].composition).toBe(5000);
      expect(JSON.stringify(result)).not.toContain("Nova Traders");
    });
  });

  describe("day-book channel", () => {
    it("takes vouchers from the file and GSTINs from the live ledgersTax call", async () => {
      const liveVouchers = [
        v("Nova Traders", "LIVE-1", [["Site Materials", 999999], ["Nova Traders", -999999]]),
      ];
      const stub = Object.assign(stubFor(liveVouchers), {
        vouchers: async () => liveVouchers,
      } as never);
      const session = createSession(stub, EMPTY_OVERRIDES);
      const dayBook: DayBookInput = {
        shape: "bundle",
        vouchers: [
          v("Nova Traders", "F-1", [
            ["Site Materials", 30000],
            ["Input IGST A/c", 5400],
            ["Nova Traders", -35400],
          ]),
        ],
        company: "Sample Co",
        groups: GROUPS,
        ledgers: MASTERS.map(({ name, parent }) => ({ name, parent })),
        observedFrom: "20250405",
        observedTo: "20250405",
        rejected: 0,
        emptyMonths: [],
      };
      const result = await session.gst44Review({
        fromDate: "20250401",
        toDate: "20250630",
        operator: EMPTY_GST44,
        dayBook,
      });
      expect(result.booksSource).toBe("daybook-file");
      expect(result.books).toMatchObject({ vouchers: 1, rejected: 0, mastersSource: "bundle" });
      // The file's row count, not the live voucher stub's.
      expect(result.rows[1].total).toBe(30000);
      expect(result.rows[1].others).toBe(30000);
      expect(result.gstinSource).toBe("live");
      // The livevoucher fetch must not have been used for the books.
      const voucherCalls = (stub as { calls: Array<{ tool: string }> }).calls.filter(
        (c) => c.tool.includes("vouchers"),
      );
      expect(voucherCalls).toHaveLength(0);
    });
  });

  it("warns with a pseudonym when the template names an unknown ledger", async () => {
    const stub = stubFor([
      v("Nova Traders", "P-1", [["Site Materials", 3000], ["Nova Traders", -3000]]),
    ]);
    const session = createSession(stub, EMPTY_OVERRIDES);
    const operator: OperatorGst44 = {
      statuses: [{ ledger: "Phantom Ledger", status: "composition" }],
    };
    const result = await session.gst44Review({ fromDate: "20250401", toDate: "20250630", operator });
    const warns = result.findings.filter((f) => f.check === "gst44_status_override_unknown_ledger");
    expect(warns).toHaveLength(1);
    expect(warns[0].severity).toBe("warning");
    expect(warns[0].ledger).toMatch(/^\w+ \d+$/);
    expect(JSON.stringify(result)).not.toContain("Phantom Ledger");
  });
});
