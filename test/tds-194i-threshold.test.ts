import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { tdsCtx } from "./tds.test.js";

/**
 * Captain instruction 2026-09-30 (194-I annual limit, `cumulativeOnCross`):
 * while a party's cumulative FY 194-I bookings are within ₹6,00,000 no
 * deduction is due and no finding arises; at the booking where the
 * cumulative crosses, TDS is due on the cumulative booked to that date
 * including the earlier bookings; a party that never crosses never reports.
 *
 * The fixtures are the Narayanan FY 25-26 shape (party ledger
 * `SRP. RMC AND CONSTRUCTIONS`, renamed here), never live books: the four
 * 03-Jun-2025 hire-charge bills that v5 reported as TDS-001-5..8 and the
 * 07-Aug crossing that v5 left silent.
 */
const hireLedger = "Hire Charges - Machinery A/c";
const dutyLedger = "TDS Contractors";
const party = "SRP RMC AND CONSTRUCTIONS A/c";

const op194I: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: hireLedger, section: "194-I(a)" },
    { ledger: dutyLedger, section: "194-I(a)", kind: "duty" },
  ],
};

const ctx = (over: Partial<TdsCtx> = {}): ReturnType<typeof tdsCtx> =>
  tdsCtx(op194I, { tdsParties: [party], ...over });

const row = (
  date: string,
  voucher: string,
  amount: number,
  counterparty = party,
): LedgerVoucherRow => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  reference: "",
  counterparty,
  amount,
  matchStatus: "matched",
  tax: null,
});

const run = (
  c: ReturnType<typeof tdsCtx>,
  duty: TdsLedgerRows[] = [],
  expense: TdsLedgerRows[] = [],
  party: TdsLedgerRows[] = [],
): ReturnType<typeof analyzeTds> => analyzeTds(duty, expense, party, c);

const notDeducted = (out: ReturnType<typeof analyzeTds>) =>
  out.findings.filter((f) => f.check === "tds_not_deducted");

