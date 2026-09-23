import { describe, expect, it } from "vitest";
import { buildPfEsiTemplate, pfEsiTemplateFileName } from "../src/pf-esi-template.js";
import { parsePfEsiTemplate, EMPTY_PF_ESI } from "../src/pf-esi-file.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";

describe("pf/esi operator template", () => {
  it("ships its data sheet empty and parses to EMPTY_PF_ESI", () => {
    expect(parsePfEsiTemplate(buildPfEsiTemplate("Sample Co"))).toEqual(EMPTY_PF_ESI);
  });

  it("names the file after the company and date", () => {
    expect(pfEsiTemplateFileName("R V S Constructions", "20260923")).toBe("pf-esi-operator-template-r-v-s-constructions-20260923.xlsx");
  });

  it("offers a Fund dropdown so the operator cannot mistype the fund", () => {
    const sheets = readWorkbook(buildPfEsiTemplate());
    expect(sheets.map((s) => s.name)).toEqual(["Instructions", "Challans"]);
  });
});

describe("pf/esi operator template parsing", () => {
  const filled = (rows: Array<Array<string | number | null>>): Buffer => {
    const challans: Sheet = {
      name: "Challans",
      columns: [
        { header: "Fund", format: "text" },
        { header: "Wage Month", format: "text" },
        { header: "Paid On", format: "date" },
        { header: "Amount Paid", format: "money" },
      ],
      rows,
    };
    return buildWorkbook([
      { name: "Instructions", columns: [{ header: "How to fill this template" }], rows: [] },
      challans,
    ]);
  };

  it("reads a challan row", () => {
    const p = parsePfEsiTemplate(filled([["P.F.", "2025-04", "2025-05-14", 30575]]));
    expect(p.challans).toEqual([{ fund: "PF", wageMonth: "2025-04", paidOn: "20250514", amountPaid: 30575, sheet: "Challans", row: 2 }]);
  });

  // Review Focus #5
  it("accepts a payment date outside the audited year", () => {
    const p = parsePfEsiTemplate(filled([["P.F.", "2026-03", "2026-04-15", 28401]]));
    expect(p.challans[0].paidOn).toBe("20260415");
  });

  it("rejects a wage month that is not YYYY-MM, citing the cell address and never its value", () => {
    expect(() => parsePfEsiTemplate(filled([["P.F.", "Apr 25", "2025-05-14", 30575]])))
      .toThrow(/template Challans row 2, column B \(Wage Month\)/);
    expect(() => parsePfEsiTemplate(filled([["P.F.", "Apr 25", "2025-05-14", 30575]])))
      .not.toThrow(/Apr 25/);
  });

  it("rejects an unknown fund", () => {
    expect(() => parsePfEsiTemplate(filled([["Gratuity", "2025-04", "2025-05-14", 1]])))
      .toThrow(/template Challans row 2, column A \(Fund\)/);
  });

  it("rejects two challans for the same fund and wage month", () => {
    expect(() => parsePfEsiTemplate(filled([["P.F.", "2025-04", "2025-05-14", 1], ["P.F.", "2025-04", "2025-05-15", 2]])))
      .toThrow(/already has a challan/);
  });
});
