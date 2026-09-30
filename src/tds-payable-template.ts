import { createHash } from "node:crypto";
import { buildWorkbook, type Sheet } from "./xlsx.js";
import { displayDate } from "./format.js";
import type {
  TdsPayableCandidate,
  TdsPayableStatement,
  TdsPayableStatementRow,
  TdsPayableTotals,
} from "./tds-payable.js";

/**
 * The two operator workbooks of the TDS payable statement (design of record:
 * docs/design/2026-10-01-tds-payable-statement-design.md): the **decisions
 * workbook**, the operator fills and hands back, and the **statement**, the
 * payable list the challan and the correction statement are driven from.
 *
 * Same channel as the TDS and No-TDS operator templates: written through the
 * project's own workbook writer directly, never through the de-masking
 * `writeWorkbook`, because the statement carries real party names and PANs on
 * the operator's disk.
 *
 * The decisions workbook carries **no PAN column at all** — a PAN reaches only
 * the statement, and never an error message or a tool result.
 */

const LISTS_SHEET = "Lists";
const RUN_SHEET = "Run";

/** The two Decision tokens; a blank cell is NOT a decision. */
export const PAYABLE_DECISIONS = ["Accept", "Reject"] as const;

/** `Lists!$A$2:$A$3` — the Decision dropdown, never an inline OOXML list. */
const decisionListFormula = (): string => `${LISTS_SHEET}!$A$2:$A$${PAYABLE_DECISIONS.length + 1}`;

/** The run identity a decisions workbook is bound to; `digest` binds the ids. */
export interface PayableRunIdentity {
  company: string;
  fromDate: string;
  toDate: string;
  asOnDate: string;
  criticalCount: number;
  /** The review's own findings, ids only. */
  findingIds: readonly string[];
}

/**
 * A 12-hex-character digest of the run's identity plus its critical finding
 * ids. Short because a full SHA-256 can carry a 6-digit run that `scrubDigits`
 * would mangle out of any error message — and the digest is **never printed**
 * either way, so all a reader learns from a mismatch is that the file belongs
 * to another run.
 */