describe("194-I annual limit: the cumulative crosses, not the whole year", () => {
  it("(a) the Narayanan shape — four June bills within the limit raise nothing, the crossing booking carries the cumulative", () => {
    // v5 reported TDS-001-5..8 for the four 03-Jun bills (8,500 of tax) because
    // the party's YEAR total later crossed 6,00,000.
    const out = run(ctx(), [], [
      {
        ledger: hireLedger,
        rows: [
          row("20250603", "H/1", 231000),
          row("20250603", "H/2", 71500),
          row("20250603", "H/3", 82500),
          row("20250603", "H/4", 40000),
          row("20250807", "H/5", 99000),
          // cumulative 4,25,000 + 99,000 = 5,24,000; this one takes it to
          // 6,89,000 — the first booking past the ₹6,00,000 annual limit.
          row("20250807", "H/6", 165000),
        ],
      },
    ]);
    const nd = notDeducted(out);
    // Exactly one finding, and it is the crossing booking at 2% of the whole
    // ₹6,89,000 booked to that date (13,780) — not 2% of the 1,65,000 bill
    // (3,300) and not the four June bills.
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(13780);
    expect(nd[0].section).toBe("194-I(a)");
    expect(nd[0].detail).toContain("6,89,000.00");
    expect(nd[0].detail).toContain("including the earlier bookings within the annual limit");
    // The advisory still reports the year total, and names the new rule.
    const crossed = out.findings.filter((f) => f.check === "tds_threshold_crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].amount).toBe(13780); // 2% of this fixture's 6,89,000 year
    expect(crossed[0].detail).toContain("liable on the crossing booking itself");
    // The engine's own liability view agrees: only the crossing booking and
    // later ones carry a liable base, at the cumulative.
    expect(out.liabilities).toHaveLength(1);
    expect(out.liabilities[0].liableBase).toBe(689000);
    expect(out.liabilities[0].liability).toBe(13780);
  });

  it("(b) a party that never crosses the annual limit reports no 194-I liability at all", () => {
    const out = run(ctx(), [], [
      {
        ledger: hireLedger,
        rows: [
          row("20250603", "H/1", 231000),
          row("20250807", "H/2", 99000),
          row("20251111", "H/3", 165000),
        ],
      },
    ]);
    // cumulative 4,95,000 — inside the limit, so nothing is due and nothing is
    // reported (not a finding, not a liability, not a threshold advisory).
    expect(out.liabilities).toEqual([]);
    expect(notDeducted(out)).toEqual([]);
    expect(out.findings.filter((f) => f.check === "tds_threshold_crossed")).toEqual([]);
  });

  it("(c) crossing but under-deducted — a short on the crossing booking, still nothing on the pre-crossing bills", () => {
    const out = run(
      ctx(),
      // A duty credit of 5,000 against the 12,620 due on the crossing booking.
      [{ ledger: dutyLedger, rows: [row("20250807", "T/1", -5000)] }],
      [
        {
          ledger: hireLedger,
          rows: [row("20250603", "H/1", 231000), row("20250807", "H/2", 400000)],
        },
      ],
    );
    // The crossing booking's cumulative is 6,31,000 → 12,620 payable.
    expect(notDeducted(out)).toEqual([]);
    const short = out.findings.filter((f) => f.check === "tds_short_deducted");
    expect(short).toHaveLength(1);
    expect(short[0].amount).toBe(7620); // 12,620 − 5,000
    expect(short[0].section).toBe("194-I(a)");
    // The June bill is not in the report in any form: it is not liable, so it
    // cannot be not-deducted, short-deducted or late.
    expect(out.liabilities.map((l) => l.booking.voucherNumber)).toEqual(["H/2"]);
    expect(out.liabilities[0].liableBase).toBe(631000);
  });

  it("(d) each booking after the crossing is liable on its own gross, in full", () => {
    const out = run(ctx(), [], [
      {
        ledger: hireLedger,
        rows: [
          row("20250603", "H/1", 231000),
          row("20250807", "H/2", 400000), // crossing, cumulative 6,31,000
          row("20251011", "H/3", 302500),
          row("20260127", "H/4", 407000),
        ],
      },
    ]);
    // 12,620 (cumulative) + 6,050 + 8,140 — the crossing booking is the only
    // one that carries the earlier bills' taxable base.
    expect(out.liabilities.map((l) => [l.booking.voucherNumber, l.liableBase, l.liability])).toEqual([
      ["H/2", 631000, 12620],
      ["H/3", 302500, 6050],
      ["H/4", 407000, 8140],
    ]);
    expect(notDeducted(out).reduce((n, f) => n + f.amount, 0)).toBe(26810);
    // The year is unchanged by the rule: every rupee of the 13,43,500 booked
    // is still taxed once, only the booking that carries the pre-crossing base
    // moved.
    const crossed = out.findings.filter((f) => f.check === "tds_threshold_crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].amount).toBe(26810); // 2% of 13,40,500
  });
});

describe("voluntary deductions before the crossing (2026-09-30, firstmate inbox 010)", () => {
  // The Narayanan 194-I(b) rent party: Rs 60,000 a month, 10% deducted every
  // month against its own bill. Apr–Jan (6,00,000) sits inside the annual
  // limit; the 05-Feb bill crosses it.
  const rentLedger = "Rent Expenses - Office A/c";
  const rentDuty = "TDS Rent";
  const opRent: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: rentLedger, section: "194-I(b)" },
      { ledger: rentDuty, section: "194-I(b)", kind: "duty" },
    ],
  };
  const rentCtx = () => tdsCtx(opRent, { tdsParties: [party] });
  const rentRow = (
    date: string,
    voucher: string,
    amount: number,
    counterparty = party,
  ): LedgerVoucherRow => row(date, voucher, amount, counterparty);
  const bill = (date: string, voucher: string): LedgerVoucherRow =>
    rentRow(date, voucher, 60000);

  it("(a) deductions on the pre-crossing bills reduce what the crossing bill owes", () => {
    // Ten bills to 6,00,000 (inside the limit) and the 11th takes the year to
    // 6,60,000, so the crossing bill carries 66,000 at 10%. The party deducted
    // 10% on every earlier bill and nothing at all in the crossing month.
    const months = [
      "20250410", "20250510", "20250610", "20250710", "20250810",
      "20250910", "20251010", "20251110", "20251210", "20260110",
    ];
    const out = run(
      rentCtx(),
      [{ ledger: rentDuty, rows: months.map((d, i) => rentRow(d, `T/${i + 1}`, -6000)) }],
      [
        {
          ledger: rentLedger,
          rows: [
            ...months.map((d, i) => bill(d, `R/${i + 1}`)),
            bill("20260205", "R/11"), // cumulative 6,60,000 → crosses
          ],
        },
      ],
    );
    // The crossing bill owes 66,000 less the 60,000 the books already deducted
    // on the ten earlier bills — its own 6,000 — so the shortfall is 6,000,
    // NOT the whole 66,000 the cumulative would read (firstmate 2026-09-30).
    const nd = notDeducted(out);
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(6000);
    expect(nd[0].detail).toContain("6,60,000.00");
    expect(out.liabilities.map((l) => [l.booking.voucherNumber, l.liability])).toEqual([
      ["R/11", 6000],
    ]);
    // The ten pre-crossing bills owe no tax and raise none, each of them
    // carrying a deduction of its own.
    expect(out.liabilities.filter((l) => l.booking.voucherNumber !== "R/11")).toEqual([]);
    expect(out.findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
  });

  it("(b) a party's own credit covering the netted crossing liability leaves nothing to report", () => {
    // The real shape: 10% deducted on every bill, so the crossing bill's
    // remaining 6,000 is covered exactly by the credit of that month.
    const months = [
      "20250410", "20250510", "20250610", "20250710", "20250810",
      "20250910", "20251010", "20251110", "20251210", "20260110",
    ];
    const out = run(
      rentCtx(),
      [
        {
          ledger: rentDuty,
          rows: [
            ...months.map((d, i) => rentRow(d, `T/${i + 1}`, -6000)),
            rentRow("20260205", "T/11", -6000),
          ],
        },
      ],
      [
        {
          ledger: rentLedger,
          rows: [
            ...months.map((d, i) => bill(d, `R/${i + 1}`)),
            bill("20260205", "R/11"), // crossing at 6,60,000
          ],
        },
      ],
    );
    // 66,000 − 60,000 of voluntary pre-crossing deductions = 6,000, and the
    // crossing month's own credit is 6,000: the party owes exactly what it
    // paid, so nothing is not-deducted and nothing is short.
    expect(notDeducted(out)).toEqual([]);
    expect(out.findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
    // The advisory still reports the year, so the crossing is disclosed.
    const crossed = out.findings.filter((f) => f.check === "tds_threshold_crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].amount).toBe(66000);
  });

  it("(c) a credit on a pre-crossing bill still runs its own deposit question", () => {
    const out = run(
      rentCtx(),
      [
        {
          ledger: rentDuty,
          rows: [
            // Two pre-crossing credits, and two deposits that miss the Rule 30
            // window (a deduction of Apr-2025 is due by 31-May-2025).
            rentRow("20250610", "T/1", -6000),
            rentRow("20250710", "T/2", -6000),
            rentRow("20251231", "D/1", 6000, "Bank A/c"),
            rentRow("20251231", "D/2", 6000, "Bank A/c"),
          ],
        },
      ],
      [
        {
          ledger: rentLedger,
          rows: [bill("20250610", "R/1"), bill("20250710", "R/2")],
        },
      ],
    );
    // Both bills are inside the annual limit (1,20,000), so no tax is due and
    // no not-deducted finding arises — but the deductions are real, so each
    // late deposit is reported (firstmate 2026-09-30).
    expect(notDeducted(out)).toEqual([]);
    const late = out.findings.filter((f) => f.check === "tds_late_deposit");
    expect(late).toHaveLength(2);
    expect(late.every((f) => f.amount === 6000)).toBe(true);
  });
});

describe("an amount match outranks the date order (2026-09-30, captain inbox 003)", () => {
  const op194C: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: "Labour Contract Expenses A/c", section: "194C" },
      { ledger: dutyLedger, section: "194C", kind: "duty" },
    ],
  };
  // The individual rate (1%) the party is entitled to — the amount tiebreak is
  // only meaningful at a known rate.
  const roadCtx = () =>
    tdsCtx(op194C, { tdsParties: [party], entityOf: () => "P" });

  it("(a) the credit a later bill is owed to is not taken by an earlier bill", () => {
    const out = run(
      roadCtx(),
      [{ ledger: dutyLedger, rows: [row("20250830", "T/1", -1967)] }],
      [
        {
          ledger: "Labour Contract Expenses A/c",
          rows: [row("20250820", "P/1", 126200), row("20250830", "P/2", 196740)],
        },
      ],
    );
    // The 1,967 credit is the 1% of the 30-Aug 1,96,740 bill (1,967.40, within
    // the ₹1 tolerance) and covers it. The 20-Aug 1,26,200 bill is the crossing
    // booking and had no credit of its own — that is the honest finding.
    const nd = notDeducted(out);
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(1262);
    expect(nd[0].detail).toContain("1,26,200.00");
    // The covered booking is in the engine's liability view WITH its deduction,
    // and the shortfall is not reported as short either.
    const covered = out.liabilities.find((l) => l.booking.voucherNumber === "P/2");
    expect(covered?.deduction?.tax).toBe(1967);
    expect(out.findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
  });

  it("(b) a credit with no booking of its own still joins by the nearest date", () => {
    // The pre-pass finds no amount match anywhere (|5,000 − 4,000| = 1,000 is
    // past the ₹1 tolerance), so the existing walk settles it exactly as
    // before: the earlier bill takes the credit by date and falls short.
    const out = run(
      roadCtx(),
      [{ ledger: dutyLedger, rows: [row("20250915", "T/1", -4000)] }],
      [
        {
          ledger: "Labour Contract Expenses A/c",
          rows: [row("20250901", "P/1", 500000), row("20250910", "P/2", 500000)],
        },
      ],
    );
    // 194-C: the aggregate limit is 1,00,000, so both bills are liable in full
    // at 1% — 5,000 each. The 01-Sep bill keeps the 4,000 credit (1,000 short);
    // the 10-Sep bill had none and is the not-deducted one.
    const nd = notDeducted(out);
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(5000);
    expect(nd[0].detail).toContain("5,00,000.00");
    const short = out.findings.filter((f) => f.check === "tds_short_deducted");
    expect(short).toHaveLength(1);
    expect(short[0].amount).toBe(1000);
    expect(out.liabilities.filter((l) => l.deduction !== null)).toHaveLength(1);
  });
});

