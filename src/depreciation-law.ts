/**
 * The Income Tax Act rules this review needs that are NOT rates: the rate
 * comes from the company's own block group name (design §7). This module's
 * job is to validate that rate and to hold the rules around it.
 *
 * Sources are cited per note. A note with `confirm: true` should be re-read
 * against the bare Act before the first live run — the same discipline as
 * src/tds-law.ts's C1..C8.
 */

/** Appendix I rates in force for FY 2025-26, post the 2017-18 40% cap. */
export const ACT_RATES = [5, 10, 15, 20, 25, 30, 40] as const;

export const MAX_RATE = 40;

export const ADDITIONAL_DEPRECIATION_RATE = 20;

export function isActRate(rate: number): boolean {
  return (ACT_RATES as readonly number[]).includes(rate) && rate <= MAX_RATE;
}

/** YYYYMMDD -> UTC ms. */
const at = (ymd: string): number =>
  Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));

const ymd = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
};

/**
 * The first date in the previous year on which an asset first put to use
 * has FEWER than 180 days of use to the year end. Computed, never hard-coded:
 * a short first year or a different year end moves it.
 */
export function halfRateBoundary(yearEnd: string): string {
  return ymd(at(yearEnd) - 178 * 86400000);
}

/** Second proviso to s.32(1): under 180 days of use means half the rate. */
export function isShortPeriod(firstUse: string, yearEnd: string): boolean {
  return firstUse >= halfRateBoundary(yearEnd);
}

export interface DepLawNote {
  id: string;
  rule: string;
  source: string;
  /** true = re-read against the bare Act before the first live run. */
  confirm: boolean;
}

export const DEP_LAW_NOTES: readonly DepLawNote[] = [
  { id: "D1", rule: "Appendix I rates for the year are 5, 10, 15, 20, 25, 30 and 40 per cent.",
    source: "Income-tax Rules, Appendix I, Part A", confirm: true },
  { id: "D2", rule: "No block rate exceeds 40 per cent for years from 2017-18.",
    source: "Notification 103/2016 capping Appendix I", confirm: true },
  { id: "D3", rule: "An asset acquired AND put to use for less than 180 days takes half the rate. Applies to additions only, never to opening written-down value.",
    source: "s.32(1), second proviso", confirm: false },
  { id: "D4", rule: "The 180-day boundary is computed from the year end, not hard-coded.",
    source: "s.32(1), second proviso, read with the previous year's length", confirm: false },
  { id: "D5", rule: "Written-down value before depreciation = opening + actual cost of additions - moneys payable on assets sold, discarded, demolished or destroyed together with scrap value; floored at nil.",
    source: "s.43(6)(c)", confirm: false },
  { id: "D6", rule: "Where moneys payable exceed written-down value plus additions, the excess is a short-term capital gain; where the block retains value but no asset remains, the balance is a short-term capital loss. In either case no depreciation is allowed on that block for that year.",
    source: "s.50 read with s.2(11)", confirm: true },
  { id: "D7", rule: "Additional depreciation is 20 per cent of the actual cost of new plant and machinery for an assessee engaged in manufacture or production of an article or thing or in generation, transmission or distribution of power; 10 per cent where put to use under 180 days, with the balance 10 per cent in the immediately succeeding year. Excluded: ships and aircraft, second-hand plant, plant in office premises or residential accommodation or a guest house, office appliances, road transport vehicles, and plant whose whole cost is deductible.",
    source: "s.32(1)(iia) with its provisos, and the third proviso to s.32(1)", confirm: true },
  { id: "D8", rule: "The entry date of an acquisition in the asset ledger is used as a PROXY for the statutory date the asset was put to use. Tally holds no put-to-use date. Assets near the boundary are not flagged merely for being near it.",
    source: "design decision recorded against s.32(1), second proviso", confirm: false },
];
