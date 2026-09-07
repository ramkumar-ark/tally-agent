import { findingId, sideOf, type Check } from "../types.js";

export const overdrawnBank: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "bank") continue;
    if (sideOf(row.balance) !== "Cr") continue;
    n += 1;
    out.push({
      id: findingId("overdrawn_bank", n),
      check: "overdrawn_bank" as const,
      severity: "warning" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: "Cr" as const,
      expected: "Dr" as const,
      detail:
        `${row.name} is overdrawn by ${Math.abs(row.balance).toFixed(2)} as of ${input.asOnDate}. ` +
        `Correct if an overdraft facility exists; otherwise the account is misposted or unreconciled`,
    });
  }
  return out;
};
