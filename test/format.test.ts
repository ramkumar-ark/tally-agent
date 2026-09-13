import { describe, expect, it } from "vitest";
import { dayBefore, displayDate, displayMonth, money } from "../src/format.js";
import { scrubSecrets } from "../src/mask.js";

describe("outbound display formats", () => {
  it("formats money with Indian grouping and two decimals", () => {
    expect(money(100000)).toBe("1,00,000.00");
    expect(money(41250.5)).toBe("41,250.50");
    expect(money(-12500)).toBe("-12,500.00");
  });

  it("renders a YYYYMMDD date for display", () => {
    expect(displayDate("20260116")).toBe("16-Jan-2026");
    expect(displayDate("20251231")).toBe("31-Dec-2025");
  });

  it("refuses to render a malformed date", () => {
    expect(displayDate("2026011")).toBe("unknown date");
    expect(displayDate("20261316")).toBe("unknown date");
  });

  it("renders a YYYY-MM month for display", () => {
    expect(displayMonth("2026-01")).toBe("Jan-2026");
    expect(displayMonth("2026-13")).toBe("unknown month");
  });

  it("steps back one calendar day across month, year and leap-day edges", () => {
    expect(dayBefore("20250401")).toBe("20250331");
    expect(dayBefore("20260101")).toBe("20251231");
    expect(dayBefore("20240301")).toBe("20240229");
  });

  it("survives the outbound digit scrub unchanged", () => {
    const s = `on ${displayDate("20260116")} for ${money(125000)}`;
    expect(scrubSecrets(s)).toBe(s);
  });
});
