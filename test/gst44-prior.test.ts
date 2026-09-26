import { describe, expect, it } from "vitest";
import { readPriorWorksheet } from "../src/gst44-prior.js";
import { buildWorkbook } from "../src/xlsx.js";
import { canonicalKey } from "../src/key.js";

// The reference layout's header row: A..J with the D/J role cells the reader
// keys on. Amount columns D/E/F/H/J, gap columns G/I.
const header = (jLabel: string): unknown[] => [
  null,
  null,
  null,
  "Supplies exempt from GST",
  "Entities under composite scheme",
  "Others",
  "Total",
  "Un-registered",
  "Total expenditure",
  jLabel,
];
const dataRow = (label: string, d: number, e: number, f: number, h: number, j: number): unknown[] => [
  label,
  null,
  null,
  d,
  e,
  f,
  null,
  h,
  null,
  j,
];

const workbook = (sheets: Parameters<typeof buildWorkbook>[0]): Buffer => buildWorkbook(sheets);

describe("readPriorWorksheet", () => {
  it("reads the dominant treatment column of each row into its sheet map", () => {
    const prior = readPriorWorksheet(
      workbook([
        {
          name: "REVENUE",
          columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })),
          rows: [
            header("not supply"),
            dataRow("Rates & Taxes A/c", 0, 0, 0, 0, 5000),
            dataRow("Repair & Maintenance", 1200, 0, 0, 0, 0),
          ],
        },
        { name: "CAPITAL", columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })), rows: [header("paid to govt")] },
      ]),
    );
    const rev = prior.revenue.get(canonicalKey("Rates & Taxes A/c"))!;
    expect(rev).toMatchObject({ label: "Rates & Taxes A/c", treatment: "not_supply", split: false });
    expect(prior.revenue.get(canonicalKey("Repair & Maintenance"))!.treatment).toBe("exempt");
    expect(prior.capital.size).toBe(0);
  });

  it("flags a split row with its profile and keeps the dominant column", () => {
    const prior = readPriorWorksheet(
      workbook([
        {
          name: "REVENUE",
          columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })),
          rows: [header("not supply"), dataRow("Site Expenses", 2000, 0, 1500, 0, 0)],
        },
      ]),
    );
    const row = prior.revenue.get(canonicalKey("Site Expenses"))!;
    expect(row.split).toBe(true);
    expect(row.treatment).toBe("exempt");
    expect(row.profile).toContain("others");
  });

  it("skips total/rounding bookkeeping rows", () => {
    const prior = readPriorWorksheet(
      workbook([
        {
          name: "REVENUE",
          columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })),
          rows: [header("not supply"), dataRow("TOTAL", 999, 0, 999, 0, 0), dataRow("ROUNDED OFF", 900, 0, 0, 0, 0)],
        },
      ]),
    );
    expect(prior.revenue.size).toBe(0);
  });

  it("falls back to structure when the sheet name is not REVENUE/CAPITAL", () => {
    const prior = readPriorWorksheet(
      workbook([
        {
          name: "Break-up FY 24-25",
          columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })),
          rows: [header("not supply"), dataRow("Fuel Expenses", 0, 0, 700, 0, 0)],
        },
        {
          name: "Fixed assets",
          columns: Array.from({ length: 10 }, (_, i) => ({ header: String(i) })),
          rows: [header("paid to govt"), dataRow("JCB Purchased", 0, 0, 500000, 0, 0)],
        },
      ]),
    );
    expect(prior.revenue.get(canonicalKey("Fuel Expenses"))!.treatment).toBe("others");
    expect(prior.capital.get(canonicalKey("JCB Purchased"))!.treatment).toBe("others");
  });

  it("refuses a file with no recognisable break-up sheet", () => {
    expect(() =>
      readPriorWorksheet(
        workbook([{ name: "Sheet1", columns: [{ header: "A" }], rows: [["hello"]] }]),
      ),
    ).toThrow(/Supplies exempt from GST/);
  });
});
