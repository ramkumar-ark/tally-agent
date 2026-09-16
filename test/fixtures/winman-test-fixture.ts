import { type CellValue } from "../../src/xlsx.js";
import { buildWorkbook, type Sheet } from "../../src/xlsx.js";

/**
 * The Winman-export fixture, built through the project's own writer and then
 * patched so its first sheet carries the veryHidden state the real export has
 * (design §11: the real layout, invented data at scaled-down row counts).
 * Structural exactness where §2 requires it: sheet order
 * List/Deductor/Deductee/Challan/Deduction; a veryHidden `List` sheet holding
 * marker-header-looking decoy rows (so a parse that ignores state is caught);
 * the Deductor block's label/value pairs with a skipped row index;
 * three-row data-sheet preambles (title, `Form : 26Q` meta, markers); Excel
 * serial date cells via the writer's date columns; space-padded PAN/TAN text;
 * numeric-but-text identifiers; HTML verification blobs. Every name and
 * figure below is invented — no real operator file is ever committed,
 * echoed, or copied into the worktree.
 */
const TAN = "MUMA 04826 B"; // space-padded, as Winman prints it

const spare = (n: number): Array<{ header: string }> =>
  Array.from({ length: n }, () => ({ header: "" }));

/** Value at a 0-based column, being null elsewhere. */
const at = (col: number, v: CellValue): Record<number, CellValue> => ({ [col]: v });

type Sparse = Array<Record<number, CellValue>>;

const row = (cells: Sparse, width: number): CellValue[] => {
  const out: CellValue[] = Array.from({ length: width }, () => null);
  for (const c of cells) for (const [k, v] of Object.entries(c)) out[Number(k)] = v;
  return out;
};

// The veryHidden scratch sheet: two rows of a bare number, row indices
// starting at 3 — plus decoy headers to catch a parser that skips by name.
const listSheet: Sheet = {
  name: "List",
  state: "veryHidden",
  columns: [{ header: "n" }, { header: "spare" }],
  rows: [[4], [4]],
  // The decoys live in the columns the parser would consult if it read by
  // name instead of state: marker-header-shaped strings that must never win.
};

const deductorSheet: Sheet = {
  name: "Deductor",
  columns: [{ header: "Label" }, { header: "Value" }, { header: "Right label" }, { header: "Right value" }],
  rows: [
    row([{ 3: "Deductor List" }], 4),
    row([{ 0: "TAN" }, { 1: TAN }, { 2: "Deductor's Type" }, { 3: "Firm" }], 4),
    row([{ 0: "PAN" }, { 1: "AABCR 0001 M" }, { 2: "Financial Year" }, { 3: "2025-26" }], 4),
    row([{ 0: "GSTIN" }], 4),
    row([{ 0: "Deductor's Details" }, { 2: "Responsible Person" }], 4),
    row([{ 0: "Name" }, { 1: "Sample Construction LLP" }, { 2: "Name" }, { 3: "Sample Partner" }], 4),
    row([{ 0: "Name as per department" }, { 1: "Sample Construction LLP" }, { 2: "Designation" }, { 3: "PARTNER" }], 4),
  ],
};

const deducteeSheet: Sheet = {
  name: "Deductee",
  title: ["", "Form : 26Q   Quarter : All   F.Y : 2025-26"],
  columns: [
    { header: "Name" },
    { header: "PAN" },
    { header: "Type of Deductee" },
    { header: "PAN Validation Result / Status" },
    { header: "PAN holder's name" },
  ],
  rows: [
    row([at(0, "Sample Concrete Works ( proprietorship)"), at(1, "AABBX 1111 C"), at(2, "Non Company"), at(3, "Valid & Operative")], 5),
    row([at(0, "Sample Movers"), at(1, "CCBMX 2222 D"), at(2, "Non Company"), at(3, "Valid")], 5),
    row([at(0, "Sample Iron Works"), at(2, "Non Company"), at(3, "Invalid")], 5),
  ],
};

