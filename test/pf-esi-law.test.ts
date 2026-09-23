import { describe, expect, it } from "vitest";
import { CONFIRM_POINTS, FUND_LAW, dueDate, dueDateIsSunday, lawFor } from "../src/pf-esi-law.js";

describe("pf/esi law", () => {
  it("puts both funds' due date on the 15th of the following month", () => {
    expect(dueDate("2025-04")).toBe("20250515");
    expect(dueDate("2025-12")).toBe("20260115");   // year rolls over
    expect(dueDate("2026-03")).toBe("20260415");   // Review Focus #5: next FY
    expect(lawFor("PF").dueDayOfNextMonth).toBe(15);
    expect(lawFor("ESI").dueDayOfNextMonth).toBe(15);
  });

  it("cites the statute for each fund", () => {
    expect(lawFor("PF").authority).toMatch(/Para 38/);
    expect(lawFor("ESI").authority).toMatch(/Reg(ulation)?\.? 31/);
  });

  it("carries a confirm marker for every unresolved rule", () => {
    expect(FUND_LAW.every((f) => typeof f.authority === "string" && f.authority.length > 0)).toBe(true);
    expect(FUND_LAW.every((f) => f.confirm?.startsWith("C1"))).toBe(true);
    expect(CONFIRM_POINTS.map((c) => c.slice(0, 2))).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
  });

  it("flags a due date that falls on a Sunday without moving it", () => {
    expect(dueDate("2026-02")).toBe("20260315");
    expect(dueDateIsSunday("20260315")).toBe(true);   // 15-Mar-2026 is a Sunday
    expect(dueDateIsSunday("20250515")).toBe(false);
    expect(dueDateIsSunday("20260415")).toBe(false);  // 15-Apr-2026 is a Wednesday
  });
});
