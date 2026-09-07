import type { Check, Finding, ReviewInput } from "../types.js";
import { negativeCash } from "./negativeCash.js";
import { outOfBalance } from "./outOfBalance.js";
import { suspenseBalance } from "./suspenseBalance.js";

export { negativeCash, outOfBalance, suspenseBalance };

export const ALL_CHECKS: Check[] = [outOfBalance, suspenseBalance, negativeCash];

export function runChecks(input: ReviewInput): Finding[] {
  return ALL_CHECKS.flatMap((check) => check(input));
}