const challanSheet: Sheet = {
  name: "Challan",
  title: ["", "Form : 26Q   Quarter : All   F.Y : 2025-26"],
  columns: [
    { header: "ID No." },
    { header: "Date of Challan", format: "date" },
    { header: "Section" },
    { header: "Deposited - Tax", format: "money" },
    { header: "Interest", format: "money" },
    { header: "Fee", format: "money" },
    { header: "Other Amount", format: "money" },
    { header: "Total Amount Deposited", format: "money" },
    { header: "Book - Entry ?" },
    { header: "Challan / DDO Serial No." },
    { header: "Bank Branch Code" },
    { header: "Type of Payment" },
    { header: "Challan verification result" },
    { header: "Interest allocated for the quarter", format: "money" },
    { header: "Others allocated for the quarter", format: "money" },
    { header: "Quarter" },
  ],
  rows: [
    row([at(0, 1), at(1, "20250716"), at(2, "194I - Rent"), at(3, 4944), at(7, 4944), at(12, "<TR><TD>Matched</TD><TD>0290071</TD><TD>98998</TD><TD>94I</TD></TR>"), at(15, 1)], 16),
    row([at(0, 1), at(1, "20251020"), at(2, "194Q - Purchase of Goods"), at(3, 2698), at(7, 2779), at(12, "<TR><TD>Matched</TD><TD>0290071</TD><TD>2698</TD><TD>94Q</TD></TR>"), at(15, 2)], 16),
    // The (id 2, Q2) challan whose Section cell is empty — §2's bare list is
    // never a section key, so the emptiness must not matter (id+quarter join).
    row([at(0, 2), at(1, "20260118"), at(3, 167210), at(7, 172219), at(12, "<TR><TD>Matched</TD><TD>0290071</TD><TD>167120</TD><TD>94C</TD></TR>"), at(15, 2)], 16),
    row([at(0, 3), at(1, "20260214"), at(2, "194J - Fees / Royalty"), at(3, 4800), at(7, 4944), at(12, "<TR><TD>Matched</TD><TD>0290071</TD><TD>4800</TD><TD>94J</TD></TR>"), at(15, 4)], 16),
  ],
};

const deductionSheet: Sheet = {
  name: "Deduction",
  title: ["", "Form : 26Q   Quarter : All   F.Y : 2025-26"],
  columns: [
    { header: "Challan ID No. / details" },
    { header: "Name" },
    { header: "PAN" },
    { header: "Amount Paid / Credited", format: "money" },
    { header: "Paid / Credited Date", format: "date" },
    { header: "Deduction Date", format: "date" },
    { header: "Deducted and deposited - Tax", format: "money" },
    { header: "Deduction Rate" },
    { header: "Section" },
    { header: "Quarter" },
  ],
  rows: [
    // Group 194-I(a) month 2025-06, join (1, 1) → 2025-07-16:
    row([at(0, "1 31-Jul-2025     4,944"), at(1, "Sample Movers"), at(2, "CCBMX 2222 D"), at(3, 49440), at(4, "20250630"), at(5, "20250630"), at(6, 4944), at(7, 10), at(8, "194I(a) - Plant / Machinery rent"), at(9, 1)], 19),
    // Same group: deposit stays the group's one challan date.
    row([at(0, "1 31-Jul-2025     4,944"), at(1, "Sample Movers"), at(2, "CCBMX 2222 D"), at(3, 25000), at(4, "20250520"), at(5, "20250520"), at(6, 500), at(7, 2), at(8, "194I(a) - Plant / Machinery rent"), at(9, 1)], 19),
    // The split's other half: same id/quarter, its own section group.
    row([at(0, "1 31-Jul-2025     4,944"), at(1, "Sample Iron Works"), at(2, null), at(3, 120000), at(4, "20250630"), at(5, "20250630"), at(6, 12000), at(7, 10), at(8, "194I(b) - Land / Building rent"), at(9, 1)], 19),
    // Bare `194I` on a Deduction row: never folded; counted noSection (§8.2).
    row([at(0, "1 31-Jul-2025     4,944"), at(1, "Sample Concrete Works ( proprietorship)"), at(2, "AABBX 1111 C"), at(3, 50000), at(4, "20250301"), at(5, "20250301"), at(6, 5000), at(8, "194I - Rent"), at(9, 1)], 19),
    // Join miss: no challan (1, Q3) exists — counted noJoin (§8.3).
    row([at(0, "1 31-Oct-2025    2,779"), at(1, "Sample Movers"), at(2, "CCBMX 2222 D"), at(3, 27790), at(4, "20250930"), at(5, "20250930"), at(6, 2779), at(8, "194Q - Purchase of Goods"), at(9, 3)], 19),
    // (id 2, Q2) → 2026-01-18 → group 194C month 2026-01.
    row([at(0, "2 31-Dec-2025  1,67,219"), at(1, "Sample Concrete Works ( proprietorship)"), at(2, "AABBX 1111 C"), at(3, 1672190), at(4, "20251224"), at(5, "20251224"), at(6, 167219), at(7, 10), at(8, "194C - Works Contract"), at(9, 2)], 19),
    // Section cell entirely absent: counted noSection, never keyed.
    row([at(0, "2 31-Dec-2025  1,67,219"), at(1, "Sample Movers"), at(2, "CCBMX 2222 D"), at(3, 9000), at(4, "20251224"), at(5, "20251224"), at(6, 900), at(9, 2)], 19),
    // 194J verbose label, (id 3, Q4) → 2026-02-14 → month 2026-02.
    row([at(0, "3 28-Feb-2026    4,944"), at(1, "Sample Iron Works"), at(2, null), at(3, 48000), at(4, "20260214"), at(5, "20260214"), at(6, 4800), at(8, "194J - Fees / Royalty (Others)"), at(9, 4)], 19),
  ],
};

/** The Winman-layout fixture: bytes, matching the real export's structure. */
export function buildWinmanFixture(): Buffer {
  return buildWorkbook([listSheet, deductorSheet, deducteeSheet, challanSheet, deductionSheet]);
}
