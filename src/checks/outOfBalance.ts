import { findingId, TOTALS_TOLERANCE, type Check } from "../types.js";

export const outOfBalance: Check = (input) => {
  const diff = input.totalDebit - input.totalCredit;
  if (Math.abs(diff) <= TOTALS_TOLERANCE) return [];
  return [
    {
      id: findingId("out_of_balance", 1),
      check: "out_of_balance",
      severity: "critical",
      ledger: "",
      group: "",
      amount: Math.abs(diff),
      side: diff > 0 ? "Dr" : "Cr",
      expected: null,
      detail:
        `Trial balance does not balance as of ${input.asOnDate}: ` +
        `debits ${input.totalDebit.toFixed(2)}, credits ${input.totalCredit.toFixed(2)}, ` +
        `difference ${Math.abs(diff).toFixed(2)} ${diff > 0 ? "Dr" : "Cr"}`,
    },
  ];
};
