import { findingId, sideOf, type Check, type GroupRole, type Side } from "../types.js";

/** Bank is deliberately absent: overdrawnBank owns it, with OD-aware wording. */
const EXPECTED_SIDE: Partial<Record<GroupRole, Side>> = {
  debtor: "Dr",
  creditor: "Cr",
  expense: "Dr",
  income: "Cr",
  stock: "Dr",
};

export const wrongSideBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    const expected = EXPECTED_SIDE[input.roleOf(row.parent)];
    if (!expected) continue;
    const side = sideOf(row.balance);
    if (!side || side === expected) continue;
    n += 1;
    out.push({
      id: findingId("wrong_side_balance", n),
      check: "wrong_side_balance" as const,
      severity: "warning" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side,
      expected,
      detail:
        `${row.name} in ${row.parent} carries a ${side === "Dr" ? "debit" : "credit"} balance of ` +
        `${Math.abs(row.balance).toFixed(2)} as of ${input.asOnDate}, where a ` +
        `${expected === "Dr" ? "debit" : "credit"} balance is expected`,
    });
  }
  return out;
};
