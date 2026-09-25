import { buildWorkbook, type Sheet } from "./xlsx.js";
import { winmanSectionOf, type NoTdsCandidateRow, type NotdsSheetKey } from "./notds.js";

/**
 * The generated, fillable clause-21(b) operator decisions workbook (design of
 * record: docs/design/2026-09-24-no-tds-disallowance-design.md §4; plan
 * Task 5). Same channel as the TDS and PF/ESI templates: written through the
 * project's own workbook writer directly — NOT through the de-masking
 * `writeWorkbook`, because a freshly generated template carries party names
 * and PANs that were never masked outbound text and that live on the
 * operator's disk.
 *
 * The Candidates sheet pre-fills the books facts; the operator's decisions
 * ride the later columns. The hidden Lists sheet backs every dropdown with a
 * cross-sheet range — never an inline OOXML list, which is capped at 255
 * characters and breaks on any comma or quote in a value (AGENTS.md edge).
 */

/** The four NotdsSheetKey tab names, in workbook order — the Manual Rows Sheet dropdown. */
export const NOTDS_SHEET_KEYS: readonly NotdsSheetKey[] = [
  "40(a)(ia) to resident",
  "40(a)(i) to non-resident",
  "40(a)(ib) - Equalisation Levy",
  "40(a)(iii)",
];

/** The Cure Reason dropdown tokens; blank means "unexplained include". */
export const NOTDS_CURE_REASONS: readonly string[] = [
  "threshold",
  "transporter-declaration",
  "payee-filed-return",
  "deposited-by-return-date",
  "other",
];

/**
 * The 38-value STATE list Winman's clause-21(b) sheets validate against
 * (design §2.2): the 28 states and 8 union territories, plus "Other
 * Territory" and "State outside India". Not yet byte-verified against the
 * real workbook's STATE INTER range — recorded as a confirm item for the
 * live-validation pass; the parser (Task 6) deliberately does not re-validate
 * the state against this list, and Winman's own import rejects a bad value.
 */
export const NOTDS_STATES: readonly string[] = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "NCT of Delhi",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Ladakh",
  "Lakshadweep",
  "Other Territory",
  "State outside India",
];

const LISTS_SHEET = "Lists";

/** `Lists!$<col>$2:$<col>$<count+1>` — the header is row 1, values start at row 2. */
const listFormula = (col: string, count: number): string =>
  `${LISTS_SHEET}!$${col}$2:$${col}$${count + 1}`;

