import type { Check, Finding, ReviewInput } from "../types.js";
import { dormantBalance } from "./dormantBalance.js";
import { ledgerUnderPrimaryGroup } from "./ledgerUnderPrimaryGroup.js";
import { negativeCash } from "./negativeCash.js";
import { outOfBalance } from "./outOfBalance.js";
import { overdrawnBank } from "./overdrawnBank.js";
import { suspenseBalance } from "./suspenseBalance.js";
import { wrongSideBalance } from "./wrongSideBalance.js";

export {
  dormantBalance,
  ledgerUnderPrimaryGroup,
  negativeCash,
  outOfBalance,
  overdrawnBank,
  suspenseBalance,
  wrongSideBalance,
};

export const ALL_CHECKS: Check[] = [
  outOfBalance,
  suspenseBalance,
  negativeCash,
  wrongSideBalance,
  overdrawnBank,
  ledgerUnderPrimaryGroup,
  dormantBalance,
];

export function runChecks(input: ReviewInput): Finding[] {
  return ALL_CHECKS.flatMap((check) => check(input));
}