describe("194-C aggregate limit: an annual cumulative, exactly as 194-I (captain 2026-09-30)", () => {
  // The captain's Creditor-23 shape: five ~19,800 subcontractor bills
  // 29-Jun to 18-Aug-2025 whose aggregate only crosses the ₹1,00,000
  // s.194C(5) limit on 06-Sep-2025, and the books deduct the whole
  // cumulative once, at the crossing. v7 reported the five bills as
  // not-deducted (TDS-001-7..11) although none of them was chargeable.
  const cLedger = "Labour Contract Expenses A/c";
  const cDuty = "TDS Contractors";
  const cParty = "Creditor 23 A/c";
  const op: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: cLedger, section: "194C" },
      { ledger: cDuty, section: "194C", kind: "duty" },
    ],
  };
  const cctx = tdsCtx(op, { tdsParties: [cParty] });
  const bill = (date: string, v: string, gross: number): LedgerVoucherRow => ({
    ...row(date, v, gross, cParty),
  });

  it("leaves a pre-crossing bill silent and charges the crossing booking the cumulative, less what was deducted earlier", () => {
    const out = run(
      cctx,
      [
        {
          ledger: cDuty,
          // one voluntary deduction on a pre-crossing bill, 2% of 20,000
          rows: [{ ...row("20250615", "D/1", -400, cParty), voucherType: "Journal" }],
        },
      ],
      [
        {
          ledger: cLedger,
          rows: [
            bill("20250629", "P/1", 20000),
            bill("20250724", "P/2", 20000),
            bill("20250731", "P/3", 20000),
            bill("20250818", "P/4", 20000),
            bill("20250829", "P/6", 20000), // five bills = exactly 1,00,000, still inside
            bill("20250906", "P/5", 278040 - 100000), // the crossing booking
          ],
        },
      ],
    );
    // Only the crossing booking reports, and it carries the year's cumulative
    // less the 400 already deducted: 2% of 2,78,040 is 5,560.80.
    const nd = notDeducted(out);
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(5160.8);
    expect(nd[0].detail).toContain("2,78,040.00");
    expect(nd[0].detail).toContain("including the earlier bookings within the annual limit");
    expect(out.findings.filter((f) => f.check === "tds_threshold_crossed")).toHaveLength(1);
    // the five pre-crossing bills raise nothing at all
    expect(out.liabilities).toHaveLength(1);
  });

  it("still charges a single bill past the per-bill limit on its own, before any crossing", () => {
    const out = run(cctx, [], [
      {
        ledger: cLedger,
        rows: [bill("20250602", "P/1", 40000), bill("20250609", "P/2", 20000)],
      },
    ]);
    const nd = notDeducted(out);
    expect(nd).toHaveLength(1);
    // 2% of the 40,000 bill alone, not the 60,000 the year carries
    expect(nd[0].amount).toBe(800);
    expect(out.liabilities).toHaveLength(1);
  });

  it("says nothing at all for a party whose bills never reach the aggregate", () => {
    const out = run(cctx, [], [
      {
        ledger: cLedger,
        rows: [bill("20250602", "P/1", 20000), bill("20250609", "P/2", 20000)],
      },
    ]);
    expect(out.findings).toEqual([]);
    expect(out.liabilities).toEqual([]);
  });
});

