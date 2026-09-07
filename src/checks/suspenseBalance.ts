import { findingId, sideOf, type Check } from "../types.js";

export const suspenseBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "suspense") continue;
    const side = sideOf(row.balance);
    if (!side) continue;
    n += 1;
    out.push({
      id: findingId("suspense_balance", n),
      check: "suspense_balance" as const,
      severity: "critical" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side,
      expected: null,
      detail:
        `${row.name} carries a suspense balance of ${Math.abs(row.balance).toFixed(2)} ${side} ` +
        `as of ${input.asOnDate}; suspense must be nil at finalization`,
    });
  }
  return out;
};
