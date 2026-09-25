import { describe, expect, it } from "vitest";
import {
  EMPTY_LOANS_OPERATOR,
  buildLoansRows,
  type LoanEvent,
  type LoansBooksResult,
  type LoansOperator,
  type LoansOperatorParty,
} from "../src/loans.js";
import { LOANS_LIMIT } from "../src/loans-law.js";

const ev = (
  date: string,
  party: string,
  direction: LoanEvent["direction"],
  amount: number,
  mode: LoanEvent["mode"],
  narration = "",
): LoanEvent => ({ date, party, direction, amount, mode, narration });

describe("buildLoansRows", () => {
  it("rule 1: buckets a cash acceptance into sheet1 with the F/G tokens and a critical finding", () => {
    const res = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", 25_000, "cash", "cash receipt")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(res.sheet1).toHaveLength(1);
    expect(res.sheet1[0]).toMatchObject({
      party: "Party Alpha",
      amount: 25_000,
      mode: "Non-A/c payee modes",
      nonAcMode: "Cash",
      squaredUp: "No",
      maxAmount: 25_000,
    });
    expect(res.sheet3).toEqual([]);
    const f = res.findings.find((x) => x.check === "loans_cash_acceptance");
    expect(f?.severity).toBe("critical");
    expect(f?.ledger).toBe("Party Alpha");
    expect(f?.amount).toBe(25_000);
    expect(f?.detail).toContain("25,000.00");
    expect(f?.detail).toContain("15-Apr-2025");
    expect(f?.detail).toContain("Party Alpha");
  });

  it("rule 1: running balance peaks across both directions; closing 0 means squaredUp Yes", () => {
    const events: LoanEvent[] = [
      ev("20250401", "Party Alpha", "accepted", 25_000, "bank"),
      ev("20250501", "Party Alpha", "accepted", 15_000, "bank"),
      ev("20250601", "Party Alpha", "repaid", 40_000, "bank"),
    ];
    const res = buildLoansRows(events, EMPTY_LOANS_OPERATOR, { mastersPresent: true });
    expect(res.sheet1).toHaveLength(1);
    expect(res.sheet1[0]).toMatchObject({ amount: 40_000, maxAmount: 40_000, squaredUp: "Yes" });
    expect(res.sheet3[0]).toMatchObject({ amount: 40_000, maxAmount: 40_000, squaredUp: "Yes" });
  });

  it("rule 2: a party whose events never cross LOANS_LIMIT produces no rows and no findings", () => {
    const res = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", LOANS_LIMIT - 5_000, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(res.sheet1).toEqual([]);
    expect(res.sheet3).toEqual([]);
    expect(res.findings).toEqual([]);
  });

  it("rule 3: a cash repayment rows into sheet3 with loans_cash_repayment (critical)", () => {
    const res = buildLoansRows(
      [ev("20250710", "Party Beta", "repaid", 30_000, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(res.sheet3).toHaveLength(1);
    expect(res.sheet3[0]).toMatchObject({
      party: "Party Beta",
      amount: 30_000,
      mode: "Non-A/c payee modes",
      nonAcMode: "Cash",
    });
    const f = res.findings.find((x) => x.check === "loans_cash_repayment");
    expect(f?.severity).toBe("critical");
    expect(f?.detail).toContain("30,000.00");
    expect(f?.detail).toContain("10-Jul-2025");
    expect(f?.detail).toContain("Party Beta");
  });

  it("rule 4: a bank bucket takes the narration hint mode and never breaches", () => {
    const res = buildLoansRows(
      [ev("20250801", "Party Alpha", "accepted", 25_000, "bank", "paid via UPI ref 9")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(res.sheet1[0].mode).toBe("UPI");
    expect(res.sheet1[0].nonAcMode).toBeUndefined();
    expect(res.findings).toEqual([]);

    const ecs = buildLoansRows(
      [ev("20250801", "Party Alpha", "accepted", 25_000, "bank", "no hint here")],
      { ...EMPTY_LOANS_OPERATOR, defaultBankMode: "RTGS" },
      { mastersPresent: true },
    );
    expect(ecs.sheet1[0].mode).toBe("RTGS");

    const dflt = buildLoansRows(
      [ev("20250801", "Party Alpha", "accepted", 25_000, "bank", "no hint here")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(dflt.sheet1[0].mode).toBe("ECS");
  });

  it("rule 5: a journal bucket advises loans_mode_unknown and rows only under an operator override", () => {
    const bare = buildLoansRows(
      [ev("20250901", "Party Beta", "accepted", 2_10_000, "journal")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(bare.sheet1).toEqual([]);
    expect(bare.findings.map((f) => f.check)).toContain("loans_mode_unknown");
    const f = bare.findings.find((x) => x.check === "loans_mode_unknown");
    expect(f?.severity).toBe("review");
    expect(f?.ledger).toBe("Party Beta");

    const overridden = buildLoansRows(
      [ev("20250901", "Party Beta", "accepted", 2_10_000, "journal")],
      {
        parties: [
          { ledger: "Party Beta", modeOverrideAccepted: "A/c payee Cheque" },
        ],
      },
      { mastersPresent: true },
    );
    expect(overridden.sheet1[0]).toMatchObject({
      party: "Party Beta",
      mode: "A/c payee Cheque",
      amount: 2_10_000,
    });
    expect(overridden.findings.map((x) => x.check)).not.toContain("loans_mode_unknown");
  });

  it("rule 6: an exempt party never produces findings and rows only under an override", () => {
    const exempt: LoansOperator = {
      parties: [{ ledger: "Party Alpha", exempt: true }],
    };
    const cash = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", 25_000, "cash")],
      exempt,
      { mastersPresent: true },
    );
    expect(cash.findings).toEqual([]);
    expect(cash.sheet1).toEqual([]);

    const overridden: LoansOperator = {
      parties: [
        { ledger: "Party Alpha", exempt: true, modeOverrideAccepted: "ECS" },
      ],
    };
    const rowed = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", 25_000, "cash")],
      overridden,
      { mastersPresent: true },
    );
    expect(rowed.findings).toEqual([]);
    expect(rowed.sheet1).toHaveLength(1);
    expect(rowed.sheet1[0].mode).toBe("ECS");
  });

  it("rule 7: a Cash-breach-declared repayment keeps cash treatment and rows into sheet4 only", () => {
    const op: LoansOperator = {
      parties: [{ ledger: "Party Beta", modeOverrideRepaid: "Cash-breach-declared" }],
    };
    const res = buildLoansRows(
      [ev("20251001", "Party Beta", "repaid", 2_00_000, "bank", "bearer cheque")],
      op,
      { mastersPresent: true },
    );
    expect(res.sheet3[0]).toMatchObject({
      party: "Party Beta",
      mode: "Non-A/c payee modes",
      nonAcMode: "Cash",
    });
    expect(res.sheet4).toHaveLength(1);
    expect(res.sheet4[0]?.party).toBe("Party Beta");
    expect(res.findings.map((f) => f.check)).toContain("loans_cash_repayment");

    // sheet4 receives rows only from declarations
    const undeclared = buildLoansRows(
      [ev("20251001", "Party Beta", "repaid", 2_00_000, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(undeclared.sheet4).toEqual([]);
  });

  it("rule 8: sheet 2 is operator-specified sums only", () => {
    const op: LoansOperator = {
      parties: [],
      specifiedSums: [{ party: "Advance Opco", amount: 5_00_000 }],
    };
    const res = buildLoansRows([], op, { mastersPresent: true });
    expect(res.sheet2).toEqual([{ party: "Advance Opco", amount: 500_000 }]);
    expect(res.sheet2).toEqual([{ party: "Advance Opco", amount: 500_000 }]);
  });

  it("rule 9: same-day same-party same-direction multi-events raise one splitting advisory each, not mutated amounts", () => {
    const res = buildLoansRows(
      [
        ev("20250415", "Party Alpha", "accepted", 15_000, "cash"),
        ev("20250415", "Party Alpha", "accepted", 15_000, "cash"),
        ev("20250415", "Party Alpha", "repaid", 15_000, "cash"),
        ev("20250420", "Party Alpha", "accepted", 15_000, "cash"),
      ],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    const splits = res.findings.filter((f) => f.check === "loans_splitting_suspect");
    expect(splits).toHaveLength(1);
    expect(splits.map((f) => f.amount)).toEqual([30_000]);
    expect(splits[0]?.severity).toBe("review");
    // the 15-Apr accepted pair is the only multi-event (party, date, direction)
    const f = splits[0]!;
    expect(f.detail).toContain("2");
    expect(f.detail).toContain("30,000.00");
    expect(f.detail).toContain("15-Apr-2025");
    // bucket aggregate is the honest sum (3 x 15,000 accepted), advisory never shrinks it
    expect(res.sheet1[0]?.amount).toBe(45_000);
  });

  it("rule 2 strict: exactly 20,000 is no breach; 20,001 crosses (s.269SS 'exceeds')", () => {
    const exact = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", 20_000, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(exact.sheet1).toEqual([]);
    expect(exact.findings.filter((f) => f.check === "loans_cash_acceptance")).toHaveLength(0);

    const over = buildLoansRows(
      [ev("20250415", "Party Alpha", "accepted", 20_001, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(over.sheet1).toHaveLength(1);
    expect(over.findings.map((f) => f.check)).toContain("loans_cash_acceptance");

    // two sub-limit events still caught by the running balance > 20k test
    const split = buildLoansRows(
      [
        ev("20250501", "Party Beta", "accepted", 19_999, "cash"),
        ev("20250502", "Party Beta", "accepted", 19_999, "cash"),
      ],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true },
    );
    expect(split.sheet1).toHaveLength(1);
    expect(split.sheet1[0]?.amount).toBe(39_998);
  });

  it("C7: mastersPresent=false fires loans_max_amount_estimated once per party with movement", () => {
    const events: LoanEvent[] = [
      ev("20250401", "Party Alpha", "accepted", 25_000, "bank"),
      ev("20250402", "Party Alpha", "repaid", 25_000, "bank"),
      ev("20250403", "Party Beta", "accepted", 25_000, "cash"),
    ];
    const res = buildLoansRows(events, EMPTY_LOANS_OPERATOR, { mastersPresent: false });
    const est = res.findings.filter((f) => f.check === "loans_max_amount_estimated");
    expect(est).toHaveLength(2);
    expect(est.map((f) => f.ledger)).toEqual(["Party Alpha", "Party Beta"]);

    const off = buildLoansRows(events, EMPTY_LOANS_OPERATOR, { mastersPresent: true });
    expect(off.findings.filter((f) => f.check === "loans_max_amount_estimated")).toHaveLength(0);
  });

  it("rounds out a well-formed result and keying is canonical (case-insensitive party)", () => {
    const op: LoansOperator = {
      parties: [{ ledger: "Party Alpha" } as LoansOperatorParty],
    };
    const res: LoansBooksResult = buildLoansRows(
      [
        ev("20250415", "party alpha", "accepted", 25_000, "cash"),
        ev("20250416", "PARTY ALPHA", "accepted", 25_000, "cash"),
      ],
      op,
      { mastersPresent: true },
    );
    expect(res.sheet1).toHaveLength(1);
    expect(res.sheet1[0]?.amount).toBe(50_000);
    expect(Object.keys(res)).toEqual([
      "sheet1", "sheet2", "sheet3", "sheet4", "sheet5", "sheet6", "sheet7", "findings",
    ]);
  });
});