describe("an excess deduction carries forward (captain 2026-09-30, inbox 014)", () => {
  // The captain's own 194-C party: a 15-Oct-2025 bill of 55,764 — above the
  // 30,000 per-bill limit, so chargeable on its own at 2% — carries a credit
  // of 4,354 on 16-Oct-2025, which is the WHOLE year's tax (2,17,681.20 x 2%
  // = 4,353.62) paid in advance. A 26-Dec-2025 bill of 1,61,917.20 has no
  // credit of its own. v7 reported that December bill at 3,238.34 and v8
  // silenced it through the crossing netting; the captain's rule is general
  // and does not depend on a threshold crossing: the 3,238.72 the books
  // over-paid on the October bill reduces what the December bill owes.
  const eLedger = "Subcontractor Expenses A/c";
  const eDuty = "TDS on Subcontractor";
  const eParty = "Creditor 47 A/c";
  const op: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: eLedger, section: "194C" },
      { ledger: eDuty, section: "194C", kind: "duty" },
    ],
  };
  const ectx = tdsCtx(op, { tdsParties: [eParty] });
  const bill = (date: string, v: string, gross: number): LedgerVoucherRow => ({
    ...row(date, v, gross, eParty),
  });
  const captain = () =>
    run(
      ectx,
      [
        {
          ledger: eDuty,
          // the whole year's tax, deducted in advance on 16-Oct-2025
          rows: [{ ...row("20251016", "D/1", -4354, eParty), voucherType: "Journal" }],
        },
      ],
      [
        {
          ledger: eLedger,
          rows: [bill("20251015", "P/1", 55764), bill("20251226", "P/2", 161917.2)],
        },
      ],
    );

  it("applies the over-deduction on the earlier bill against the later bill's liability", () => {
    const out = captain();
    const nd = notDeducted(out);
    // The year ties: 2% of the year's 2,17,681.20 is 4,353.62 due, and the
    // books hold 4,354 — the party over-paid by 0.38 and owes nothing. Run 9
    // reported 1,114.90 here because the 26-Dec crossing charged the whole
    // 4,353.62 on top of the 1,115.28 already charged on the October bill
    // (55,764 is over the 30,000 per-bill limit), making that 1,115.28 liable
    // twice (firstmate 2026-09-30, inbox 015). The crossing now carries the
    // cumulative less what is already charged, and the bank covers the rest.
    expect(nd).toEqual([]);
    // an over-deduction is not a short deduction
    expect(out.findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
    // and the year never charges more than the tax on its own base
    const charged = out.liabilities.reduce((s, l) => s + l.liability, 0);
    expect(charged).toBeLessThanOrEqual(4353.62);
  });

  it("charges late-deduction interest on the amount due at that date, not on the excess", () => {
    const out = captain();
    const late = out.findings.filter((f) => f.check === "tds_late_deducted");
    expect(late).toHaveLength(1);
    // only 2% of the 55,764 October bill — 1,115.28, its own tax — was due
    // by 15-Oct-2025; the rest was paid in advance and is not late payment.
    expect(late[0].amount).toBe(1115.28);
    expect(late[0].schedule).toEqual([
      { kind: "i", amount: 11.1528, from: "20251015", to: "20251016", basis: expect.any(String) },
    ]);
  });

  it("leaves a bill the bank already covered with nothing to report", () => {
    // the same two bills, but the books deducted 5,600 — the year's 4,353.62
    // plus the October bill's own 1,115.28 — so nothing is outstanding
    const out = run(
      ectx,
      [
        {
          ledger: eDuty,
          rows: [{ ...row("20251016", "D/1", -5600, eParty), voucherType: "Journal" }],
        },
      ],
      [
        {
          ledger: eLedger,
          rows: [bill("20251015", "P/1", 55764), bill("20251226", "P/2", 161917.2)],
        },
      ],
    );
    expect(notDeducted(out)).toEqual([]);
    expect(out.findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
    // the over-deduction is still reported as late payment of what WAS due
    expect(out.findings.filter((f) => f.check === "tds_late_deducted").map((f) => f.amount)).toEqual(
      [1115.28],
    );
  });
});