const instructions = (company: string): Sheet => ({
  name: "Instructions",
  columns: [{ header: "How to fill this template", width: 110, format: "text" }],
  rows: [
    [`No TDS disallowance operator template for ${company}.`],
    [
      "This workbook decides what reaches clause 21(b) of Form 3CD. The Candidates sheet lists payments the books already show as TDS-liable but not compliant — nothing was deducted, or the deduction fell short, or no deposit joined it by the deposit due date. You make decisions only in the columns AFTER the PAN column; the books columns are here for your reference and belong to the review.",
    ],
    [
      "Include: leave blank and it counts as Include=Y — the row is worked into the Winman sheets. Put N only when the row does NOT belong in the year's disallowance; then a Cure Reason is required (Include=N with a blank Cure Reason does not parse). Cure Reason tokens: threshold (paid below the TDS threshold), transporter-declaration (s.194C(6) goods-transport declaration), payee-filed-return (the resident payee filed its return and paid the tax — s.201(1) first proviso, the 40(a)(ia) cure (2)), deposited-by-return-date (deducted and deposited by the s.139(1) due date — the 40(a)(i)/(ia)/(ib) cure), other (say why in Notes).",
    ],
    [
      "Residency: leave blank for a resident deductee — the default is resident unless marked NR. For an NR row pick NR and fill NR Section with the TDS section in Winman spelling (195, 196A, 194E, …); a marked NR row with no NR Section does not parse.",
    ],
    [
      "Amount: the full payment gross from the books (C13 default). Amount Override is blank for almost every row — enter an amount only when the books figure itself is wrong; the override, not the gross, then carries to Winman.",
    ],
    [
      "Dates are typed as 2026-01-15 or picked from the calendar picker. The State dropdown carries the 38-value state list (including State outside India). NR Section, Section on Manual Rows (see below), Nature of Payment, Address, City, PIN, Country and Notes are free text; the parser re-validates a section against the target sheet's law list, never the dropdown.",
    ],
    [
      "The Manual Rows sheet exists for what the books cannot see: 40(a)(i) to non-resident, 40(a)(ib) equalisation levy, 40(a)(iii) salary paid outside India or to a non-resident, and any 40(a)(ia) payment the books cannot see. One row per payment: pick the target sheet in the Sheet dropdown, give party, date, amount and whatever tax/levy was deducted or deposited.",
    ],
    ["The cure reasons carry the law with them:"],
    [
      "40(a)(i) — interest/royalty/FTS/any TDS-liable sum payable outside India or to a non-resident; TDS not deducted, or deducted but not deposited by the s.139(1) due date. Disallowance: 100%. Cure provisos: (a) deduct in a later year and deposit by that year's return due date → allowed in year of payment; (b) payee (resident) filed return u/s 139, disclosed income, paid tax, payer holds payee's certificate in the prescribed form → deemed compliant (CONFIRM C10: the certificate's exact form).",
    ],
    [
      "40(a)(ia) — sum payable to a resident on which Ch. XVII-B TDS was not deducted, or after deduction not paid on or before the s.139(1) due date. Disallowance: 30% of the sum. Cure provisos: (1) deducted in a later year, or deducted in the PY but paid after the 139(1) due date → 30% allowed in year of payment; (2) not in default under the first proviso to s.201(1) (resident payee filed return + paid tax) → deemed deducted and paid on the payee's return-furnishing date. Short deduction: mainstream view = 30% of the un-deducted base only (some ITAT authorities contra — noted; Winman applies the percentages, this template carries payment facts only).",
    ],
    [
      "40(a)(ib) — sum paid/payable to a non-resident e-commerce operator for a specified service on which equalisation levy was deductible but not deducted/paid. Disallowance: the whole sum. Cure: deducted in a subsequent year, or paid after the due date → allowed in year of payment (CONFIRM C12: scope today — s.165 2% withdrawn w.e.f. 01-Aug-2024; s.166 6% online-advertisement levy continues; FA 2025 2% online-goods levy from 01-Oct-2025).",
    ],
    [
      "40(a)(iii) — salary payable outside India or to a non-resident; TDS (s.192) not deducted or not deposited by the TDS payment due date (not the 139(1) date). Disallowance: 100% (CONFIRM C11: secondary sources state a one-day-late deposit is fatal with no proviso; the Act's actual proviso text unverified).",
    ],
    [
      "Privacy: this file carries party names, PANs and payment figures. Never paste its rows into chat — pass its path to the review; the file itself is read inside the gateway.",
    ],
    [
      "Do not rename the sheets or the header columns; the parser binds by header text, never by position.",
    ],
    ["Worked example (invented names and figures only):"],
    [
      "Candidates | samplebasicsllp|20260115|2|194-I(a) | Sample Basics LLP | 15-Jan-2026 | 2 | 194I (a) | 1,00,000.00 | | | 15-Jun-2026 | 20,000.00 | | N | threshold |  |  |  | Karnataka |  | India |  | rent top-up, short-deducted",
    ],
    ["Manual Rows | 40(a)(ia) to resident | Sample Traders | 05-Feb-2026 | 40,000.00 | | | 194J | rent top-up paid cash"],
    ["Manual Rows | 40(a)(i) to non-resident | Sample Overseas GmbH | 20-Jan-2026 | 2,50,000.00 | | | | royalty to a non-resident"],
  ],
});

/**
 * The Candidates sheet: the books facts pre-filled from the engine's
 * candidate rows (`NoTdsCandidateRow`), the operator's decisions after the
 * PAN column. Emitted with headers even when no candidates exist (a
 * manual-only template). The Section is the Winman spelling via
 * `winmanSectionOf` (194-I(a) → 194I (a)).
 */
