/**
 * Outbound display formats. Every string a tool returns passes through
 * scrubDigits, which turns any run of six or more digits into "[number]" —
 * so a bare "100000.00" or a bare "20260116" reaches the model mangled.
 * Finding details format money and dates through these helpers instead.
 */

/** Indian digit grouping (1,00,000.00): no bare 6+-digit run survives to be scrubbed. */
export const money = (n: number): string =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20260116" -> "16-Jan-2026". A bare YYYYMMDD is an 8-digit run. */
export function displayDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return "unknown date";
  const month = MONTHS[Number(yyyymmdd.slice(4, 6)) - 1];
  if (!month) return "unknown date";
  return `${yyyymmdd.slice(6, 8)}-${month}-${yyyymmdd.slice(0, 4)}`;
}

/** "2026-01" -> "Jan-2026". */
export function displayMonth(yyyyDashMm: string): string {
  const month = MONTHS[Number(yyyyDashMm.slice(5, 7)) - 1];
  return month ? `${month}-${yyyyDashMm.slice(0, 4)}` : "unknown month";
}

/** The calendar day before a YYYYMMDD date, as YYYYMMDD. */
export function dayBefore(yyyymmdd: string): string {
  const d = new Date(
    Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6, 8)),
    ),
  );
  d.setUTCDate(d.getUTCDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