export function payableRunDigest(identity: PayableRunIdentity): string {
  const payload = [
    identity.company,
    identity.fromDate,
    identity.toDate,
    identity.asOnDate,
    String(identity.criticalCount),
    ...[...identity.findingIds].sort(),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** `tds-payable-decisions-<company-slug>-<YYYYMMDD>.xlsx` */
export function payableDecisionsFileName(company: string, date: string): string {
  return `tds-payable-decisions-${slug(company)}-${date}.xlsx`;
}

/** `tds-payable-statement-<company-slug>-payment<YYYYMMDD>.xlsx` */
export function payableStatementFileName(company: string, paymentDate: string): string {
  return `tds-payable-statement-${slug(company)}-payment${paymentDate}.xlsx`;
}

const instructions = (company: string, generatedOn: string, identity: PayableRunIdentity): Sheet => ({
  name: "Instructions",
  columns: [{ header: "How to fill this workbook", width: 110, format: "text" }],
  rows: [
    [`TDS payable decisions for ${company}.`],
    [`Generated on: ${displayDate(generatedOn)}`],
    [`Review period: ${displayDate(identity.fromDate)} to ${displayDate(identity.toDate)}; as on ${displayDate(identity.asOnDate)}.`],
    [`Critical findings in this run: ${identity.criticalCount}. Every one of them must be decided.`],
    [""],
    ["What to do"],
    ["1. Read the Finding column of the Findings sheet: it is the review's own wording for the shortfall."],
    ["2. Put Accept or Reject in the Decision column of that row. The dropdown carries exactly those two words."],
    ["3. Say why in Remarks. The statement quotes no remark, but the correction statement to the department does."],
    ["4. Save and close the file, then pass its PATH back — never paste its rows into chat."],
    [""],
    ["What a blank Decision means"],
    ["Nothing decided. The payable statement refuses to be produced while any critical finding is undecided,"],
    ["naming the open ones, because a silent omission would understate the challan."],
    ["Deleting a row is not a decision either: a deleted finding is reported as open."],
    [""],
    ["Accept or Reject"],
    ["Accept: this shortfall is real and is to be carried into the payable statement for that challan."],
    ["Reject: this shortfall is not to be paid — the operator has a reason (a threshold exemption, a corrected"],
    ["entry in the books, a return already filed). The reason belongs in Remarks."],
    [""],
    ["What the statement will contain for an Accepted row"],
    ["Date of booking, party name, party PAN, company or non-company, amount paid or credited, the tax that"],
    ["should have been deducted, the tax actually deducted, its date, the rate, the shortfall to pay, the"],
    ["s.201(1A) interest due to the payment date and the Rule 30 deposit due date."],
    ["The interest is the review's own schedule at 1% and 1.5% per month or part of a month — no second"],
    ["formula exists in this project. A shortfall that was never deducted is deemed deducted when the"],
    ["challan is paid, so it carries the late-deduction leg only."],
    ["The PAN is read from the ledger master, and from the GSTIN where the master has none. A party whose PAN"],
    ["cannot be found is shown as missing and is never guessed; it keeps its own bucket in the summary."],
    [""],
    ["This file is bound to one review run"],
    ["It carries the run's period and the identity of its critical findings on a hidden Run sheet. A workbook"],
    ["generated from another run is refused: its finding ids mean nothing against this review's rows."],
    ["Do not rename the sheets or the header columns; the parser binds by header text, never by position."],
  ],
});

/** The books facts pre-filled per critical finding, then the operator's two columns. */
const findingsSheet = (candidates: readonly TdsPayableCandidate[]): Sheet => ({
  name: "Findings",
  columns: [
    { header: "Finding ID", width: 16, format: "text" },
    { header: "Check", width: 22, format: "text" },
    { header: "Party", width: 30, format: "text" },
    { header: "Section", width: 12, format: "text" },
    { header: "Date", width: 13, format: "date" },
    { header: "Amount paid or credited", width: 16, format: "money" },
    { header: "Tax payable", width: 14, format: "money" },
    { header: "Tax actually deducted", width: 16, format: "money" },
    { header: "Date of deduction", width: 15, format: "date" },
    { header: "Rate of deduction", width: 13, format: "pct" },
    { header: "Shortfall to pay", width: 15, format: "money" },
    { header: "Finding", width: 90, format: "text" },
    { header: "Decision", width: 11, format: "text", validation: { formula: decisionListFormula() } },
    { header: "Remarks", width: 40, format: "text" },
  ],
  rows: candidates.map((c): Array<string | number | null> => [
    c.findingId,
    c.check,
    c.party,
    c.section,
    c.date,
    c.amountPaid,
    c.taxPayable,
    c.taxDeducted,
    c.deductionDate,
    c.rate,
    c.shortfall,
    c.detail,
    // Decision and Remarks ride null: a blank cell is the undecided state the
    // statement step refuses on.
    null,
    null,
  ]),
});

const listsSheet = (): Sheet => ({
  name: LISTS_SHEET,
  state: "hidden",
  columns: [{ header: "Decision", width: 12, format: "text" }],
  rows: PAYABLE_DECISIONS.map((d): Array<string | number | null> => [d]),
});

/**
 * The run identity, one `Field`/`Value` pair per row. Hidden, machine-read:
 * the parser binds it by header text and refuses any mismatch.
 */
const runSheet = (identity: PayableRunIdentity): Sheet => ({
  name: RUN_SHEET,
  state: "hidden",
  columns: [
    { header: "Field", width: 18, format: "text" },
    { header: "Value", width: 34, format: "text" },
  ],
  rows: [
    ["company", identity.company],
    ["fromDate", identity.fromDate],
    ["toDate", identity.toDate],
    ["asOnDate", identity.asOnDate],
    ["criticalCount", String(identity.criticalCount)],
    ["digest", payableRunDigest(identity)],
  ],
});

/**
 * The fillable decisions workbook: Instructions, Findings, hidden Lists,
 * hidden Run. The operator's disk only, so written with `buildWorkbook`
 * directly and never masked.
 */
export function buildPayableDecisions(args: {
  company: string;
  candidates: readonly TdsPayableCandidate[];
  identity: PayableRunIdentity;
  generatedOn: string;
}): Buffer {
  return buildWorkbook([
    instructions(args.company, args.generatedOn, args.identity),
    findingsSheet(args.candidates),
    listsSheet(),
    runSheet(args.identity),
  ]);
}

/**
 * The rate as the decimal the `pct` numFmt (`0.00%`) displays, or blank — a
 * rate the books never pinned is shown as missing rather than guessed.
 */
const rateCell = (rate: number | null): number | null => rate;

const statementColumns = () => [
  { header: "Date of booking", width: 13, format: "date" as const },
  { header: "Party", width: 30, format: "text" as const },
  { header: "Party PAN", width: 15, format: "text" as const },
  {
    header: "Company or non-company",
    width: 22,
    format: "text" as const,
  },
  { header: "Amount paid or credited", width: 16, format: "money" as const },
  { header: "TDS that should have been deducted", width: 18, format: "money" as const },
  { header: "TDS actually deducted", width: 17, format: "money" as const },
  { header: "Date of deduction", width: 15, format: "date" as const },
  { header: "Rate of deduction", width: 13, format: "pct" as const },
  { header: "Shortfall to pay", width: 15, format: "money" as const },
  { header: "Interest (i) at 1%", width: 15, format: "money" as const },
  { header: "Interest (ii) at 1.5%", width: 16, format: "money" as const },
  { header: "Interest due u/s 201(1A) to the payment date", width: 20, format: "money" as const },
  { header: "Deposit due date", width: 14, format: "date" as const },
  { header: "Finding ID", width: 16, format: "text" as const },
  { header: "Section", width: 12, format: "text" as const },
];

const statementRows = (rows: readonly TdsPayableStatementRow[]): Array<Array<string | number | null>> =>
  rows.map((r) => [
    r.date,
    r.party,
    r.pan ?? "",
    r.partyKind,
    r.amountPaid,
    r.taxPayable,
    r.taxDeducted,
    r.deductionDate,
    rateCell(r.rate),
    r.shortfall,
    r.interestI,
    r.interestII,
    r.interest,
    r.depositDueDate,
    r.findingId,
    r.section,
  ]);

/** The totals row, sitting directly under the data rows so Excel sums it. */
const totalsRow = (t: TdsPayableTotals): Array<string | number | null> => [
  null,
  "Total",
  null,
  null,
  t.amountPaid,
  t.taxPayable,
  t.taxDeducted,
  null,
  null,
  t.shortfall,
  t.interestI,
  t.interestII,
  t.interest,
  null,
  null,
  null,
];

const statementSheet = (statement: TdsPayableStatement): Sheet => ({
  name: "Payable statement",
  title: [
    `TDS payable statement — payment date ${displayDate(statement.paymentDate)}`,
    "One row per Accepted critical finding. Amount paid or credited is the expense base; the shortfall and",
    "the interest are the amounts payable, and the total is what the challan carries.",
    "A shortfall never deducted is deemed deducted on the payment date, so its deposit due date is the",
    "Rule 30 date after that payment and it carries the late-deduction leg of interest only.",
  ],
  columns: statementColumns(),
  rows: [...statementRows(statement.rows), totalsRow(statement.totals)],
});

const summaryTotals = (t: TdsPayableTotals): Array<Array<string | number | null>> => [
  ["Total tax payable to date", t.shortfall],
  ["Total interest due u/s 201(1A)", t.interest],
  ["Total payable", t.payable],
  [null],
  ["Total amount paid or credited", t.amountPaid],
  ["TDS that should have been deducted", t.taxPayable],
  ["TDS actually deducted", t.taxDeducted],
  ["Interest (i) at 1%", t.interestI],
  ["Interest (ii) at 1.5%", t.interestII],
];

const summarySheet = (statement: TdsPayableStatement, company: string, generatedOn: string): Sheet => ({
  name: "Summary",
  title: [`TDS payable statement summary — ${company}`],
  leadRows: [
    ["Payment date", displayDate(statement.paymentDate)],
    ["Generated on", displayDate(generatedOn)],
    [
      "Findings accepted",
      `${statement.accepted} accepted, ${statement.rejected} rejected of ${statement.accepted + statement.rejected} critical`,
    ],
  ],
  columns: [
    { header: "Headline", width: 44, format: "text" },
    { header: "Amount", width: 18, format: "money" },
    { header: "Rows", width: 8, format: "text" },
    { header: "Shortfall", width: 15, format: "money" },
    { header: "Interest (i)", width: 14, format: "money" },
    { header: "Interest (ii)", width: 15, format: "money" },
    { header: "Payable", width: 15, format: "money" },
  ],
  rows: [
    ...summaryTotals(statement.totals),
    [null],
    ["By section"],
    ...statement.bySection.map((g) => [
      g.section,
      g.totals.payable,
      String(g.rows),
      g.totals.shortfall,
      g.totals.interestI,
      g.totals.interestII,
      g.totals.payable,
    ]),
    [null],
    ["By company status"],
    ...statement.byPartyKind.map((g) => [
      g.kind,
      g.totals.payable,
      String(g.rows),
      g.totals.shortfall,
      g.totals.interestI,
      g.totals.interestII,
      g.totals.payable,
    ]),
    [null],
    ["Notes"],
    ["The company / non-company split is the 4th character of the PAN; C is a company. A party whose PAN"],
    ["could not be found is never guessed and keeps its own bucket, so the split still reconciles."],
    ["Interest is the review's own schedule at 1% and 1.5% per month or part of a month, measured to the"],
    ["payment date; there is no second interest formula in this project."],
    ["No TCS column and no return figure is on this sheet: it is a payable list, not a return."],
  ],
});

/**
 * The payable statement workbook: the statement rows with their totals row, and
 * a summary sheet carrying the three headline totals split by section and by
 * company status. Operator disk only — written with `buildWorkbook` directly.
 */
export function buildPayableStatement(args: {
  statement: TdsPayableStatement;
  company: string;
  generatedOn: string;
}): Buffer {
  return buildWorkbook([
    statementSheet(args.statement),
    summarySheet(args.statement, args.company, args.generatedOn),
  ]);
}