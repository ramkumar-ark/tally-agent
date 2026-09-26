import { describe, expect, it } from "vitest";
import { TCS_NATURES, tcsDepositDue, tcsNatureByWinman, tcsStatementDue, TCS_INTEREST } from "../src/tcs-law.js";

describe("tcs-law", () => {
  it("has exactly the 13 Winman dropdown natures, exact strings", () => {
    expect(TCS_NATURES.map((n) => n.winman)).toEqual([
      "Liquor", "Minerals-coal/lignite/iron ore", "Mining & Quarrying Lease", "Motor vehicle",
      "Overseas Tour package", "Parking Lot Lease", "Remittance under LRS",
      "Sale of Notified goods u/s 206C(1F)(ii)", "Scrap", "Tendu leaves",
      "Timber or other forest product(except tendu leaves)-Forest Lease", "Timber-Others", "Toll Plaza Lease",
    ]);
  });

  it("looks up by exact Winman string only", () => {
    expect(tcsNatureByWinman("Scrap")?.key).toBe("scrap");
    expect(tcsNatureByWinman(" scrap")).toBeNull(); // no trim: dropdown strings are exact
  });

  it("every entry has a rate, threshold and authority or confirm marker", () => {
    for (const n of TCS_NATURES) {
      expect(n.rate).toBeGreaterThan(0);
      expect(n.threshold).toBeGreaterThanOrEqual(0);
      expect(n.authority.length).toBeGreaterThan(0);
      expect(n.confirm).toBeTruthy(); // all 13 pending captain confirmation
    }
  });

  it("deposit due is the 7th of the following month, March→30 Apr, Dec→7 Jan", () => {
    expect(tcsDepositDue("20250715")).toBe("20250807");
    expect(tcsDepositDue("20260320")).toBe("20260430");
    expect(tcsDepositDue("20251231")).toBe("20260107");
  });

  it("27EQ statement due dates mirror Rule 31A quarters", () => {
    expect(tcsStatementDue("Q1", "FY 25-26")).toBe("20250731");
    expect(tcsStatementDue("Q4", "FY 25-26")).toBe("20260531");
  });

  it("206C(7) interest rates", () => {
    expect(TCS_INTEREST.lateCollection).toBe(0.01);
    expect(TCS_INTEREST.lateDeposit).toBe(0.015);
  });
});
