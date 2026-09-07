import { findingId, sideOf, type Check } from "../types.js";

export const ledgerUnderPrimaryGroup: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (!input.isPrimaryGroup(row.parent)) continue;
    n += 1;
    out.push({
      id: findingId("ledger_under_primary_group", n),
      check: "ledger_under_primary_group" as const,
      severity: "review" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: sideOf(row.balance),
      expected: null,
      detail:
        `${row.name} sits directly under the primary group ${row.parent} rather than a sub-group. ` +
        `Balances are unaffected, but it is grouped wrongly in every report`,
    });
  }
  return out;
};
