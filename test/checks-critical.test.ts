import { describe, expect, it } from "vitest";
import { negativeCash, outOfBalance, suspenseBalance } from "../src/checks/index.js";
import type { GroupRole, ReviewInput, TbRow } from "../src/types.js";

function input(over: Partial<ReviewInput> & { rows?: TbRow[] }): ReviewInput {
  const roles: Record<string, GroupRole> = {
    "Suspense A/c": "suspense",
    "Cash-in-Hand": "cash",
    "Sundry Debtors": "debtor",
  };
  return {
    asOnDate: "20260331",
    rows: [],
    ledgers: [],
    totalDebit: 0,
    totalCredit: 0,
    roleOf: (g) => roles[g] ?? "other",
    isPrimaryGroup: () => false,
    ...over,
  };
}

describe("outOfBalance", () => {
  it("flags a difference beyond tolerance", () => {
    const f = outOfBalance(input({ totalDebit: 100000, totalCredit: 99000 }));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("out_of_balance");
    expect(f[0].severity).toBe("critical");
    expect(f[0].amount).toBe(1000);
    expect(f[0].side).toBe("Dr");
  });

  it("reports the credit direction when credits exceed debits", () => {
    const f = outOfBalance(input({ totalDebit: 99000, totalCredit: 100000 }));
    expect(f[0].side).toBe("Cr");
    expect(f[0].amount).toBe(1000);
  });

  it("is silent inside tolerance", () => {
    expect(outOfBalance(input({ totalDebit: 100000, totalCredit: 100000.04 }))).toEqual([]);
  });
});

describe("suspenseBalance", () => {
  it("flags any non-zero suspense balance", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Suspense", parent: "Suspense A/c", balance: 5000 }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("suspense_balance");
    expect(f[0].severity).toBe("critical");
    expect(f[0].ledger).toBe("Suspense");
  });

  it("is silent when suspense is nil", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Suspense", parent: "Suspense A/c", balance: 0.004 }] }),
    );
    expect(f).toEqual([]);
  });

  it("ignores non-suspense groups", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Acme", parent: "Sundry Debtors", balance: 5000 }] }),
    );
    expect(f).toEqual([]);
  });
});

describe("negativeCash", () => {
  it("flags a credit balance in cash", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: -250 }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("negative_cash");
    expect(f[0].severity).toBe("critical");
    expect(f[0].amount).toBe(250);
    expect(f[0].expected).toBe("Dr");
  });

  it("is silent on a positive cash balance", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: 250 }] }),
    );
    expect(f).toEqual([]);
  });

  it("is silent on a nil cash balance", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: 0 }] }),
    );
    expect(f).toEqual([]);
  });
});
