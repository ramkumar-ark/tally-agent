import { findingId, sideOf, type Check } from "../types.js";

export const negativeCash: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "cash") continue;
    if (sideOf(row.balance) !== "Cr") continue;
    n += 1;
    out.push({
      id: findingId("negative_cash", n),
      check: "negative_cash" as const,
      severity: "critical" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: "Cr" as const,
      expected: "Dr" as const,
      detail:
        `${row.name} shows a negative cash balance of ${Math.abs(row.balance).toFixed(2)} ` +
        `as of ${input.asOnDate}; cash cannot be negative, so receipts are unrecorded or a payment is misdated`,
    });
  }
  return out;
};
