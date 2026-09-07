import { findingId, sideOf, ZERO_TOLERANCE, type Check } from "../types.js";

export const dormantBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const l of input.ledgers) {
    if (Math.abs(l.openingBalance) < ZERO_TOLERANCE) continue;
    if (Math.abs(l.closingBalance - l.openingBalance) >= ZERO_TOLERANCE) continue;
    n += 1;
    out.push({
      id: findingId("dormant_balance", n),
      check: "dormant_balance" as const,
      severity: "review" as const,
      ledger: l.name,
      group: l.parent,
      amount: Math.abs(l.closingBalance),
      side: sideOf(l.closingBalance),
      expected: null,
      detail:
        `${l.name} opened and closed at ${Math.abs(l.closingBalance).toFixed(2)} with no movement ` +
        `in the period; a stale advance or an old balance carried forward unreviewed`,
    });
  }
  return out;
};