const candidatesSheet = (candidates: readonly NoTdsCandidateRow[]): Sheet => ({
  name: "Candidates",
  columns: [
    { header: "Key", width: 30, format: "text" },
    { header: "Party", width: 28, format: "text" },
    { header: "Date", width: 14, format: "date" },
    { header: "Voucher", width: 10, format: "text" },
    { header: "Section", width: 12, format: "text" },
    { header: "Gross", width: 14, format: "money" },
    { header: "TDS Done", width: 13, format: "money" },
    { header: "TDS Deposited", width: 14, format: "money" },
    { header: "Deposit Date", width: 14, format: "date" },
    { header: "Liability", width: 14, format: "money" },
    { header: "PAN", width: 14, format: "text" },
    { header: "Include", width: 9, format: "text", validation: { formula: listFormula("A", 2) } },
    { header: "Cure Reason", width: 24, format: "text", validation: { formula: listFormula("B", NOTDS_CURE_REASONS.length) } },
    { header: "Residency", width: 10, format: "text", validation: { formula: listFormula("C", 2) } },
    { header: "NR Section", width: 12, format: "text" },
    { header: "Nature of Payment", width: 22, format: "text" },
    { header: "Address", width: 24, format: "text" },
    { header: "City", width: 14, format: "text" },
    { header: "State", width: 18, format: "text", validation: { formula: listFormula("E", NOTDS_STATES.length) } },
    { header: "PIN", width: 10, format: "text" },
    { header: "Country", width: 12, format: "text" },
    { header: "Amount Override", width: 15, format: "money" },
    { header: "Notes", width: 26, format: "text" },
  ],
  rows: candidates.map(
    (c): Array<string | number | null> => [
      c.key,
      c.party,
      c.date,
      c.voucherNumber,
      winmanSectionOf(c.section),
      c.gross,
      c.tdsDone,
      c.tdsDeposited,
      c.depositDate ?? null,
      c.liability,
      c.pan ?? null,
    ],
  ),
});

/**
 * The Manual Rows sheet: operator-supplied payments for 40(a)(i)/(ib)/(iii)
 * — and anything else the books cannot see. Section is free text (validated
 * at parse against the target sheet's list); the State column here rides the
 * same dropdown as the Candidates sheet.
 */
const manualSheet = (): Sheet => ({
  name: "Manual Rows",
  columns: [
    { header: "Sheet", width: 30, format: "text", validation: { formula: listFormula("D", NOTDS_SHEET_KEYS.length) } },
    { header: "Party", width: 28, format: "text" },
    { header: "Date", width: 14, format: "date" },
    { header: "Amount", width: 14, format: "money" },
    { header: "Tax/Levy Deducted", width: 17, format: "money" },
    { header: "Tax/Levy Deposited", width: 18, format: "money" },
    { header: "Section", width: 12, format: "text" },
    { header: "Nature of Payment", width: 22, format: "text" },
    { header: "PAN/Aadhaar", width: 14, format: "text" },
    { header: "Address", width: 24, format: "text" },
    { header: "City", width: 14, format: "text" },
    { header: "State", width: 18, format: "text", validation: { formula: listFormula("E", NOTDS_STATES.length) } },
    { header: "PIN", width: 10, format: "text" },
    { header: "Country", width: 12, format: "text" },
    { header: "Notes", width: 26, format: "text" },
  ],
  rows: [],
});

/**
 * The hidden Lists sheet — the dropdown ranges' only home. One column per
 * list, values top-aligned under a header row.
 */
const listsSheet = (): Sheet => ({
  name: LISTS_SHEET,
  state: "hidden",
  columns: [
    { header: "Include", width: 10, format: "text" },
    { header: "Cure Reason", width: 24, format: "text" },
    { header: "Residency", width: 10, format: "text" },
    { header: "Sheet", width: 30, format: "text" },
    { header: "State", width: 30, format: "text" },
  ],
  rows: Array.from(
    { length: Math.max(2, NOTDS_CURE_REASONS.length, NOTDS_SHEET_KEYS.length, NOTDS_STATES.length) },
    (_, i): Array<string | null> => [
      i < 2 ? ["Y", "N"][i] : null,
      NOTDS_CURE_REASONS[i] ?? null,
      i < 2 ? ["R", "NR"][i] : null,
      NOTDS_SHEET_KEYS[i] ?? null,
      NOTDS_STATES[i] ?? null,
    ],
  ),
});

export interface NotdsTemplateInput {
  company: string; // masked slug for the filename only
  candidates: readonly NoTdsCandidateRow[]; // may be empty (manual-only template)
  generatedOn: string; // YYYYMMDD
}

/**
 * The workbook: Instructions, Candidates (prefilled or empty), Manual Rows,
 * hidden Lists. Operator disk: `buildWorkbook` direct, never masked.
 */
export function buildNotdsTemplate(input: NotdsTemplateInput): Buffer {
  return buildWorkbook([
    instructions(input.company),
    candidatesSheet(input.candidates),
    manualSheet(),
    listsSheet(),
  ]);
}

/** The file name the generator tool writes; the company rides as its slug. */
export function notdsTemplateFileName(company: string, date: string): string {
  const name = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `notds-operator-template-${name}-${date}.xlsx`;
}
