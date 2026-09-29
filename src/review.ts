import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream, LedgerVoucherRow, VoucherRow } from "./downstream.js";
import {
  analyzeDepreciation, isAssetRowInScope, round2,
  type AssetRow, type BlockResult, type BlockResidual, type DepAnalyzeInput, type DepCtx, type ExcludedRow, type MovementRow,
} from "./depreciation.js";
import { EMPTY_DEP_OPERATOR, parseDepOperatorFile } from "./depreciation-file.js";
import {
  analyzeFaRegister, COST_TYPES, COST_VOCAB,
  type FaCtx, type FaDisposalRow, type FaPurchaseRow, type FaResult,
} from "./fa-register.js";
import { gstBooks, gstMismatch, gstSummary, RETURN_GROUP, type GstBooks, type GstCtx, type GstSummaryView } from "./gst.js";
import { gst44, partySpend, type Gst44Row, type OperatorGst44 } from "./gst44.js";
import { GST44_CONFIRMS, GST44_FORM_ID, GST44_SHEET, type Gst44Bucket } from "./gst44-law.js";
import { gst44Worksheet, type WsLedgerRow, WS_TREATMENT_LABELS } from "./gst44-worksheet.js";
import { buildGstWorksheet, fyLabel } from "./gst44-worksheet-template.js";
import { readWorksheetTotals } from "./gst44-worksheet-read.js";
import { readPriorWorksheet } from "./gst44-prior.js";
import { loadGst44TreatmentRules } from "./gst44-treatments.js";
import type { ReturnRow } from "./returns.js";
import { parseReturns } from "./returns.js";
import { count, dayBefore, displayDate, displayMonth, money } from "./format.js";
import { canonicalKey } from "./key.js";
import {
  analyzeAs26,
  assignFdLedgers,
  booksSales,
  deductionEvents,
  isFdLedgerName,
  otherIncomeCredits,
  declaredCreditLedgers,
  receivableLedgers,
  rekeyDeductionsToDeductor,
  voucherIdentity,
  vouchersFromLedgerRows,
  AS26_LIVE_ENTRIES_UNAVAILABLE,
  AS26_LIVE_ENTRIES_UNSUPPORTED,
  type BooksDeduction,
  type PartyMatch,
  type PartyRecon,
  type As26Result,
  type BankBooks,
  type BankBooksEvent,
  type FdAssignment,
} from "./as26.js";
import type { As26File, As26Kind } from "./as26-file.js";
import { loadAs26MapFile } from "./as26-template.js";
import { buildBillRows, type BillKind, type LinkBasis } from "./as26-bill.js";
import type { LedgerTaxInfo } from "./downstream.js";
import { maskFinding, maskKnownNames, maskLedgerName, scrubSecrets } from "./mask.js";
import { scrutinize, type MonthMovement } from "./scrutiny.js";
import { clause20b, employeeEvents, findFundLedgers, type BooksContext, type Clause20bRow, type FundLedgers } from "./pf-esi.js";
import type { OperatorPfEsi } from "./pf-esi-file.js";
import { lawFor, type FundKey } from "./pf-esi-law.js";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readXlsm, writeXlsm } from "./xlsm.js";
import { readSchema, readHandshake, writeSheetRows, findSheetPart, readListValues, type WinmanRow } from "./winman3cd.js";
import { type OperatorFile, type WinmanFacts } from "./tds-file.js";
import { projectLedgerRows, counterpartyOf, readDayBook, type DayBookInput } from "./tds-daybook.js";
import { timingOnlySection } from "./tds-law.js";
import {
  EMPTY_LOANS_OPERATOR,
  LOANS_SHEET_LABELS,
  LOANS_SHEET_NAMES,
  buildLoansCtx,
  buildLoansRows,
  loanAutoExemptNames,
  loanLedgerEvents,
  scan269St,
  type LoansOperator,
  type LoansReviewResult,
  type LoansSheetName,
  type LoansSheetRow,
} from "./loans.js";
import { parseLoansTemplate } from "./loans-file.js";
import {
  analyzeDep3cd,
  type Dep3cdAddition,
  type Dep3cdCtx,
  type Dep3cdDeletion,
} from "./dep3cd.js";
import { EMPTY_DEP3CD_OPERATOR, parseDep3cdTemplate } from "./dep3cd-file.js";
import { ADDITIONAL_DEPRECIATION_TEXT, DEFAULT_BLOCK_LISTS, DEPN_TEXT } from "./dep3cd-law.js";
import { parseNotdsTemplate, EMPTY_NOTDS_OPERATOR, type NotdsOperatorFile } from "./notds-file.js";
import {
  booksCandidates, doneKeyOf, depositedKeyOf, amountKeyOf, isNrSectionSpelling, winmanSectionOf,
  NOTDS_FORM_ID,
  type NoTdsCandidateRow, type NoTdsRow, type NotdsSheetKey,
} from "./notds.js";
/** Provenance literal used as a day-book finding's deductee (cleared in the classifier). */
const DAY_BOOK_FINDING = "(day-book file)";
/**
 * TCS nature-of-receipt heuristic: a /tcs/i duties-root ledger whose own name
 * carries the law's goods keyword resolves to that nature (TcsNature.key);
 * anything else is a `tcs_unclassified_ledger` finding, never a guess.
 */
const TCS_NAME_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/liquor/i, "liquor"],
  [/scrap/i, "scrap"],
  [/tendu/i, "tendu"],
  [/timber/i, "timber-others"],
  [/toll/i, "toll-plaza"],
  [/parking/i, "parking-lease"],
  [/mineral/i, "minerals"],
  [/mining/i, "mining-lease"],
  [/motor/i, "motor-vehicle"],
  [/tour/i, "overseas-tour"],
  [/\blrs\b/i, "lrs"],
  [/remittance/i, "lrs"],
  [/notified/i, "notified-goods"],
];
import { analyzeTds, type Clause21bBookRow, type SubsequentDeposit, type TdsCtx, type TdsEvents, type TdsLedgerRows, type TdsLiability } from "./tds.js";
import { analyzeTcs } from "./tcs.js";
import { tds3cdRows, type Tds3cdResult } from "./tds3cd.js";
import { tcsNatureByWinman } from "./tcs-law.js";
import { createVault, type Vault } from "./vault.js";
import {
  EMPTY_WRONG_GROUP,
  TOTALS_TOLERANCE,
  ZERO_TOLERANCE,
  type Finding,
  findingId,
  type GroupRole,
  type GstKind,
  type Severity,
  type As26Finding,
  type As26CheckId,
  type Side,
  type TbRow,
  type TdsCheckId,
  type TdsFinding,
  tdsFindingId,
  type NotdsCheckId,
  notdsFindingId,
  type WrongGroupConfig,
  type DepFinding,
  type D3cdCheckId,
  d3cdFindingId,
} from "./types.js";

/** A PAN is five letters, four digits, one letter. */
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/**
 * The PAN a ledger master carries implicitly: a GSTIN's characters 3–12 are
 * the holder's PAN. Only a 15-character GSTIN whose PAN span matches the
 * shape yields one — anything malformed derives nothing (unchanged behaviour).
 */
function panFromGstin(gstin: string | null): string | null {
  if (!gstin || gstin.length !== 15) return null;
  const candidate = gstin.slice(2, 12);
  return PAN_SHAPE.test(candidate) ? candidate : null;
}

/**
 * Ledger-bearing fields in a downstream voucher row. The real
 * tally_prime_mcp_server report envelope carries the counterparty under
 * partyLedgerName and counterLedgerName, and the queried ledger itself under
 * matchedLedgerName — not the "counterparty"/"ledgerName"/"partyName"/"party"
 * fields the plan draft assumed. See src/downstream.ts.
 */
const NAME_FIELDS: ReadonlySet<string> = new Set([
  "partyLedgerName",
  "counterLedgerName",
  "matchedLedgerName",
  // taxBreakup.taxLedgers[].ledgerName, nested one level down.
  "ledgerName",
]);

/** Engine-agnostic lowercase canon for the depreciation session. */
const canon = (s: string): string => s.trim().toLowerCase();

/** Roots the depreciation expense ledger may sit under (engine's own table, mirrored for the fetch). */
const DEP_EXPENSE_ROOTS = new Set([
  "indirect expenses", "direct expenses", "expenses (indirect)", "expenses (direct)",
]);
/** Roots the disposal-signal ledgers may sit under (design §9). */
const DEP_DISPOSAL_ROOTS = new Set([
  "indirect incomes", "direct incomes", "income (indirect)", "income (direct)", "sales accounts",
]);
const DEP_EXPENSE_NAME = /deprecia/i;
const DEP_DISPOSAL_NAME = /sale of (fixed )?asset|profit on sale of (fixed )?asset|asset disposal/i;

function maskVoucherRow(
  row: unknown,
  classifier: Classifier,
  vault: Vault,
  groupOf: Map<string, string>,
): unknown {
  if (typeof row !== "object" || row === null) return row;
  // Two passes, both at every depth (the live row nests taxBreakup and
  // matchCandidates). Pass 1 masks each ledger-name field by policy, which
  // vaults every masked name. Pass 2 sweeps every string — narration,
  // reference, matchCandidates entries — for any name the vault knows, then
  // scrubs tax-ID shapes and digit runs. The sweep only catches known names —
  // see the design doc's stated limitation on free-text name detection.
  return sweepStrings(maskNameFields(row, classifier, vault, groupOf), vault);
}

function maskNameFields(
  value: unknown,
  classifier: Classifier,
  vault: Vault,
  groupOf: Map<string, string>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => maskNameFields(v, classifier, vault, groupOf));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      NAME_FIELDS.has(k) && typeof v === "string" && v
        ? maskLedgerName(v, groupOf.get(canonicalKey(v)) ?? "", classifier, vault)
        : maskNameFields(v, classifier, vault, groupOf);
  }
  return out;
}

function sweepStrings(value: unknown, vault: Vault): unknown {
  if (typeof value === "string") return scrubSecrets(maskKnownNames(value, vault));
  if (Array.isArray(value)) return value.map((v) => sweepStrings(v, vault));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = sweepStrings(v, vault);
  return out;
}

/** One masked TDS finding: the engine shape with the deductee pseudonymed. */
export interface TdsMaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  deductee: string;
  group: string;
  section: string | null;
  amount: number;
  detail: string;
  /** Interest-schedule rows for tb_write_tds_report's third artifact. */
  schedule?: Array<{
    kind: "i" | "ii" | "fee";
    amount: number;
    from: string;
    to: string;
    basis: string;
  }>;
}

/** tb_tds_review's result: masked findings, the engine totals, and the count of the month-chunked ledger calls made (design doc §5). */
export interface TdsReviewResult {
  company?: string;
  /** False when the verbose master export failed and the run is operator-file-only. */
  mastersAvailable: boolean;
  fromDate: string;
  toDate: string;
  asOnDate: string;
  counts: Record<Severity, number>;
  /** Which channel supplied the operator facts (§8.5's envelope addition). */
  operatorSource: "json" | "template";
  /** Could-counts only: how much of the Winman side was consumed. */
  winman: { used: boolean; challans: number; deductees: number; panAdopted: number };
  findings: TdsMaskedFinding[];
  /**
   * One duty credit applied across several bookings (2026-09-29). The captain's
   * rule: a single deduction entry booked against several expense entries of
   * the SAME calendar month is normal bookkeeping, not a compliance issue, so
   * those bookings count as deducted and raise no finding. Listed here so a
   * reviewer can see why each of them is silent. `scope` is "month" (the
   * captain's rule) or "window" (the pre-existing 30-day cross-month split).
   * Deductees are pseudonyms, dates `displayDate`-formatted, amounts `money()`.
   */
  consolidations: Array<{
    deductee: string;
    section: string;
    scope: "month" | "window";
    creditDate: string;
    tax: number;
    bookings: Array<{ date: string; tax: number }>;
  }>;
  totals: {
    bySection: Array<{ section: string; gross: number; tax: number }>;
    notDeducted: number;
    shortDeducted: number;
    interestI: number;
    interestIi: number;
  };
  ledgerCalls: number;
  /** Where the per-ledger rows came from. "live" is ~640 Ledger-Vouchers calls. */
  booksSource: "live" | "daybook-file";
  /**
   * Whether s.194Q was checked. True by default; false only when the operator
   * expressly suppressed it (Settings sheet / JSON `section194QApplicable`),
   * i.e. the buyer did not meet the previous year's ₹10 crore turnover
   * condition. The run never computes 194Q figures in the false case.
   */
  section194QApplicable: boolean;
  /**
   * Clause-34 preview: row counts and money()-formatted amounts only — no
   * TAN, no ledger, party or deductor name. The full Tds3cdResult stays in
   * the session cache (tds3cdResult) for the Winman writer.
   */
  tds3cd?: {
    sheets: { tds: number; tcs: number; returns: number; interestTds: number; interestTcs: number };
    totals: { tdsNotDeposited: string; tcsNotDeposited: string; interestPayable: string };
    skippedInterestQuarters: string[];
  };
  /**
   * Present only for "daybook-file". Counts and dates only: the file's SHA-256
   * digest and byte size go to the audit log and the written report, never
   * here — a 64-character hex digest can hold a 6-digit run and scrubDigits
   * would mangle it into a different-looking digest.
   */
  books?: {
    vouchers: number;
    ledgersProjected: number;
    fromObserved: string;
    toObserved: string;
    rejected: number;
    mastersSource: "live" | "bundle" | "absent";
  };
}

/** One masked clause 21(b) finding: party pseudonymed, no PAN anywhere. */
export interface NoTdsMaskedFinding {
  id: string;
  check: NotdsCheckId;
  severity: Severity;
  party: string;          // pseudonym; "" for the aggregate line
  section: string | null; // Winman spelling
  amount: number;         // money at stake, positive
  detail: string;         // money()/displayDate() only, scrubbed
}

/** tb_notds_review's result: masked, per-sheet counts only. */
export interface NoTdsReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  /** Where the cached books came from (the tb_tds_review run's channel). */
  booksSource: "live" | "daybook-file";
  /** Books candidates projected from the cached review, before decisions. */
  candidates: number;
  /** Row counts written per sheet, including operator manual rows. */
  sheets: Record<NotdsSheetKey, number>;
 /** Candidates excluded by an Include=N decision (rows never written). */
  cureExcluded: number;
  /** Operator manual rows appended. */
  manualCount: number;
  findings: NoTdsMaskedFinding[];
  counts: Record<Severity, number>;
}

/** The books facts tb_tds_review caches for the clause 21(b) merge. */
interface TdsBooksCache {
  events: TdsEvents;
  liabilities: TdsLiability[];
  clause21b: Clause21bBookRow[];
  panOf: (party: string) => string | null;
  panDerivedFromGstinOf: (party: string) => boolean;
  panAliasOf: (party: string) => string | null;
  company: string | undefined;
  fromDate: string;
  toDate: string;
  booksSource: "live" | "daybook-file";
}

/** One masked PF/ESI finding: the engine Finding shape, ledger pseudonymed. */
export type PfEsiMaskedFinding = Finding;

/**
 * tb_pf_esi_review's result: masked findings, the joined clause 20(b) rows as
 * the model may see them (dates display-formatted, no names), and the fund
 * payable ledgers as pseudonyms. The unmasked rows never leave this module —
 * the Winman writer takes them from the cache.
 */
export interface PfEsiReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  counts: Record<Severity, number>;
  findings: PfEsiMaskedFinding[];
  rows: Array<Omit<Clause20bRow, "dueDate" | "paidOn"> & {
    dueDate: string;
    paidOn: string | null;
  }>;
  /** The fund payable ledgers found for the run, pseudonymed. */
  funds: { pf: string[]; esi: string[] };
  /** Which channel supplied the books (Q3: the day book is primary). */
  booksSource: "live" | "daybook-file";
  books?: {
    vouchers: number;
    rejected: number;
    mastersSource: "live" | "bundle" | "absent";
  };
}

/** One masked clause-44 party: pseudonym in, bucket numbers out (no GSTIN ever). */
export interface Gst44MaskedParty {
  party: string;
  override: boolean;
  ambiguous: boolean;
  capital: Record<Gst44Bucket, number>;
  revenue: Record<Gst44Bucket, number>;
}

/** Same field set as PfEsiMaskedFinding, but the amount may be null (the unknown-override warning carries none). */
export interface Gst44MaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number | null;
  side: null;
  expected: null;
  detail: string;
}

/**
 * tb_gst44_review's result: masked findings, the clause 44 break-up rows,
 * the per-party buckets as pseudonyms. GSTINs never appear — gstinSource
 * says where the statuses came from, gstinKnown booleans stay internal.
 */
export interface Gst44ReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  counts: Record<Severity, number>;
  findings: Gst44MaskedFinding[];
  rows: Array<{ label: string; total: number; exempt: number; composition: number; others: number; unregistered: number }>;
  parties: Gst44MaskedParty[];
  /** "live" = ledger-master GSTINs; "none" = operator template only. */
  gstinSource: "live" | "none";
  booksSource: "daybook-file" | "live";
  /** The design's confirm points C1-C6, printed next to the findings. */
  confirms: readonly string[];
  books?: {
    vouchers: number;
    rejected: number;
    mastersSource: "live" | "bundle" | "absent";
  };
}

/** Per-sheet totals of the GST working sheet: the books total plus the seeded rows' columns. */
export interface GstWorksheetColumnTotals {
  /** Signed net over every ledger row (classified or not) — the books' figure. */
  books: number;
  /** Seeded rows only below; an unclassified row contributes to none of them. */
  exempt: number;
  composition: number;
  others: number;
  unregistered: number;
  notSupply: number;
  unclassified: { count: number; amount: number };
}

/**
 * tb_write_gst_working_sheet's result: the written path and the masked
 * totals-by-column, seed-reason counts and findings. The workbook itself
 * carries real ledger names on the operator's disk; nothing masked leaves
 * here except pseudonyms.
 */
export interface GstWorksheetWriteResult {
  writePath: string;
  company?: string;
  fromDate: string;
  toDate: string;
  rows: { revenue: number; capital: number };
  revenue: GstWorksheetColumnTotals;
  capital: GstWorksheetColumnTotals;
  seedReasons: Record<string, number>;
  unclassified: Array<{ ledger: string; group: string; amount: number }>;
  findings: Gst44MaskedFinding[];
  priorYearUsed: boolean;
  gstinSource: "bundle" | "live" | "none";
  rulesSource: "built-in" | "operator";
  warnings: string[];
}

/** One masked 26AS finding: the engine shape with the party pseudonymed. */
export interface As26ReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  findings: As26Finding[];
  recon: Array<Omit<PartyRecon, "match"> & { match: Omit<PartyMatch, "ledgerName" | "as26Name"> & { ledgerName: string; as26Name: string } }>;
  gaps: As26Result["gaps"];
  totals: As26Result["totals"];
  mastersUnavailable: boolean;
  groupsUnavailable: boolean;
  skipped: As26Result["skipped"];
  counts: { credits: number; receivableLedgers: string[]; /** Per kind
   *  (tds/tcs), whether the books-side credit ledgers came from the
   *  operator's Credit Ledgers sheet or from the name heuristic — a declared
   *  kind replaces its own rule only. */
  creditLedgerSource: Record<As26Kind, "map" | "heuristic">; };
  /** FD-interest books entries taxed at ~20% — not expected in 26AS
   * (design §12.4); party labels masked like the findings'. */
  fd20: Array<{ party: string; date: string; interest: number; tax: number }>;
  /** Auto-assigned FD ledgers (addendum 3), masked; the written workbook
   * de-masks. ledger/bank pseudonymised here, rule as fired. */
  fdAuto: Array<{ ledger: string; bank: string; rule: string }>;
  /** FD ledgers no bank could be assigned to (addendum 3), masked like the
   * assigned ones; the workbook's auto-assign sheet lists them by name, so
   * the AS26-011 count is actionable. Optional: older results lack it. */
  fdUnassigned?: string[];
  /** Every books evidence row behind the recon, party-pseudonymed: the
   * written report's Books Events sheet (the drill-down the deduction and
   * sale vouchers give the operator). */
  bookEvents: Array<{ party: string; source: "deduction" | "sale" | "other income"; date: string; tax: number; voucherType: string; ref: string | null; ledger: string | null }>;
  /** Bill-level drill-down rows behind the recon (masked): sheetId B = books
   * deductions not in 26AS, D = 26AS transactions not in books, V = value
   * mismatches. Party labels equal the findings' masked labels, so the
   * findings' "see ... rows <ids>" pointers and these rows line up. */
  billRows: Array<{
    sheetId: "booksded" | "as26" | "value";
    /** The party's cross-sheet key (`P1`, `P2`, … in Deductors-sheet
     * order): the same id appears on the Deductors row and on that party's
     * rows in both unmatched sheets, so the operator can see that both sides
     * concern one party. Blank when the row's party matched no pair. Optional:
     * hand-built (older) results lack it. */
    partyId?: string;
    party: string; date: string; tax: number;
    gross: number | null; voucherType: string | null;
    ref: string | null; status: string | null; section: string | null;
    inWindow: boolean; linkBasis: LinkBasis;
    /** Windowed state on the raw engine date (A5): in / pre / post the reviewed period. */
    windowState: "in" | "pre" | "post";
    linked: { date: string; ref: string | null; taxable: number } | null;
    delta: number | null;
    /** Combination-consumed rows carry a reserved id but are hidden from the
     * unmatched sheets; their combination row cites the id instead. */
    explained: boolean;
  }>;
}

/** One masked depreciation finding: the engine shape with ledger+block pseudonymed. */
export interface DepMaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  ledger: string;
  block: string;
  amount: number;
  detail: string;
}

/** tb_depreciation_review's result: every ledger and block name already masked; de-masking happens in the writers only (R-P-5). */
export interface DepReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  counts: Record<Severity, number>;
  findings: DepMaskedFinding[];
  blocks: BlockResult[];
  assets: AssetRow[];
  /** Blocks whose statutory total their assets' own rates do not sum to. */
  blockResiduals: BlockResidual[];
  movements: MovementRow[];
  excluded: ExcludedRow[];
  bookCharge: number;
  seedSource: "operator" | "book-seed";
  /** Whole-company asset ledgers found in the block tree. */
  assetLedgers: number;
  /** Asset ledgers whose residual forced a month-chunked pass-2 fetch. */
  fetched: number;
  /** Downstream calls the two passes consumed. */
  calls: number;
}

/** One masked FA finding: same shape as the engine's, pseudonyms in. */
export interface FaMaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  ledger: string;
  block: string;
  amount: number;
  detail: string;
}

/** tb_fixed_asset_register's result: every ledger/block name and voucher id masked; de-masking happens in the writer only (R-P-5). */
export interface FaReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  counts: Record<Severity, number>;
  purchases: FaPurchaseRow[];
  disposals: FaDisposalRow[];
  vehicleCosts: FaResult["vehicleCosts"];
  vendors: FaResult["vendors"];
  findings: FaMaskedFinding[];
  /** Whole-company asset ledgers found in the block tree. */
  assetLedgers: number;
  /** Downstream calls the three fetches consumed. */
  calls: number;
}

export interface ReviewResult {
  asOnDate: string;
  company?: string;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  counts: Record<Severity, number>;
  findings: Finding[];
}

/** One masked GST finding, in the M1 Finding shape (design doc §4.2). */
export interface GstMaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  kind: GstKind;
  ledger: string;
  group: string;
  amount: number;
  detail: string;
}

export interface GstMismatchResult {
  company?: string;
  fromDate: string;
  toDate: string;
  returnRows: number;
  counts: Record<Severity, number>;
  findings: GstMaskedFinding[];
  aggregate: unknown;
}

/** One masked ledger scrutiny finding, CsvFinding-compatible (report.ts). */
export interface LedgerMaskedFinding {
  id: string;
  check: string;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number;
  side: Side | null;
  expected: Side | null;
  detail: string;
}

/** tb_ledger_scrutiny's result. Amounts positive = debit; the ledger's GSTIN never appears. */
export interface LedgerScrutinyResult {
  /** Opaque per-ledger handle ("L1") naming the scrutiny for tb_write_ledger_report. */
  scrutinyId: string;
  findingId: string;
  company?: string;
  /** Masked ledger name (a pseudonym for a party ledger). */
  ledger: string;
  group: string;
  role: GroupRole;
  fromDate: string;
  toDate: string;
  registeredForGst: boolean;
  opening: number;
  closing: number;
  totalDebit: number;
  totalCredit: number;
  netMovement: number;
  rowsScanned: number;
  rowsDropped: number;
  months: MonthMovement[];
  counts: Record<Severity, number>;
  findings: LedgerMaskedFinding[];
}

/**
 * tb_dep3cd_review's result: the Winman clause-18 rows (additions and
 * deletions) with masked ledger names, block text clear (a Winman constant),
 * dates in display form, plus totals and findings. The raw rows live in the
 * session cache (`dep3cdRows`) for the writer.
 */
export interface Dep3cdReviewResult {
  company?: string;
  fromDate: string;
  toDate: string;
  counts: Record<Severity, number>;
  blockSource: "workbook" | "template" | "default";
  additions: Array<{
    ledger: string;
    block: string | null;
    purchaseDate: string;
    putToUse: string;
    amount: number;
    secondHalf: boolean;
    parts: number;
    orphan: boolean;
  }>;
  deletions: Array<{
    ledger: string;
    block: string | null;
    date: string;
    amount: number;
    basis: string;
    halfAdd: string;
    bookCredit: number;
  }>;
  totals: {
    additions: number;
    deletions: number;
    unwrittenAdditions: number;
    unwrittenDeletions: number;
  };
  findings: Array<{
    id: string;
    check: D3cdCheckId;
    severity: Severity;
    ledger: string;
    amount: number;
    detail: string;
  }>;
}

export interface Session {
  review(company: string | undefined, asOnDate: string): Promise<ReviewResult>;
  ledgerActivity(findingId: string, fromDate: string, toDate: string): Promise<unknown[]>;
  /** Single-ledger scrutiny (M3), by finding id only — never by ledger name. */
  ledgerScrutiny(findingId: string, fromDate: string, toDate: string): Promise<LedgerScrutinyResult>;
  listCompanies(): Promise<string[]>;
  /** Aggregate GST liability per tax head. No party data crosses back. */
  gstSummary(company: string | undefined, fromDate: string, toDate: string): Promise<GstSummaryView>;
  /** Books-vs-returns join on real GSTINs in code; masked findings out. */
  gstMismatch(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    returnsText: string,
  ): Promise<GstMismatchResult>;
  /**
   * TDS compliance review (FY 25-26 law of record in src/tds-law.ts). The
   * operator data arrives already parsed — `src/index.ts` reads the file
   * (path only, never its contents over the wire) by channel: the legacy
   * JSON file, the generated fillable template, and the optional Winman
   * TDS-summary export (§8.4's merge).
   */
  tdsReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    asOnDate: string,
    operator: OperatorFile,
    operatorSource: "json" | "template",
    winman?: WinmanFacts,
    dayBook?: DayBookInput,
  ): Promise<TdsReviewResult>;
  /**
   * Income Tax Act depreciation per block of assets (design of record:
   * docs/design/2026-09-16-depreciation-verification-design.md), over a
   * two-pass Tally fetch. The operator file travels by path only; its text
   * is read inside the gateway.
   */
  depreciationReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    operatorText: string | null,
  ): Promise<DepReviewResult>;
  /**
   * Fixed asset purchase & sale register (audit artifact). Fetches EVERY
   * asset ledger month-chunked — an audit register must be complete, so
   * there is deliberately no residual skip — plus the incidental-pattern
   * expense ledgers and the disposal-signal ledgers.
   */
  faRegister(company: string | undefined, fromDate: string, toDate: string): Promise<FaReviewResult>;
  /**
   * TRACES Form 26AS reconciliation (design of record:
   * docs/design/2026-09-22-form-26as-reconciliation-design.md). The operator
   * export arrives already parsed (path-only channel at the tool layer); the
   * operator party map is read inside the gateway by path. The books come
   * from a day-book file when one is given, else from the live Tally read
   * with the connector's attached voucher composition (2026-09-29) — the
   * live path attributes a deduction by the same rules, never by the report's
   * single display counterparty.
   */
  as26Review(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    file: As26File,
    as26MapPath: string,
    dayBook?: DayBookInput,
  ): Promise<As26ReviewResult>;
     /**
   * The company's ledger master names, for the 26AS mapping template's
   * dropdown/reference list. Degrades to [] (with a warning) when masters are
   * unavailable — the template is still useful without a list.
   */
  ledgerNames(company: string | undefined): Promise<string[]>;
  /**
   * Addendum 2 (2026-09-26): ledger master pairs + groups for the loans
   * template's Exempt-column pre-fill. Degrades to empty lists (with a
   * warning) when masters are unavailable.
   */
  ledgerPairs(
    company: string | undefined,
  ): Promise<{ ledgers: { name: string; parent: string }[]; groups: { name: string; parent: string }[] }>;
  /**
   * Winman Form 3CD clause 20(b) (design of record: docs/design/2026-09-23-
   * winman-3cd-pf-esi-design.md). The operator challan template arrives
   * already parsed (path-only channel at the tool layer); the books come
   * from the operator day book when given (Q3: the primary source) or live
   * Tally, never both — the day-book path makes no downstream call. The
   * Winman writer takes its rows from the cached review.
   */
  pfEsiReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    operator: OperatorPfEsi;
    dayBook?: DayBookInput;
    /** Fund payable ledger names per fund; replaces the heuristic for that fund (Q4). */
    pfOverrides?: Partial<FundLedgers>;
  }): Promise<PfEsiReviewResult>;
  /**
   * Rewrite the `P.F.` and `E.S.I.` sheets of a Winman 3CD workbook COPY from
   * the cached review's rows and return the written path. The source is
   * never written to.
   */
  write3cdPfEsi(opts: { sourcePath: string; outPath?: string }): Promise<string>;
  /**
   * Rewrite the seven clause-31/269ST sheets of a Winman 3CD workbook COPY
   * from the cached loans review's raw rows (write3cdPfEsi mechanics). Only
   * non-empty sheets are written; the source is never written to.
   */
  write3cdLoans(opts: { sourcePath: string; outPath?: string }): Promise<{ written: string }>;
  /**
   * Rewrite the `Depreciation additions` and `Depreciation deletions` sheets of
   * a Winman 3CD workbook COPY from the cached clause-18 rows. Blocked rows are
   * skipped; the source is never written to.
   */
  write3cdDepreciation(opts: { sourcePath: string; outPath?: string }): Promise<{
    written: string;
    additions: number;
    deletions: number;
    skipped: number;
    notes: string[];
  }>;
  /**
   * Write the four clause 21(b) sheets ("40(a)(ia) to resident",
   * "40(a)(i) to non-resident", "40(a)(ib) - Equalisation Levy", "40(a)(iii)")
   * of a Winman 3CD No-TDS workbook COPY from the cached noTdsReview rows and
   * return the written path, the source never written to.
   */
  write3cdNoTds(opts: { sourcePath: string; outPath?: string }): Promise<{
    path: string;
    rowsBySheet: Record<NotdsSheetKey, number>;
  }>;
  /**
   * Rewrite the five TDS/TCS clause-34 sheets (TDS, TCS, Return details,
   * Interest on TDS, Interest on TCS) of a Winman 3CD workbook COPY from the
   * cached review's rows and return the written path. The source is never
   * written to.
   */
  write3cdTdsTcs(opts: { sourcePath: string; outPath?: string }): Promise<string>;
  /**
   * The cached clause-34 slice from the last tdsReview — raw names, dates
   * and TAN, for this session's Winman writer only; the review result gains
   * only a counts-and-amounts preview.
   */
  tds3cdResult(): Tds3cdResult | undefined;
  /**
   * Clause 21(b) (No TDS Disallowance): merges the books candidates from the
   * cached tb_tds_review run with the operator decisions workbook (path-only
   * channel at the tool layer) into masked review output. Requires a cached
   * TDS review; caches the unmasked NoTdsRow[] for the Winman writer.
   */
  noTdsReview(input: { templatePath?: string; operator?: NotdsOperatorFile }): Promise<NoTdsReviewResult>;
  /**
   * The cached clause 21(b) rows from the last noTdsReview — unmasked, real
   * names and PANs, raw dates. The Winman writer (Task 8) consumes them.
   */
  notdsRows(): NoTdsRow[] | undefined;
  /**
   * The clause 21(b) books candidates from the cached tb_tds_review, before
   * any operator decisions — the seed of the fillable No-TDS template
   * (tb_write_notds_template). Undefined before a TDS review has run.
   */
  notdsCandidates(): NoTdsCandidateRow[] | undefined;
  /**
   * The cached clause 20(b) rows from the last pfEsiReview, with raw dates —
   * the report writer (tb_write_pf_esi_report) consumes them unchanged; the
   * review result's own rows are display-formatted for the model.
   */
  pfEsiRows(): Clause20bRow[] | undefined;
  /**
   * Winman 3CD clause 31 (l.269SS/l.269T) and l.269ST. The books come from
   * the operator day-book export by path (primary: the day-book path makes
   * no downstream call) or live Tally; no day book means live is REQUIRED —
   * the PF/ESI degradation is mirrored (live is awaited and a live fetch
   * failure throws), never a silent empty run. mastersSource "absent"
   * arises only from a day-book bundle that carries no ledger masters: the
   * run still proceeds over the bundle's vouchers.
   * The filled operator template travels by path only; the operator
   * overrides (parties' PAN/mode, declared specified sums) flow into the
   * review inside the gateway.
   */
  loansReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBookPath?: string;
    templatePath?: string;
    overridesPath?: string;
  }): Promise<LoansReviewResult>;
  /**
   * The cached clause-31/269ST per-sheet rows (sheets 1..7) with REAL names,
   * raw PANs and raw YYYYMMDD dates, plus the vault snapshot of the last
   * loansReview — write3cdLoans (Task 7) consumes them unchanged.
   */
  loansRows():
    | {
        sheets: Record<LoansSheetName, LoansSheetRow[]>;
        vault: Array<{ real: string; alias: string }>;
      }
    | undefined;
  /**
   * Winman Form 3CD clause 44 — break-up of total expenditure into GST
   * categories (design of record: docs/design/2026-09-24-gst-44-clause-44-
   * design.md). The operator GST Status template arrives already parsed
   * (path-only channel at the tool layer); the books come from the operator
   * day book when given, else live Tally. The narrow M2 tax-ID channel
   * (ledgersTax) is called live even beside a day book — Decision 2; a hard
   * error when nothing can evidence a supplier's GST status and uncovered
   * spend exists (Decision 1.3: never fabricate a break-up).
   */
  gst44Review(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    operator: OperatorGst44;
    dayBook?: DayBookInput;
  }): Promise<Gst44ReviewResult>;
  /**
   * The cached clause 44 rows from the last gst44Review, raw — the Winman
   * writer consumes them unchanged; the review result's own rows are
   * display-shaped for the model.
   */
  gst44Rows(): Gst44Row[] | undefined;
  /**
   * Rewrite the `Break-up of GST expenditure` sheet of a Winman 3CD workbook
   * COPY and return the written path. The source is never written to. With
   * `worksheetPath` the totals come from the operator's approved GST
   * nature-wise break-up working sheet; otherwise from the cached review rows.
   */
  write3cdGst44(opts: { sourcePath: string; outPath?: string; worksheetPath?: string }): Promise<string>;
  /**
   * The GST nature-wise break-up WORKING SHEET (captain's addendum
   * 2026-09-26, Phase B): per-ledger REVENUE/CAPITAL rows seeded from the
   * treatment vocabulary, the prior-year working sheet and party GSTIN
   * evidence, written as a new workbook the operator reviews and edits
   * before any Winman write. The day book is required (file channel);
   * GSTINs come from the bundle's masters, live ledgersTax filling gaps.
   */
  writeGstWorksheet(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBook: DayBookInput;
    /** Raw bytes of the prior-year break-up workbook, when the operator supplied one. */
    priorYear?: Buffer;
    rulesPath?: string;
    outPath: string;
  }): Promise<GstWorksheetWriteResult>;
  /**
   * Winman Form 3CD clause 18 (depreciation under the Income-tax Act) books
   * side: additions and deletions from the operator day book, one row per
   * asset, at actual consideration for disposals. Day book only (no live
   * fallback); the optional template supplies block mappings and adjustments.
   */
  dep3cdReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBookPath: string;
    templatePath?: string;
    sourcePath?: string;
  }): Promise<Dep3cdReviewResult>;
  /** The cached raw clause-18 rows (real names, YYYYMMDD dates) plus the block lists write3cdDepreciation consumes. */
  dep3cdRows():
    | {
        additions: Dep3cdAddition[];
        deletions: Dep3cdDeletion[];
        blockLists: { additions: readonly string[]; deletions: readonly string[] };
      }
    | undefined;
  vault: Vault;
}

export function createSession(
  d: Downstream,
  overrides: Overrides,
  wrongGroup: WrongGroupConfig = EMPTY_WRONG_GROUP,
): Session {
  const vault = createVault();
  /** finding id -> real ledger name, for drill-down without the model holding it. */
  const realLedgerByFinding = new Map<string, string>();
  const groupOfLedger = new Map<string, string>();
  let classifier: Classifier | undefined;
  let lastCompany: string | undefined;
  let lastGst: GstMismatchResult | undefined;
  let lastTds: TdsReviewResult | undefined;
  let lastAs26: As26ReviewResult | undefined;
  /** Paperback of the review: unmasked clause 20(b) rows for the Winman writer. */
  let lastPfEsi: Clause20bRow[] | undefined;
  /** Paperback of the loans review: raw unmasked per-sheet rows + vault map (write3cdLoans, Task 7). */
  let lastLoansSheets: Record<LoansSheetName, LoansSheetRow[]> | undefined;
  let lastLoansVault: Array<{ real: string; alias: string }> | undefined;
  /** Unmasked clause 44 rows from the last gst44Review, for the Winman writer. */
  let lastGst44: Gst44Row[] | undefined;
  /** Clause-34 paperback: the raw Tds3cdResult the Winman writer consumes. */
  let lastTds3cd: Tds3cdResult | undefined;
  /**
   * True when a Winman TDS summary was supplied but carried no Deductor name
   * (2026-09-26r inbox 065). The review itself stays usable (the in-memory
   * result falls back to the Tally company name), but writing the 3CD sheets
   * refuses rather than silently stamping the Tally name on the return.
   */
  let lastWinmanNameMissing = false;
  /** Paperback of the clause-18 review: raw rows + block lists for write3cdDepreciation. */
  let lastDep3cd:
    | {
        additions: Dep3cdAddition[];
        deletions: Dep3cdDeletion[];
        blockLists: { additions: readonly string[]; deletions: readonly string[] };
      }
    | undefined;
  /** The books facts tb_tds_review cached for the clause 21(b) merge (unmasked, session-only). */
  let lastTdsBooks: TdsBooksCache | undefined;
  /** The private vellum of the clause 21(b) review: unmasked NoTdsRow[] for the Winman writer. */
  let lastNoTds: NoTdsRow[] | undefined;
  /** canonical ledger key -> session-stable scrutiny sequence (LS-<seq>-..., scrutinyId L<seq>). */
  const ledgerSeqByKey = new Map<string, number>();

  async function review(
    company: string | undefined,
    asOnDate: string,
  ): Promise<ReviewResult> {
    lastCompany = company;
    const [tb, groups, ledgers] = await Promise.all([
      d.trialBalance(company, asOnDate),
      d.groups(company),
      d.ledgers(company),
    ]);

    const currentClassifier = buildClassifier(groups, overrides);
    classifier = currentClassifier;
    for (const l of ledgers) groupOfLedger.set(canonicalKey(l.name), l.parent);
    for (const r of tb.rows) groupOfLedger.set(canonicalKey(r.name), r.parent);

    const raw = runChecks({
      asOnDate,
      rows: tb.rows,
      ledgers,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      roleOf: (g) => currentClassifier.role(g),
      isPrimaryGroup: (g) => currentClassifier.isPrimaryGroup(g),
      ancestryOf: (g) => currentClassifier.ancestry(g),
      wrongGroup,
    });

    const findings = raw.map((f) => {
      if (f.ledger) realLedgerByFinding.set(f.id, f.ledger);
      return maskFinding(f, currentClassifier, vault);
    });

    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    return {
      asOnDate,
      company,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: Math.abs(tb.totalDebit - tb.totalCredit) <= TOTALS_TOLERANCE,
      counts,
      findings,
    };
  }

  async function ledgerActivity(
    findingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]> {
    const real = realLedgerByFinding.get(findingId);
    if (!real) throw new Error(`unknown finding id: ${findingId}`);
    if (!classifier) throw new Error("run tb_review first: the group tree is not loaded");
    const rows = await d.ledgerVouchers(lastCompany, real, fromDate, toDate);
    return rows.map((row) => maskVoucherRow(row, classifier!, vault, groupOfLedger));
  }

  async function ledgerScrutiny(
    findingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<LedgerScrutinyResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    const real = realLedgerByFinding.get(findingId);
    if (!real) throw new Error(`unknown finding id: ${findingId}`);
    if (!classifier) throw new Error("run tb_review first: the group tree is not loaded");
    const c = classifier;
    const company = lastCompany;
    const key = canonicalKey(real);

    // Opening = the trial balance as on the day before the period, closing =
    // as on its last day: tally_trial_balance is date-bounded and positive =
    // debit, unlike the ledger master's CLOSINGBALANCE (see AGENTS.md).
    const [masters, openingTb, closingTb, fetched] = await Promise.all([
      d.ledgersTax(company),
      d.trialBalance(company, dayBefore(fromDate)),
      d.trialBalance(company, toDate),
      d.ledgerVoucherRows(company, real, fromDate, toDate),
    ]);
    for (const l of masters) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const balanceOn = (rows: TbRow[]): number =>
      rows.find((r) => canonicalKey(r.name) === key)?.balance ?? 0;
    const group = groupOfLedger.get(key) ?? "";
    const gstin = masters.find((l) => canonicalKey(l.name) === key)?.gstin ?? null;

    let seq = ledgerSeqByKey.get(key);
    if (seq === undefined) {
      seq = ledgerSeqByKey.size + 1;
      ledgerSeqByKey.set(key, seq);
    }

    const { view, findings: raw } = scrutinize({
      ledger: real,
      group,
      role: c.role(group),
      gstin,
      ledgerSeq: seq,
      fromDate,
      toDate,
      opening: balanceOn(openingTb.rows),
      closing: balanceOn(closingTb.rows),
      rows: fetched.rows,
    });

    // Vault first (the ledger, its GSTIN as TaxId N, every counterparty a
    // detail names), then sweep: maskKnownNames substitutes every vaulted
    // real string, and scrubSecrets still stands behind it. This is the M2
    // tax-ID channel pattern, unchanged.
    const ledger = maskLedgerName(real, group, c, vault);
    if (gstin) vault.pseudonym(gstin, "tax_id");
    const findings: LedgerMaskedFinding[] = raw.map((f) => {
      // LS ids drill down like TB and GST ids: tb_ledger_activity and a
      // re-scrutiny over another period both accept them.
      realLedgerByFinding.set(f.id, real);
      for (const cp of f.counterparties) {
        maskLedgerName(cp, groupOfLedger.get(canonicalKey(cp)) ?? "", c, vault);
      }
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger,
        group: scrubSecrets(f.group),
        amount: f.amount,
        side: f.side,
        expected: f.expected,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    return {
      scrutinyId: `L${seq}`,
      findingId,
      company,
      ledger,
      group: scrubSecrets(group),
      role: c.role(group),
      fromDate,
      toDate,
      registeredForGst: gstin !== null,
      opening: view.opening,
      closing: view.closing,
      totalDebit: view.totalDebit,
      totalCredit: view.totalCredit,
      netMovement: view.netMovement,
      rowsScanned: view.rowsScanned,
      rowsDropped: fetched.dropped,
      months: view.months,
      counts,
      findings,
    };
  }

  /**
   * GST analysis context, rebuilt per call (M1 behaviour; no gateway-side
   * cache — the downstream's 5-minute fetch cache carries repeat calls).
   * GSTINs stay in gateway memory: they leave only as vault aliases.
   */
  async function gstAnalysis(
    company: string | undefined,
    fromDate: string,
    toDate: string,
  ): Promise<{
    books: GstBooks;
    classifier: Classifier;
    /** Canonical ledger name -> its parent group, for masking policy. */
    ledgerGroupOf: Map<string, string>;
  }> {
    lastCompany = company;
    const [groups, ledgers, vouchers] = await Promise.all([
      d.groups(company),
      d.ledgersTax(company),
      d.vouchers(company, fromDate, toDate),
    ]);
    const c = buildClassifier(groups, overrides);

    // The shared ledger->group map serves the tb_ledger_activity drill-down
    // into GST finding ids, so GST analysis feeds it exactly like tb_review.
    for (const l of ledgers) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const ledgerGroupOf = groupOfLedger;
    const gstinOf = new Map<string, string>();
    for (const l of ledgers) {
      if (l.gstin && !gstinOf.has(canonicalKey(l.name))) gstinOf.set(canonicalKey(l.name), l.gstin);
    }
    const ctx: GstCtx = {
      groupOf: (ledger) => ledgerGroupOf.get(canonicalKey(ledger)) ?? "",
      rootOf: (group) => c.rootOf(group),
      roleOf: (group) => c.role(group),
      inDutiesAndTaxes: (group) =>
        c.ancestry(group).some((g) => canonicalKey(g) === "duties & taxes"),
      gstinOf: (ledger) => gstinOf.get(canonicalKey(ledger)) ?? null,
    };
    const books = gstBooks(vouchers, ctx);
    // The classifier matters beyond this call: tb_ledger_activity drills into
    // GST findings by finding id, and that drill-down masks rows with the
    // last-built classifier, exactly as it does for tb_review findings.
    classifier = c;
    return { books, classifier: c, ledgerGroupOf };
  }

  /**
   * Month chunks over the fiscal period: the one server-side date filter the
   * live company tolerates — the Day Book is never the input path (design
   * doc §5). Yields [chunkFrom, chunkTo] in YYYYMMDD.
   */
  function monthChunks(fromDate: string, toDate: string): Array<[string, string]> {
    const chunks: Array<[string, string]> = [];
    const pad = (n: number) => String(n).padStart(2, "0");
    let y = Number(fromDate.slice(0, 4));
    let m = Number(fromDate.slice(4, 6));
    while (true) {
      const start = `${y}${pad(m)}01`;
      const endOfMonth = `${y}${pad(m)}${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
      chunks.push([start <= fromDate ? fromDate : start, endOfMonth >= toDate ? toDate : endOfMonth]);
      if (endOfMonth >= toDate) return chunks;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  const fetchLedgerRows = async (
    company: string | undefined,
    ledgers: string[],
    fromDate: string,
    toDate: string,
    opts?: { includeEntries?: boolean },
  ): Promise<{ rows: Map<string, LedgerVoucherRow[]>; calls: number; entriesCapable: boolean }> => {
    const rows = new Map<string, LedgerVoucherRow[]>();
    let calls = 0;
    // Whether any fetch's envelope reported the connector's own entriesAttached
    // count: a build older than includeEntries ignores the flag and answers
    // without the field, which is how the live 26AS path names the real fault.
    let entriesCapable = false;
    for (const ledger of ledgers) {
      for (const [f, t] of monthChunks(fromDate, toDate)) {
        const fetched = await d.ledgerVoucherRows(company, ledger, f, t, opts);
        if (fetched.entriesAttached !== undefined) entriesCapable = true;
        calls += 1;
        const list = rows.get(canonicalKey(ledger)) ?? [];
        list.push(...fetched.rows);
        rows.set(canonicalKey(ledger), list);
      }
    }
    return { rows, calls, entriesCapable };
  };

  /** Voucher-row groups keyed by the queried (real) ledger, engine-ready. */
  const rowsByLedger = (rows: Map<string, LedgerVoucherRow[]>, ledger: string): LedgerVoucherRow[] =>
    rows.get(canonicalKey(ledger)) ?? [];

  const asTdsLedgerRows = (
    rows: Map<string, LedgerVoucherRow[]>,
    ledgers: string[],
  ): TdsLedgerRows[] =>
    ledgers.map((ledger) => ({ ledger: canonicalKey(ledger), rows: rowsByLedger(rows, ledger) }));

  /**
   * 26AS reconciliation (design: docs/design/2026-09-22-form-26as-
   * reconciliation-design.md). Masters fail soft — the mapping still runs
   * against counterparty names — but a live run whose masters do not name a
   * TDS/TCS receivable ledger under an asset group is the operator's setup
   * error, thrown hard (never a silent zero).
   *
   * The books come from a day-book bundle when one is passed, else from live
   * Tally: the live branch asks `tally_get_ledger_vouchers` for the attached
   * voucher composition (`includeEntries`) and rebuilds day-book-shaped
   * vouchers from it (`vouchersFromLedgerRows`, src/as26.ts), so both paths
   * attribute deductions by `projectLedgerRows` +
   * `rekeyDeductionsToDeductor` and never by the report's display
   * counterparty. A row the connector could not join without guessing is
   * counted, never guessed (`AS26-012`); a run where NO row could be joined
   * is refused (`AS26_LIVE_ENTRIES_UNAVAILABLE`).
   */
  async function as26Review(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    file: As26File,
    as26MapPath: string,
    dayBook?: DayBookInput,
  ): Promise<As26ReviewResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;

    let groups: Array<{ name: string; parent: string }> = [];
    let masterPairs: Array<{ name: string; parent: string }> = [];
    let masters: LedgerTaxInfo[] = [];
    let mastersUnavailable = false;
    let groupsUnavailable = false;
    let voucherList: VoucherRow[];

    if (dayBook) {
      voucherList = dayBook.vouchers;
      groups = dayBook.groups ?? [];
      // bundle masters have no gstin/pan — 26AS needs only name+parent
      masterPairs = dayBook.ledgers ?? [];
    } else {
      // Live: masters and the day-book-shaped voucher walk come from Tally
      // itself. `tally_get_vouchers` is what carries the vouchers for the
      // sales / other-income / bank sides; the deduction side needs no
      // guessing of its own below.
      const [g, m, v] = await Promise.all([
        d.groups(company).catch(() => null),
        d.ledgersTax(company).catch(() => null),
        d.vouchers(company, fromDate, toDate),
      ]);
      voucherList = v;
      if (g === null) {
        groupsUnavailable = true;
        console.error("tally-agent: group tree unavailable — 26AS masking falls back to master-less policy");
      } else {
        groups = g;
      }
      if (m === null) {
        mastersUnavailable = true;
        console.error("tally-agent: ledger masters unavailable — the 26AS mapping runs against counterparty names only");
      } else {
        masters = m;
        masterPairs = m.map((l) => ({ name: l.name, parent: l.parent }));
      }
    }
    for (const l of masterPairs) groupOfLedger.set(canonicalKey(l.name), l.parent);

    const mastersGstinOf = new Map<string, string>();
    if (!dayBook) {
      for (const m of masters ?? []) {
        if (m.gstin) mastersGstinOf.set(canonicalKey(m.name), m.gstin);
      }
    }
    const c = buildClassifier(groups, overrides);
    classifier = c;
    const ledgerGroupOf = groupOfLedger;
    const ctx: GstCtx = {
      groupOf: (ledger) => ledgerGroupOf.get(canonicalKey(ledger)) ?? "",
      rootOf: (group) => c.rootOf(group),
      roleOf: (group) => c.role(group),
      inDutiesAndTaxes: (group) =>
        c.ancestry(group).some((g) => canonicalKey(g) === "duties & taxes"),
      gstinOf: (ledger) => mastersGstinOf.get(canonicalKey(ledger)) ?? null,
    };

    const map = loadAs26MapFile(as26MapPath, (why) => console.error(`tally-agent: ${why}`));
    const assetRoots = new Set(["current assets", "fixed assets", "misc. expenses (asset)"]);
    const isAssetRoot = (group: string): boolean => assetRoots.has(canonicalKey(group));
    // The parent chain reaches an asset root only when the group tree is
    // walked too: a ledger's immediate parent can be a group, not a root.
    const ancestry = [...masterPairs, ...groups];
    const mastersAbsent = mastersUnavailable || masterPairs.length === 0;
    // The operator's explicit credit (receivable) ledger list wins PER KIND:
    // real books park such a ledger under Loans & Advances with no
    // "receivable" in the name, which the heuristic below cannot see. A kind
    // the operator declared nothing for still runs the heuristic unchanged —
    // declaring the year-scoped TDS ledger must not silently drop a TCS
    // ledger the rule already finds.
    const declared = declaredCreditLedgers(map);
    const receivable: Array<{ name: string; kind: As26Kind }> = [];
    const creditLedgerSource: Record<As26Kind, "map" | "heuristic"> = {
      tds: "heuristic",
      tcs: "heuristic",
    };
    if (declared.length > 0) {
      if (!mastersAbsent) {
        const known = new Set(masterPairs.map((l) => canonicalKey(l.name)));
        const unknown = declared.filter((d) => !known.has(canonicalKey(d.ledger)));
        if (unknown.length > 0) {
          throw new Error(
            `as26-map: the Credit Ledgers sheet names ${unknown.length} ledger(s) that do not exist in ` +
              `${company ?? "this company"}'s books — the TDS/TCS credit ledger(s) are the asset ledgers a customer ` +
              "debits when it deducts tax. Fix the name on that sheet, or clear that kind's rows to fall " +
              "back to the TDS/TCS Receivable name rule for it.",
          );
        }
      } else {
        console.error(
          "tally-agent: ledger masters unavailable — the Credit Ledgers sheet's names are taken on trust, unverified",
        );
      }
      for (const d of declared) {
        receivable.push({ name: d.ledger, kind: d.kind });
        creditLedgerSource[d.kind] = "map";
      }
    }
    // Every kind the operator did not declare still gets the name rule — and
    // only its own kinds, so a declared ledger is never re-found by the rule.
    const undeclaredKinds = (["tds", "tcs"] as const).filter(
      (k) => creditLedgerSource[k] === "heuristic" && declared.every((d) => d.kind !== k),
    );
    if (undeclaredKinds.length > 0) {
      let heuristic = receivableLedgers(ancestry, isAssetRoot);
      if (heuristic.length === 0 && mastersAbsent) {
        // Masters absent: the same name heuristic applied to every ledger the
        // period's vouchers themselves touch — the books carry the evidence.
        const names = new Set<string>();
        for (const v of voucherList) {
          if (v.cancelled) continue;
          for (const e of v.entries) names.add(e.ledger);
        }
        heuristic = [...names]
          .filter((n) => /(?:tds|tcs)/.test(canonicalKey(n)) && /receivable/i.test(n))
          .map((n) => ({
            name: n,
            kind: (/tcs/.test(canonicalKey(n)) ? "tcs" : "tds") as As26Kind,
          }));
      }
      receivable.push(
        ...heuristic.filter((h) => (undeclaredKinds as readonly string[]).includes(h.kind)),
      );
      // The hard error belongs to the all-heuristic run only: a run that took
      // at least one declared ledger is verified against the masters, and a
      // company that books no TCS at all must not be told to name one.
      if (receivable.length === 0 && declared.length === 0 && !mastersAbsent) {
        throw new Error(
          "no TDS/TCS receivable ledger found under an asset group — name the ledger 'TDS Receivable' (or 'TCS Receivable'), list it on the mapping template's Credit Ledgers sheet, or extend the rule in src/as26.ts",
        );
      }
    }

    const deductions: BooksDeduction[] = [];
    let credits = 0;
    // Rows the live read could not join to a voucher: reported, never guessed.
    let unattached: Array<{ date: string; amount: number }> = [];
    if (receivable.length > 0) {
      let rows: Map<string, LedgerVoucherRow[]>;
      // The vouchers the deductions are attributed from: the day-book bundle
      // itself, or the live read's attached composition rebuilt into the same
      // shape. Every attribution below reads these, never a report row's
      // display counterparty.
      let deductionVouchers: VoucherRow[] = voucherList;
      if (dayBook) {
        rows = new Map(
          projectLedgerRows(voucherList, receivable.map((r) => r.name), {
            // A retention-release journal's mirrored retention⇄warranty pair
            // is the largest opposite-sign line of the tax row, so the plain
            // rule named the warranty ledger and the deduction never reached
            // the deductor (2026-09-29).
            skipMirroredPairs: true,
          }).map((r) => [canonicalKey(r.ledger), r.rows]),
        );
      } else {
        // Live: the same month-chunked read, with the composition attached.
        const fetched = await fetchLedgerRows(
          company,
          receivable.map((r) => r.name),
          fromDate,
          toDate,
          { includeEntries: true },
        );
        const attached = vouchersFromLedgerRows([...fetched.rows.values()].flat());
        if (attached.vouchers.length === 0 && attached.unattached.length > 0) {
          // Not one row could be joined without guessing: a books side built
          // from the display counterparty would be the misattribution the
          // 2026-09-29 guard existed to prevent. Refuse rather than present it.
          // A build that never reports the field is a different fault (stale
          // connector) and says so, because the operator's fix differs.
          throw new Error(
            fetched.entriesCapable
              ? AS26_LIVE_ENTRIES_UNAVAILABLE
              : AS26_LIVE_ENTRIES_UNSUPPORTED,
          );
        }
        unattached = attached.unattached;
        deductionVouchers = attached.vouchers;
        rows = new Map(
          projectLedgerRows(attached.vouchers, receivable.map((r) => r.name), {
            skipMirroredPairs: true,
          }).map((r) => [canonicalKey(r.ledger), r.rows]),
        );
      }
      for (const r of receivable) {
        const ev = deductionEvents(rowsByLedger(rows, r.name), r.kind);
        deductions.push(...ev.events);
        credits += ev.credits;
      }
      // Addendum 9: a gross-up journal's TDS debit displays against the
      // income ledger, so its event keys to income and can never join the
      // deductor's party. Re-key to the voucher's party line wherever the
      // counterparty is not a party ledger and the party line is one. A party
      // ledger is one parked under Sundry Debtors/Creditors — not merely any
      // asset. 2026-09-29: the operator's mapped deductors, so a retention
      // bucket standing in as the voucher's party line cannot win over the
      // real deductor sitting on the same voucher. Since the live read
      // rebuilds day-book-shaped vouchers from the attached composition, this
      // runs identically on both paths — the retention-release journal now
      // reaches its deductor live too.
      const parentOfDed = new Map<string, string>();
      for (const l of masterPairs) parentOfDed.set(canonicalKey(l.name), l.parent);
      for (const g of groups) parentOfDed.set(canonicalKey(g.name), g.parent);
      const PARTY_ROOTS = new Set(["sundry debtors", "sundry creditors"]);
      const isPartyLedger = (name: string): boolean => {
        let p: string | undefined = parentOfDed.get(canonicalKey(name));
        const seen = new Set<string>();
        while (p && !seen.has(p)) {
          seen.add(p);
          if (PARTY_ROOTS.has(canonicalKey(p))) return true;
          p = parentOfDed.get(canonicalKey(p));
        }
        return false;
      };
      const mappedDeductorKeys = new Set(map.mappings.map((m) => canonicalKey(m.ledger)));
      const isMappedDeductor = (name: string): boolean =>
        mappedDeductorKeys.has(canonicalKey(name));
      const rekeyed = rekeyDeductionsToDeductor(deductions, deductionVouchers, isPartyLedger, isMappedDeductor);
      if (rekeyed) {
        deductions.length = 0;
        deductions.push(...rekeyed);
      }
    }

    const sales = booksSales(voucherList, ctx);
    let ledgerNames = masterPairs.map((l) => l.name);
    if (ledgerNames.length === 0) {
      // Masters unavailable: the operator map still joins against every
      // counterparty the books themselves carried in the period (R-D-2).
      const names = new Set<string>();
      for (const dd of deductions) names.add(dd.ledgerKey);
      for (const ss of sales) names.add(ss.ledgerKey);
      ledgerNames = [...names];
    }

    // Addendum 3: FD ledgers are auto-detected, not hand-mapped — candidates
    // sit under a Deposits (Asset) group AND carry an FD token in the name.
    // Explicit Bank Interest FD rows win. Assignment order: a distinctive
    // name token/short form of exactly one listed bank, else the single
    // listed bank, else unassigned (one review finding).
    let fdAuto: { rows: FdAssignment[]; unassigned: string[]; interest: number } = {
      rows: [], unassigned: [], interest: 0,
    };
    if (masterPairs.length > 0) {
      const fdParentOf = new Map<string, string>();
      for (const l of masterPairs) fdParentOf.set(canonicalKey(l.name), l.parent);
      for (const g of groups) fdParentOf.set(canonicalKey(g.name), g.parent);
      const underDepositsAsset = (name: string): boolean => {
        const seen = new Set<string>();
        let p: string | undefined = fdParentOf.get(canonicalKey(name));
        while (p && !seen.has(p)) {
          seen.add(p);
          if (canonicalKey(p) === "deposits (asset)") return true;
          p = fdParentOf.get(canonicalKey(p));
        }
        return false;
      };
      const claimed = new Set(
        (map.banks ?? []).flatMap((b) => [...b.interestLedgers, ...b.fdLedgers]).map(canonicalKey),
      );
      const fdCandidates = masterPairs
        .filter((l) => !claimed.has(canonicalKey(l.name)) && underDepositsAsset(l.name) && isFdLedgerName(l.name))
        .map((l) => l.name);
      const banksListed = (map.banks ?? []).map((b) => b.as26Name);
      const fdAssign = assignFdLedgers(fdCandidates, banksListed);
      for (const a of fdAssign) {
        if (!a.bank || !a.rule) continue;
        const bankName = a.bank;
        const b = (map.banks ?? []).find((x) => canonicalKey(x.as26Name) === canonicalKey(bankName));
        if (b && !b.fdLedgers.some((l) => canonicalKey(l) === canonicalKey(a.ledger))) b.fdLedgers.push(a.ledger);
      }
      const unassignedFd = fdAssign.filter((a) => !a.bank);
      let fdInterest = 0;
      if (unassignedFd.length > 0) {
        const unKeys = new Set(unassignedFd.map((a) => canonicalKey(a.ledger)));
        for (const v of voucherList) {
          if (v.cancelled) continue;
          for (const e of v.entries) {
            if (unKeys.has(canonicalKey(e.ledger)) && e.amount < 0) fdInterest += -e.amount;
          }
        }
      }
      fdAuto = {
        rows: fdAssign,
        unassigned: unassignedFd.map((a) => a.ledger),
        interest: round2(fdInterest),
      };
    }
    // Bank-194A books side (design §12.2): the operator's Bank Interest sheet
    // names each bank's interest income and FD ledgers. One event per voucher
    // touching a bank's own ledgers: interest credited on the interest
    // ledgers, FD principal debited, and the TDS credited on a TDS/TCS
    // receivable ledger inside the SAME voucher.
    const receivableKeySet = new Set(receivable.map((r) => canonicalKey(r.name)));
    const bankEvents: BankBooks[] = [];
    for (const b of map.banks ?? []) {
      const ik = new Set(b.interestLedgers.map(canonicalKey));
      const fk = new Set(b.fdLedgers.map(canonicalKey));
      const events: BankBooksEvent[] = [];
      for (const v of voucherList) {
        if (v.cancelled) continue;
        const keys = v.entries.map((e) => canonicalKey(e.ledger));
        // Touched is voucher-wide: the receivable debit can be listed before
        // the bank's own ledger rows in the same voucher.
        let touched = keys.some((k) => ik.has(k) || fk.has(k));
        let interest = 0, tax = 0, fd = 0, fdLedger: string | undefined;
        v.entries.forEach((e, i) => {
          const k = keys[i];
          if (ik.has(k) && e.amount < 0) { interest += -e.amount; }
          else if (fk.has(k) && e.amount > 0) { fd += e.amount; fdLedger ??= e.ledger; }
          else if (receivableKeySet.has(k) && e.amount > 0) {
            // A bank's TDS receivable debit counts when the voucher also
            // carries one of the bank's own ledgers — OR when its display
            // counterparty IS one of them (the month-end interest/TDS posting
            // shows the receivable debit and the interest credit as separate
            // display rows, so the same-voucher test alone reads 0). Inbox 010.
            const cpKey = canonicalKey(counterpartyOf(v, i));
            if (touched || ik.has(cpKey) || fk.has(cpKey)) tax += e.amount;
          }
        });
        if (touched) {
          events.push({
            nameKey: canonicalKey(b.as26Name), date: String(v.date),
            interest: round2(interest), tax: round2(tax), fdDebit: round2(fd),
            fdLedger,
          });
        }
      }
      if (events.length > 0) bankEvents.push({ nameKey: canonicalKey(b.as26Name), events });
    }
    // Addendum 10: an income-side ledger credited in the same voucher that
    // debits a party's TDS receivable belongs to that party's gross basis.
    // Attributed through this run's tds deductions; ledgers already in the
    // bank/FD basis are excluded so no 194A/bank figure moves (inbox 030).
    const partyKeyByVoucher = new Map<string, string>();
    for (const d of deductions) {
      if (d.kind !== "tds") continue;
      partyKeyByVoucher.set(voucherIdentity(d.date, d.voucherType, d.voucherNumber), d.ledgerKey);
    }
    const otherIncomeExclude = new Set(
      [
        ...(map.banks ?? []).flatMap((b) => [...b.interestLedgers, ...b.fdLedgers]),
        ...fdAuto.rows.map((r) => r.ledger),
      ].map(canonicalKey),
    );
    const otherIncome = otherIncomeCredits(voucherList, ctx, partyKeyByVoucher, otherIncomeExclude);
    // The live read's unattached rows, as the engine's AS26-012 fact. The
    // day-book path has no such row (every voucher carries its composition).
    const unattachedFact = unattached.length > 0
      ? {
          count: unattached.length,
          amount: unattached.reduce((s, r) => s + Math.abs(r.amount), 0),
          firstDate: unattached.reduce((d, r) => (r.date < d ? r.date : d), unattached[0].date),
          lastDate: unattached.reduce((d, r) => (r.date > d ? r.date : d), unattached[0].date),
        }
      : undefined;
    const result = analyzeAs26(file, { deductions, sales, otherIncome, bankEvents, fdAuto, unattached: unattachedFact }, map, ledgerNames, { fromDate, toDate });
    // Bill-level drill-down (pure, unmasked): the SAME file instance the
    // session analyzed, so the rows and the findings share one provenance.
    const billRowsEngine = buildBillRows(result, { deductions, sales, bankEvents }, file, { fromDate, toDate });

    // --- masking (R-P-5): parties pseudonym, refs Doc N, totals untouched ---
    const isTallyLedger = new Set(masterPairs.map((l) => canonicalKey(l.name)));
    const ledgerName = (n: string): boolean =>
      isTallyLedger.has(canonicalKey(n)) || ledgerGroupOf.has(canonicalKey(n));
    const pseudoName = (n: string): string => {
      if (!n) return n;
      if (ledgerName(n)) {
        return maskLedgerName(n, ledgerGroupOf.get(canonicalKey(n)) ?? "", c, vault);
      }
      return vault.pseudonym(n, "debtor");
    };
    const DATE_LABEL = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
    const findings: As26Finding[] = result.findings.map((f) => {
      if (isTallyLedger.has(canonicalKey(f.party))) realLedgerByFinding.set(f.id, f.party);
      const schedule = f.schedule?.map((row) => {
        const label = row.label && !DATE_LABEL.test(row.label) && row.label !== "unknown date"
          ? vault.pseudonym(row.label, "doc")
          : row.label;
        return { ...row, label: scrubSecrets(label) };
      });
      return {
        ...f,
        party: pseudoName(f.party),
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
        ...(schedule ? { schedule } : {}),
      };
    });
    // Shared-ledger groups quote every member 26AS name in their finding
    // detail, so vault those names BEFORE the findings sweep runs (below) —
    // an un-vaulted name would reach the model unmasked. Each name keeps its
    // own stable pseudonym, exactly like a party of its own.
    for (const r of result.recon) {
      for (const m of r.match.members ?? []) vault.pseudonym(m.as26Name, "debtor");
    }
    const maskReconMatch = (m: PartyMatch) => {
      // Each ledger keeps its own stable pseudonym (so it matches the rest of
      // the report); the group label joins them, never masks the join as one
      // opaque name.
      const ledgerNames = m.ledgerNames.map(pseudoName);
      return {
        ...m,
        ledgerNames,
        ledgerName: ledgerNames.join(" + "),
        as26Name: vault.pseudonym(m.as26Name, "debtor"),
        // A shared group's member names and their own ledgers are masked
        // element-wise too — the spread above would otherwise carry them out
        // raw inside `members`.
        ...(m.members
          ? {
            members: m.members.map((x) => ({
              ...x,
              as26Name: vault.pseudonym(x.as26Name, "debtor"),
              ledgerNames: x.ledgerNames.map(pseudoName),
            })),
          }
          : {}),
      };
    };
    const REF_MASK = (ref: string | null): string | null =>
      ref && !DATE_LABEL.test(ref) ? vault.pseudonym(ref, "doc") : ref;
    const recon = result.recon.map((r) => ({
      ...r,
      match: maskReconMatch(r.match),
      // 8-digit dates would read "[number]" after scrubDigits — keep the
      // readable form for the tool output and the written Deductors sheet.
      paired: r.paired.map((p) => ({
        books: { ...p.books, date: displayDate(p.books.date) },
        as26: { ...p.as26, date: displayDate(p.as26.date) },
      })),
      combinations: r.combinations.map((c) => ({
        target: { ...c.target, date: displayDate(c.target.date) },
        parts: c.parts.map((p) => ({ ...p, date: displayDate(p.date) })),
        side: c.side,
        basis: c.basis,
        invoiceRef: REF_MASK(c.invoiceRef ?? null),
        invoiceDate: c.invoiceDate ? displayDate(c.invoiceDate) : null,
        invoiceTaxable: c.invoiceTaxable ?? null,
        targetId: c.targetId,
        partIds: c.partIds,
        // Filled in below, once the ledger-key → pseudonym map exists.
        party: undefined as string | undefined,
      })),
      unmatchedBooks: r.unmatchedBooks.map((i) => ({ ...i, date: displayDate(i.date) })),
      unmatchedAs26: r.unmatchedAs26.map((i) => ({ ...i, date: displayDate(i.date) })),
    }));
    const masterByKey = new Map(masterPairs.map((l) => [canonicalKey(l.name), l.name]));
    const pseudoKey = (k: string): string =>
      masterByKey.has(k)
        ? maskLedgerName(masterByKey.get(k)!, ledgerGroupOf.get(k) ?? "", c, vault)
        : vault.pseudonym(k, "debtor");
    const bookEvents = [
      ...deductions.map((e) => ({
        party: pseudoKey(e.ledgerKey), source: "deduction" as const, date: displayDate(e.date),
        tax: e.tax, voucherType: e.voucherType, ref: null as string | null, ledger: null as string | null,
      })),
      ...sales.map((s) => ({
        party: pseudoKey(s.ledgerKey), source: "sale" as const, date: displayDate(s.date),
        tax: s.gross, voucherType: "Sales", ref: REF_MASK(s.ref), ledger: null as string | null,
      })),
      ...result.recon.flatMap((r) =>
        (r.otherIncome ?? []).map((x) => ({
          party: pseudoKey(x.partyKey), source: "other income" as const, date: displayDate(x.date),
          tax: x.amount, voucherType: x.voucherType, ref: REF_MASK(x.voucherNumber), ledger: pseudoName(x.incomeLedger),
        })),
      ),
    ];
    const gaps = result.gaps.map((g) => ({
      ...g,
      ledger: g.ledger ? pseudoName(g.ledger) : undefined,
      name: g.name ? vault.pseudonym(g.name, "debtor") : g.name,
    }));
    const recLedgers = receivable.map((r) =>
      maskLedgerName(r.name, ledgerGroupOf.get(canonicalKey(r.name)) ?? "", c, vault),
    );

    // --- bill rows (masking R-P-5): every row is named by its OWN side
    // (captain 2026-09-29). A booksded row is a books entry, so it shows the
    // ledger that entry is booked on (its own deduction's ledger key, already
    // canonical); an as26/value row is a 26AS entry, so it shows the masked
    // 26AS deductor name. The Deductors sheet is the one place a party-level
    // 26AS name belongs. Findings are labelled the same way, so the row-id
    // pointers below line up. ---
    const ledgerOrder = new Map<string, number>();   // canonical ledger key → recon index (min)
    const partyIndex = new Map<string, number>();    // as26NameKey → recon index
    const as26LabelOf = new Map<string, string>();   // as26NameKey → masked 26AS deductor name
    const ledgerKeysOf = new Map<string, string[]>();// as26NameKey → the party's ledger keys
    recon.forEach((m, i) => {
      if (!partyIndex.has(m.match.as26NameKey)) partyIndex.set(m.match.as26NameKey, i);
      if (!as26LabelOf.has(m.match.as26NameKey)) as26LabelOf.set(m.match.as26NameKey, m.match.as26Name);
      if (!ledgerKeysOf.has(m.match.as26NameKey)) ledgerKeysOf.set(m.match.as26NameKey, m.match.ledgerKeys);
      for (const k of m.match.ledgerKeys) {
        const prev = ledgerOrder.get(k);
        if (prev === undefined || i < prev) ledgerOrder.set(k, i);
      }
    });
    const KIND_ORDER: Record<BillKind, number> = { booksded: 0, as26: 1, value: 2 };
    // A row's own party cell: a books entry is named by the ledger it is booked
    // on, a 26AS entry by the 26AS deductor name.
    const partyOfRow = (r: (typeof sortedRows)[number]): string =>
      r.kind === "booksded"
        ? pseudoKey(r.ledgerKey)
        : (as26LabelOf.get(r.nameKey) ?? pseudoKey(r.ledgerKey));
    const sortedRows = [...billRowsEngine].sort((a, b) => {
      const ia = partyIndex.get(a.nameKey) ?? ledgerOrder.get(a.nameKey) ?? Number.MAX_SAFE_INTEGER;
      const ib = partyIndex.get(b.nameKey) ?? ledgerOrder.get(b.nameKey) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.tax - b.tax;
    });
    const billRows = sortedRows.map((r) => ({
      // The cross-sheet party key: `P<n>` in Deductors-sheet order, so this
      // party's books rows and 26AS rows carry the same id on both unmatched
      // sheets. Blank only if a hand-built row has no recon index.
      partyId: typeof r.reconIdx === "number" ? `P${r.reconIdx + 1}` : "",
      party: partyOfRow(r),
      date: displayDate(r.date),
      tax: r.tax,
      gross: r.gross,
      voucherType: r.voucherType,
      ref: REF_MASK(r.ref),
      status: r.status,
      section: r.section,
      inWindow: r.inWindow,
      linkBasis: r.linkBasis,
      windowState: r.date < fromDate ? "pre" : r.date > toDate ? "post" : "in",
      linked: r.linked
        ? { date: displayDate(r.linked.date), ref: REF_MASK(r.linked.ref), taxable: r.linked.taxable }
        : null,
      delta: r.delta,
      sheetId: r.kind,
      explained: r.explained ?? false,
    }));
    // Row ids (D5): sequential per sheet across the whole run, grouped by
    // masked party — B/D/V + number. late_booking points only at the party's
    // as26 rows whose engine row fell outside the reviewed window.
    // Combination-consumed rows still consume a number (so earlier runs' ids
    // stay stable) but are excluded from the pointer target lists.
    const SHEET_PREFIX: Record<BillKind, string> = { booksded: "B", as26: "D", value: "V" };
    const byParty = new Map<string, Map<BillKind, string[]>>();
    const outOfWindowIds = new Set<string>();
    const idByDedIdx = new Map<number, string>();
    const idByTxIdx = new Map<string, string>();
    // Every label a row may be cited under: its own party cell, plus the
    // party's 26AS name and each of its ledgers. A books finding is labelled
    // with the entry's ledger, a 26AS finding with the 26AS name, so a row has
    // to answer to both.
    const labelsOfRow = (r: (typeof sortedRows)[number]): string[] => {
      const out = new Set<string>([partyOfRow(r)]);
      const as26 = as26LabelOf.get(r.nameKey);
      if (as26) out.add(as26);
      for (const k of ledgerKeysOf.get(r.nameKey) ?? []) out.add(pseudoKey(k));
      return [...out];
    };
    for (const kind of ["booksded", "as26", "value"] as const) {
      let n = 0;
      for (const r of sortedRows) {
        if (r.kind !== kind) continue;
        n += 1;
        const id = `${SHEET_PREFIX[kind]}${n}`;
        if (r.dedIdx !== undefined) idByDedIdx.set(r.dedIdx, id);
        if (r.txIdx !== undefined) idByTxIdx.set(`${r.nameKey}|${r.txIdx}`, id);
        if (r.explained) continue;
        for (const label of labelsOfRow(r)) {
          const rows = byParty.get(label) ?? new Map();
          const list = rows.get(kind) ?? [];
          list.push(id);
          rows.set(kind, list);
          byParty.set(label, rows);
        }
        if (kind === "as26" && !r.inWindow) outOfWindowIds.add(id);
      }
    }
    // Attach each combination's consumed-row ids: the reader sees a books row
    // (e.g. B110) against the 26AS rows it absorbed (e.g. D2..D13).
    recon.forEach((m, i) => {
      const er = result.recon[i];
      const key = (txIdx: number): string => `${er.match.as26NameKey}|${txIdx}`;
      m.combinations.forEach((mc, j) => {
        const ec = er.combinations[j];
        if (!ec) return;
        const targetId = ec.side === "books"
          ? (ec.target.dedIdx !== undefined ? idByDedIdx.get(ec.target.dedIdx) : undefined)
          : (ec.target.txIdx !== undefined ? idByTxIdx.get(key(ec.target.txIdx)) : undefined);
        const partIds = ec.parts.map((p) => ec.side === "books"
          ? (p.txIdx !== undefined ? idByTxIdx.get(key(p.txIdx)) : undefined)
          : (p.dedIdx !== undefined ? idByDedIdx.get(p.dedIdx) : undefined),
        ).filter((x): x is string => x !== undefined);
        mc.targetId = targetId;
        mc.partIds = partIds;
        // A combination is named by its TARGET's side: an as26 target shows
        // the 26AS deductor name, a books target the ledger that entry sits
        // on (its own deduction), falling back to the party's label.
        mc.party = ec.side === "as26"
          ? m.match.as26Name
          : (deductions[ec.target.dedIdx ?? -1]?.ledgerKey
            ? pseudoKey(deductions[ec.target.dedIdx!].ledgerKey)
            : (m.match.ledgerNames.length === 1 ? m.match.ledgerName : m.match.as26Name));
      });
    });
    // Findings point at their drill-down rows. Appended after the findings'
    // maskKnownNames pass (the ids are not known names) and before the
    // outbound sweep; wording fixed by the task addendum (A4.4).
    const POINTER_TO: Partial<Record<As26CheckId, { kind: BillKind; label: string }[]>> = {
      books_tax_not_in_26as: [{ kind: "booksded", label: "Books not in 26AS" }],
      deduction_without_sale: [{ kind: "booksded", label: "Books not in 26AS" }],
      as26_tax_not_in_books: [{ kind: "as26", label: "26AS unmatched" }],
      late_booking: [{ kind: "as26", label: "26AS unmatched" }],
      unresolved_combination: [
        { kind: "booksded", label: "Books not in 26AS" },
        { kind: "as26", label: "26AS unmatched" },
      ],
      assessable_value_mismatch: [{ kind: "value", label: "Bill value mismatch" }],
    };
    for (const f of findings) {
      const pointer = POINTER_TO[f.check];
      if (!pointer) continue;
      const parts: string[] = [];
      for (const { kind, label } of pointer) {
        const ids = byParty.get(f.party)?.get(kind) ?? [];
        const shown = f.check === "late_booking" && kind === "as26"
          ? ids.filter((id) => outOfWindowIds.has(id))
          : ids;
        if (shown.length > 0) parts.push(`see ${label} rows ${shown.join(", ")}`);
      }
      if (parts.length > 0) f.detail += ` ${parts.join("; ")}.`;
    }

    // FD 20% rows are books entries: each is named by the FD ledger it was
    // booked on (the engine stamps it), falling back to the party's label.
    const fd20BankLabel = new Map(recon.map((r) => [r.match.as26NameKey, r.match.as26Name]));
    const fd20 = result.fd20.map((e) => ({
      party: e.fdLedger ? pseudoName(e.fdLedger) : (fd20BankLabel.get(e.nameKey) ?? pseudoKey(e.nameKey)),
      date: displayDate(e.date),
      interest: e.interest,
      tax: e.tax,
    }));
    const fdAutoMasked = (result.fdAuto ?? []).map((a) => ({
      ledger: pseudoName(a.ledger),
      bank: pseudoName(a.bank),
      rule: a.rule,
    }));
    // Unassigned FD ledgers are named in the workbook (de-masked there); here
    // they carry the same stable ledger pseudonym as every other ledger, so
    // the vault can resolve them on the way out.
    const fdUnassignedMasked = (result.fdUnassigned ?? []).map(pseudoName);
    const masked: As26ReviewResult = sweepStrings(
      {
        company: company ?? undefined,
        fromDate,
        toDate,
        findings,
        recon,
        gaps,
        totals: result.totals,
        mastersUnavailable,
        groupsUnavailable,
        skipped: result.skipped,
        counts: { credits, receivableLedgers: recLedgers, creditLedgerSource },
        bookEvents,
        billRows,
        fd20,
        fdAuto: fdAutoMasked,
        fdUnassigned: fdUnassignedMasked,
      },
      vault,
    ) as As26ReviewResult;
    lastAs26 = masked;
    return masked;
  }

  async function tdsReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    asOnDate: string,
    operatorIn: OperatorFile,
    operatorSource: "json" | "template",
    winman?: WinmanFacts,
    dayBook?: DayBookInput,
  ): Promise<TdsReviewResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || !/^\d{8}$/.test(asOnDate) || fromDate > toDate) {
      throw new Error("fromDate, toDate and asOnDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;
    // §8.4 merge: Winman challans union into the operator's on
    // (section, forMonth). The same key with a different deposit date is a
    // hard error naming the section and month (enum + YYYY-MM — no values at
    // risk); equal dates dedupe. The Challan sheet's Bare-label rows never
    // reached here: parseWinmanExport already normalised them.
    const operator: OperatorFile = { ...operatorIn };
    // TAN carry-through (2026-09-26 addendum item 1): the Winman Deductor
    // block's TAN fills the operator file's gap; the operator's own Settings
    // TAN stays the override. A disagreement is never silent — the operator's
    // value is used and a finding says so. No TAN value ever reaches any
    // outbound string (Q7 choice B).
    let tanConflict = false;
    if (winman?.tan) {
      if (operator.tan === undefined) operator.tan = winman.tan;
      else if (operator.tan !== winman.tan) tanConflict = true;
    }
    if (winman) {
      const opIndex = new Map(operator.challans.map((c) => [`${c.section}|${c.forMonth}`, c]));
      const next: typeof operator.challans = [...operator.challans];
      for (const gc of winman.challans) {
        const existing = opIndex.get(`${gc.section}|${gc.forMonth}`);
        if (!existing) {
          next.push(gc);
          continue;
        }
        if (existing.depositDate !== gc.depositDate) {
          throw new Error(
            `the operator file and the Winman export disagree on ${gc.section} ${gc.forMonth}'s deposit date; fix one of them before the review runs`,
          );
        }
      }
      operator.challans = next;
    }
    // The verbose whole-company master export is the heaviest downstream call
    // and the only one a large company can wedge — the captain asked for the
    // narrowest request on a shared Tally. When it fails (P1 fields absent or
    // the live server unreachable), the session degrades to operator-file-only
    // facts: flags/PANs read as absent, never guessed, and the run records it.
    const mastersUnavailable = { value: false } as { value: boolean };
    // groups() sat outside the degradation described below: an unreachable
    // Tally rejected the whole review before ledgersTax()'s catch could do its
    // job. With a day book in hand the run is meant to survive exactly that,
    // so the group tree degrades the same way — bundle first, then empty,
    // which makes every ledger default-mask.
    const groupsUnavailable = { value: false } as { value: boolean };
    const [groupsLive, masters] = await Promise.all([
      d.groups(company).catch((e: unknown) => {
        groupsUnavailable.value = true;
        console.error(
          `tally-agent: group tree unavailable (${e instanceof Error ? e.message : e}); running without it`,
        );
        return [] as Awaited<ReturnType<Downstream["groups"]>>;
      }),
      d.ledgersTax(company).catch((e: unknown) => {
        mastersUnavailable.value = true;
        console.error(
          `tally-agent: verbose ledger masters unavailable (${e instanceof Error ? e.message : e}); running without them`,
        );
        return [] as Awaited<ReturnType<Downstream["ledgersTax"]>>;
      }),
    ]);
    const groups = groupsUnavailable.value && dayBook?.groups ? dayBook.groups : groupsLive;
    // The statement findings' deductee is a fleet label ("statement Q1"), not
    // a ledger: force it clear so maskLedgerName returns it unchanged (item 2).
    const statementLabels = ["Q1", "Q2", "Q3", "Q4"].map((q) => `statement ${q}`);
    const c = buildClassifier(groups, {
      ...overrides,
      // A day-book finding's deductee is the provenance literal, never a
      // ledger: force it clear so maskLedgerName returns it unchanged.
      forceClearLedgers: [...overrides.forceClearLedgers, DAY_BOOK_FINDING, ...statementLabels],
    });
    classifier = c;
    for (const l of masters) groupOfLedger.set(canonicalKey(l.name), l.parent);
    // The bundle's ledger→group edges fill in only what the live masters did
    // not supply; a live master always wins.
    if (mastersUnavailable.value) {
      for (const l of dayBook?.ledgers ?? []) {
        if (!groupOfLedger.has(canonicalKey(l.name))) groupOfLedger.set(canonicalKey(l.name), l.parent);
      }
    }

    // PAN channel: a real PAN travels only as its TaxId N pseudonym (M2
    // pattern). The PAN's 4th character feeds the statutory rate. A master
    // that carries no PAN of its own takes the PAN embedded in its GSTIN
    // (characters 3–12) when that is well-formed; an explicit master PAN
    // always wins, and an absent or malformed GSTIN derives nothing.
    // `panDerived` records the derived cases so a finding can say the PAN came
    // from the GSTIN without ever printing either — both travel only as their
    // TaxId alias.
    const panOf = new Map<string, string>();
    const panDerived = new Set<string>();
    for (const l of masters) {
      const k = canonicalKey(l.name);
      if (panOf.has(k)) continue;
      if (l.pan) {
        panOf.set(k, l.pan);
        continue;
      }
      const derived = panFromGstin(l.gstin);
      if (derived) {
        panOf.set(k, derived);
        panDerived.add(k);
      }
    }
    // The bundle's PAN/GSTIN facts fill in only what live masters did not
    // supply (item 3): a PAN-less live master upgrades from the day-book
    // export, never the reverse. Older bundles carry no pan/gstin and fill
    // nothing; derivation from the GSTIN mirrors the live path exactly.
    for (const l of dayBook?.ledgers ?? []) {
      const k = canonicalKey(l.name);
      if (!k || panOf.has(k)) continue;
      if (l.pan) {
        panOf.set(k, l.pan);
        continue;
      }
      const derived = panFromGstin(typeof l.gstin === "string" ? l.gstin : null);
      if (derived) {
        panOf.set(k, derived);
        panDerived.add(k);
      }
    }
    const panAliasOf = new Map<string, string>();
    for (const [k, pan] of panOf) panAliasOf.set(k, vault.pseudonym(pan, "tax_id"));
    // §8.4 PAN pickup: for each template Parties row declaring a Winman
    // Deductee Name, that exact string (trimmed) joins one deductee; a
    // Winman-only PAN is adopted through the same vault channel, identical
    // masking, no new path. Names are never fuzzy-matched, so a parenthetical
    // remark in a Winman name is the operator's declared form. Template PAN
    // and Winman PAN disagreeing after compaction is a hard error citing the
    // Parties row — never a value.
    let panAdopted = 0;
    if (winman) {
      for (const p of operator.parties) {
        if (!p.winmanName) continue;
        const declared = p.winmanName.trim();
        const hit = winman.deductees.find((x) => x.name === declared);
        if (!hit?.pan) continue;
        if (p.pan && p.pan !== hit.pan) {
          throw new Error(
            `template Parties row ${p.panRow ?? "?"}, column C (PAN): the cell disagrees with the Winman export's PAN — retype the PAN (text column) or fix the export`,
          );
        }
        if (!p.pan) panAdopted += 1;
        panAliasOf.set(canonicalKey(p.ledger), vault.pseudonym(hit.pan, "tax_id"));
        // The operator/Winman PAN takes precedence over a GSTIN-derived one,
        // so the rate no longer rests on the GSTIN.
        panDerived.delete(canonicalKey(p.ledger));
      }
    }
    // Party→master resolution is a hot path: `analyzeTds` calls these closures
    // per booking, so a linear `masters.find` here was tens of millions of
    // `canonicalKey` scans on a real company (30+ min of blocked CPU). Index
    // the masters once; first match wins, preserving the old `find` semantics
    // for a duplicate canonical key.
    const masterOf = new Map<string, LedgerTaxInfo>();
    for (const l of masters) {
      const k = canonicalKey(l.name);
      if (!masterOf.has(k)) masterOf.set(k, l);
    }
    const realOf = (party: string): string => masterOf.get(canonicalKey(party))?.name ?? party;

    const roleOfLedger = (ledger: string): GroupRole =>
      c.role(groupOfLedger.get(canonicalKey(ledger)) ?? "");
    // Tally's own flags decide the classes: duty (Duties group), party
    // (creditor/debtor), and the flagged expense/purchase rest — filled in by
    // the operator file; anything unknown is a tds_section_unknown finding.
    const isParty = (l: (typeof masters)[number]) => l.isTdsApplicable === true && ["creditor", "debtor", "capital", "suspense"].includes(roleOfLedger(l.name));
    const isDuty = (l: (typeof masters)[number]) =>
      c.role(l.parent) === "duties" || c.role(groupOfLedger.get(canonicalKey(l.name)) ?? "") === "duties";
    const dutyLedgerNames = masters.filter((l) => l.isTdsApplicable === true && isDuty(l)).map((l) => l.name);
    // The operator's TDS Applicable column is the counterpart of the master's
    // own question: `Y` adds the party even when the master misses it; `N`
    // subtracts it even when the master flags it (that override is made
    // visible through a review-only tds_master_gap note below).
    const partyLedgerNames = [
      ...masters.filter(isParty).map((l) => l.name),
      ...operator.parties.filter((p) => p.tdsApplicable).map((p) => p.ledger),
    ];
    const operatorNo = operator.parties.filter((p) => !p.tdsApplicable).map((p) => p.ledger);
    const operatorNoKeys = new Set(operatorNo.map(canonicalKey));
    // Ledger Kind (design §6a): a `TDS Duty` row never lands on the expense
    // side — when the verbose master export fails, its duty credits would
    // otherwise be re-counted as bookings. Empty and masters-unavailable
    // reproduces yesterday's behaviour exactly.
    const expenseLedgerNames = [
      ...masters.filter((l) => l.isTdsApplicable === true && !isDuty(l) && !isParty(l)).map((l) => l.name),
      ...operator.sections.filter((s) => s.kind !== "duty").map((s) => s.ledger),
      ...operator.certificates.map((s) => s.ledger),
    ];
    const operatorDutyLedgers = operator.sections.filter((s) => s.kind === "duty").map((s) => s.ledger);

    const unique = (names: string[]): string[] => {
      const seen = new Set<string>();
      return names.filter((n) => (seen.has(canonicalKey(n)) ? false : (seen.add(canonicalKey(n)), true)));
    };
    // The duty side the engine reads is the union of the master-flagged duty
    // ledgers and the operator template's `TDS Duty` rows. On a company whose
    // masters carry no TDS flags the master side is empty and the template is
    // the only signal; with flags present the union is a superset, so
    // master-flagged behaviour is unchanged. Canonical-key deduplicated so one
    // ledger named by both sides is read once.
    const dutyLedgerNamesAll = unique([...dutyLedgerNames, ...operatorDutyLedgers]);
    // TCS slice (clause 34): the operator's TCS-section rows name receipt and
    // duty ledgers; the heuristic adds any master ledger named /tcs/i under a
    // duties root. One fetch set, one projection pass — the downstream call
    // cost is per call, never per row.
    const tcsLedgerNames = unique([
      ...(operator.tcsSections ?? []).map((s) => s.ledger),
      ...masters.filter((l) => /tcs/i.test(l.name) && isDuty(l)).map((l) => l.name),
    ]);
    /** canonical ledger key -> TcsNature.key (operator rows are exact Winman strings). */
    const tcsNatureKeys = new Map<string, string>();
    for (const s of operator.tcsSections ?? []) {
      const nature = tcsNatureByWinman(s.nature)?.key;
      if (nature) tcsNatureKeys.set(canonicalKey(s.ledger), nature);
    }
    const tcsDutyKeys = new Set(
      tcsLedgerNames
        .filter((n) => c.role(groupOfLedger.get(canonicalKey(n)) ?? "") === "duties")
        .map(canonicalKey),
    );
    const fetchSet = unique([
      ...dutyLedgerNamesAll,
      ...expenseLedgerNames,
      ...partyLedgerNames,
      ...tcsLedgerNames,
    ]);
    const dutyKeys = new Set(dutyLedgerNamesAll.map(canonicalKey));
    const partyKeys = new Set(partyLedgerNames.map(canonicalKey));
    // Books come either from ~640 sequential Ledger-Vouchers calls or from one
    // operator day-book export. The projector reproduces the live path's signs
    // and carries only the five fields the engine reads, so nothing else in
    // this function changes.
    const fetched = dayBook
      ? {
          rows: new Map(
            projectLedgerRows(
              dayBook.vouchers.filter((v) => {
                const d = String(v.date);
                return d >= fromDate && d <= toDate;
              }),
              fetchSet,
              {
                // Item 6: a duty line's counterparty is the voucher's party
                // ledger, not its largest opposite-sign expense line.
                isDutyLedger: (n) => dutyKeys.has(canonicalKey(n)),
                isPartyLedger: (n) => partyKeys.has(canonicalKey(n)),
              },
            ).map((p) => [canonicalKey(p.ledger), p.rows] as const),
          ),
          calls: 0,
        }
      : await fetchLedgerRows(company, fetchSet, fromDate, toDate);

    // Section resolution (revision 2 of the spreadsheet-input design): the
    // duty ledger's mapped section for deductions and deposits; the booked
    // expense ledger's mapped section for bookings; there is no party→section
    // mapping. Multi-valued, so an ambiguous ledger is *detected* — one
    // section, or none, resolves; two or more never guesses.
    const sectionSets = new Map<string, Set<string>>();
    for (const s of operator.sections) {
      const set = sectionSets.get(canonicalKey(s.ledger)) ?? new Set<string>();
      set.add(s.section);
      sectionSets.set(canonicalKey(s.ledger), set);
    }
    const resolveSection = (ledger: string): { section: string | null; candidates: string[] } => {
      const set = [...(sectionSets.get(canonicalKey(ledger)) ?? [])].sort();
      return set.length === 1 ? { section: set[0], candidates: [] } : { section: null, candidates: set.length > 1 ? set : [] };
    };
    const dutySectionOf = (dutyLedger: string): string | null => {
      const set = [...(sectionSets.get(canonicalKey(dutyLedger)) ?? [])];
      return set.length === 1 ? set[0] : null;
    };
    // The full candidate list behind dutySectionOf's null: the engine uses it
    // to disambiguate an ambiguous duty ledger per row, from the expense-side
    // evidence of the same voucher or the linked same-date bill (2026-09-26c).
    const dutyCandidatesOf = (dutyLedger: string): string[] =>
      [...(sectionSets.get(canonicalKey(dutyLedger)) ?? [])].sort();

    const certificateRateOf = (party: string, section: string, date: string): number | null => {
      const real = realOf(party);
      for (const cert of operator.certificates) {
        if (canonicalKey(cert.ledger) === canonicalKey(party) && cert.section === section && cert.from <= date && date <= cert.to) {
          return cert.rate / 100;
        }
      }
      void real;
      return null;
    };
    const ops = (party: string) => operator.parties.find((p) => canonicalKey(p.ledger) === canonicalKey(party));
    const transporterDeclared = (party: string): boolean => ops(party)?.transporterDeclaration ?? false;
    const deducteeFiledReturn = (party: string): boolean => ops(party)?.deducteeFiledReturn ?? false;
    // The deductee type is the PAN's 4th character (item 8) — including a
    // PAN derived from the GSTIN, since panOf already holds both. The full
    // statutory alphabet P/H/C/F/A/B/T/L/J/G feeds the rate table; a letter
    // a section's table does not name falls back to that section's standard
    // rate inside rateFor. The Tally master's tdsDeducteeType field is no
    // longer read — the PAN is the authority; no PAN is s.206AA.
    const entityOf = (party: string): "P" | "H" | "C" | "F" | "A" | "B" | "T" | "L" | "J" | "G" | null => {
      const pan = panOf.get(canonicalKey(party)) ?? null;
      if (!pan || pan.length < 4) return null;
      const ch = pan[3].toUpperCase();
      return /^[PHCFTBLJG]$/.test(ch) ? (ch as "P" | "H" | "C" | "F" | "A" | "B" | "T" | "L" | "J" | "G") : null;
    };
    const panKeyOf = (party: string): string | null => panAliasOf.get(canonicalKey(party)) ?? null;

    // Subsequent-year challan allocations (2026-09-26i): the Winman
    // deductee name joins the template's Winman Deductee Name declaration
    // (exact trimmed match, §8.4 precedent — never fuzzy, never guessed). An
    // allocation no template party declares is dropped here; the engine never
    // sees an unjoined name. Exception — a timing-only section (2026-09-26o
    // item 038/039): its deposit coverage is section-level (the duty credit
    // debits the partners' Capital Accounts, which no operator row declares),
    // so an allocation of such a section is carried with its Winman name as
    // the party; the engine matches it by section + month + tax alone.
    const winmanLedgerOf = new Map<string, string>();
    for (const p of operator.parties) {
      if (p.winmanName) winmanLedgerOf.set(p.winmanName.trim(), p.ledger);
    }
    const subsequentDeposits: SubsequentDeposit[] = [];
    for (const a of winman?.allocations ?? []) {
      const ledger = winmanLedgerOf.get(a.name);
      if (!ledger) {
        if (timingOnlySection(a.section)) {
          subsequentDeposits.push({ party: a.name, section: a.section, tax: a.tax, dedDate: a.dedDate, depositDate: a.depositDate, interestPaid: a.interestPaid, challanId: a.challanId });
        }
        continue;
      }
      subsequentDeposits.push({ party: ledger, section: a.section, tax: a.tax, dedDate: a.dedDate, depositDate: a.depositDate, interestPaid: a.interestPaid, challanId: a.challanId });
    }

    const ctx: TdsCtx = {
      tdsParties: unique([
        ...partyLedgerNames,
        ...operator.parties.filter((p) => p.tdsApplicable).map((p) => p.ledger),
      ]).filter((n) => !operatorNoKeys.has(canonicalKey(n))),
      resolveSection,
      dutySectionOf,
      dutyCandidatesOf,
      panKeyOf,
      panDerivedFromGstinOf: (party: string): boolean => panDerived.has(canonicalKey(party)),
      entityOf,
      certificateRateOf,
      transporterDeclared,
      deducteeFiledReturn,
      asOnDate,
      period: { fromDate, toDate },
      subsequentDeposits,
      lateDeductionInterest: operator.lateDeductionInterest,
    };

    // The engine runs month-chunked book events; the day-book reconciliation
    // (an operator fullCheck export) runs the same engine on operator rows.
    const bookRows = asTdsLedgerRows(fetched.rows, fetchSet);
    const analysis = analyzeTds(
      bookRows.filter((r) => dutyLedgerNamesAll.some((n) => canonicalKey(n) === r.ledger)),
      bookRows.filter((r) => expenseLedgerNames.some((n) => canonicalKey(n) === r.ledger)),
      bookRows.filter((r) => ctx.tdsParties.some((p) => canonicalKey(p) === r.ledger)),
      { ...ctx, operator } as Parameters<typeof analyzeTds>[3],
    );

    // The operator-N override is never silent (design §6b): where the Tally
    // master flags a ledger TDS-applicable and the operator file says N, the
    // operator keeps the authority — the file is the more current human fact,
    // and the master may simply be unconfigured — but the suppression is
    // visible as the existing review-only tds_master_gap finding.
    for (const l of masters.filter(
      (m) => m.isTdsApplicable === true && operatorNoKeys.has(canonicalKey(m.name)),
    )) {
      const n = analysis.findings.filter((f) => f.check === "tds_master_gap").length + 1;
      analysis.findings.push({
        id: tdsFindingId("tds_master_gap", n),
        check: "tds_master_gap",
        severity: "review",
        deductee: l.name,
        group: "Sundry Creditors",
        section: null,
        amount: 0,
        detail:
          "the Tally master flags this ledger TDS-applicable, but the operator file marks it not applicable; the operator's declaration suppresses it — no bookings, payments or findings are produced for it.",
      });
    }

    // The TAN disagreement is a finding, never silence (addendum item 1).
    // Both values stay behind the vault: the detail names the channels, never
    // the TANs, and the operator's Settings value is the one the review used.
    if (tanConflict) {
      console.error(
        "tally-agent: the operator file and the Winman export carry different TANs; the operator file's value is used",
      );
      const n = analysis.findings.filter((f) => f.check === "tds_master_gap").length + 1;
      analysis.findings.push({
        id: tdsFindingId("tds_master_gap", n),
        check: "tds_master_gap",
        severity: "review",
        deductee: "",
        group: "",
        section: null,
        amount: 0,
        detail:
          "the operator file and the Winman export carry different TANs; the operator file's value is used — align them before the statement is filed.",
      });
    }

    // Input weaknesses are findings, not silence: a file that parsed is not a
    // file that covers the period. Severity is critical wherever the review
    // would otherwise understate the books.
    if (dayBook) {
      const pushDayBook = (check: TdsCheckId, severity: Severity, detail: string): void => {
        const n = analysis.findings.filter((f) => f.check === check).length + 1;
        analysis.findings.push({
          id: tdsFindingId(check, n),
          check,
          severity,
          deductee: DAY_BOOK_FINDING,
          group: "",
          section: null,
          amount: 0,
          detail,
        });
      };
      for (const m of dayBook.emptyMonths) {
        pushDayBook(
          "tds_daybook_month_empty",
          "critical",
          `the operator day-book file holds no voucher at all for ${displayMonth(m)}. If that month has entries in Tally, the export is incomplete and every check below understates the period.`,
        );
      }
      if (dayBook.rejected > 0) {
        pushDayBook(
          "tds_daybook_rows_rejected",
          "critical",
          `${count(dayBook.rejected)} entries in the operator day-book file could not be read as vouchers and were excluded. The review is incomplete by that much.`,
        );
      }
      if (dayBook.company === null) {
        pushDayBook(
          "tds_daybook_unverified",
          "review",
          "the operator day-book file is a bare voucher list: it names neither a company nor a period, so neither could be checked against this review. Re-export it in the tally-agent bundle shape to have both verified.",
        );
      }
      // A ledger the review touched but has no group for cannot be classified
      // or masked by ancestry, so it default-masks. That is the safe branch,
      // but it is never silent.
      const unmastered = fetchSet.filter((n) => !groupOfLedger.has(canonicalKey(n)));
      for (const name of unmastered) {
        const n = analysis.findings.filter((f) => f.check === "tds_daybook_ledger_unmastered").length + 1;
        analysis.findings.push({
          id: tdsFindingId("tds_daybook_ledger_unmastered", n),
          check: "tds_daybook_ledger_unmastered",
          severity: "review",
          deductee: name,
          group: "",
          section: null,
          amount: 0,
          detail:
            "no group is known for this ledger, so it could not be classified by ancestry and is masked by default. Export the tally-agent bundle shape (which carries groups and ledgers) or run with Tally reachable to classify it.",
        });
      }
    }

    // Clause 34 TCS slice: collections are duty credits, deposits duty
    // debits, and the gross receipts come from the nature-mapped receipt
    // ledgers. natureOfReceipt is the operator TCS-section map first, the
    // /tcs/i duty-name keyword heuristic second; a participating slice
    // neither resolves is a finding on the (masked) ledger, never a guess.
    const tcsKeys = new Set(tcsLedgerNames.map(canonicalKey));
    const tcsSlices = bookRows.filter((sl) => tcsKeys.has(sl.ledger));
    const tcsNameOf = (ledger: string): string =>
      tcsLedgerNames.find((n) => canonicalKey(n) === ledger) ?? ledger;
    const tcsNatureOf = (ledger: string): string | null => {
      const mapped = tcsNatureKeys.get(canonicalKey(ledger));
      if (mapped) return mapped;
      if (!tcsDutyKeys.has(canonicalKey(ledger))) return null;
      const hit = TCS_NAME_KEYWORDS.find(([re]) => re.test(ledger));
      return hit ? hit[1] : null;
    };
    const tcsAnalysis = analyzeTcs(
      tcsSlices.filter((sl) => tcsDutyKeys.has(sl.ledger)),
      tcsSlices.filter((sl) => !tcsDutyKeys.has(sl.ledger)),
      tcsNatureOf,
    );
    for (const sl of tcsSlices) {
      if (sl.rows.length === 0 || tcsNatureOf(sl.ledger) !== null) continue;
      const n = analysis.findings.filter((f) => f.check === "tcs_unclassified_ledger").length + 1;
      analysis.findings.push({
        id: tdsFindingId("tcs_unclassified_ledger", n),
        check: "tcs_unclassified_ledger",
        severity: "review",
        deductee: tcsNameOf(sl.ledger),
        group: groupOfLedger.get(sl.ledger) ?? "",
        section: null,
        amount: 0,
        detail:
          "this TCS ledger was touched in the period, but its nature of receipt could not be resolved — map it in the operator file's TCS sections (an exact Winman nature string) or rename it to name the nature of goods.",
      });
    }
    // Clause-34 rows for the Winman 3CD round trip; the full slice stays in
    // the session cache, the result gains only counts and money() amounts.
    // The deductor shown on the 3CD sheets is the return's own (the Winman
    // export's Deductor name, 2026-09-26r inbox 065), never the Tally company
    // — a supplied Winman file without it then fails at 3CD write time rather
    // than silently showing the Tally name.
    lastWinmanNameMissing = winman !== undefined && !winman.deductorName;
    const tds3cd = tds3cdRows({
      company: company ?? "",
      tan: operator.tan ?? null,
      deductorName: winman?.deductorName ?? company ?? "",
      tds: analysis,
      tcs: tcsAnalysis,
      operator,
      asOnDate,
      challans: subsequentDeposits,
      challanAllocations: (winman?.allocations ?? []).map((a) => ({
        section: a.section,
        tax: a.tax,
        dedDate: a.dedDate,
        paidDate: a.paidDate,
        depositDate: a.depositDate,
        interestPaid: a.interestPaid,
        challanId: a.challanId,
      })),
    });
    lastTds3cd = tds3cd;

    const maskTdsFinding = (f: TdsFinding): TdsMaskedFinding => {
      // Registry first (drill-down by finding id, R-MCP-4), then masking.
      realLedgerByFinding.set(f.id, f.deductee);
      const deducteeMask = maskLedgerName(
        f.deductee,
        groupOfLedger.get(canonicalKey(f.deductee)) ?? "",
        c,
        vault,
      );
      const schedule = (f.schedule ?? []).map((s) => ({
        ...s,
        basis: scrubSecrets(s.basis),
      }));
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        deductee: deducteeMask,
        group: scrubSecrets(f.group),
        section: f.section,
        amount: f.amount,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
        ...(schedule.length ? { schedule } : {}),
      };
    };
    const findings = analysis.findings.map(maskTdsFinding);
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    // Consolidations (2026-09-29): one credit covering several bookings. The
    // same masking path as a finding's deductee, so a consolidated party is
    // the same pseudonym the (silent) bookings would have carried. The booked
    // dates go out as `displayDate` and no voucher number is emitted.
    const consolidations = analysis.consolidations.map((con) => ({
      deductee: maskLedgerName(con.party, groupOfLedger.get(canonicalKey(con.party)) ?? "", c, vault),
      section: con.section,
      scope: con.scope,
      creditDate: displayDate(con.creditDate),
      tax: con.tax,
      bookings: con.bookings.map((b) => ({ date: displayDate(b.date), tax: b.tax })),
    }));

    const result: TdsReviewResult = {
      company,
      mastersAvailable: !mastersUnavailable.value,
      fromDate,
      toDate,
      asOnDate,
      operatorSource,
      winman: {
        used: winman !== undefined,
        challans: winman?.challans.length ?? 0,
        deductees: winman?.deductees.length ?? 0,
        panAdopted,
      },
      counts,
      findings,
      consolidations,
      totals: {
        bySection: analysis.totals.bySection.map((t) => ({
          section: t.section,
          gross: t.gross,
          tax: t.tax,
        })),
        notDeducted: analysis.totals.notDeducted,
        shortDeducted: analysis.totals.shortDeducted,
        interestI: analysis.totals.interestI,
        interestIi: analysis.totals.interestIi,
      },
      ledgerCalls: fetched.calls,
      booksSource: dayBook ? "daybook-file" : "live",
      section194QApplicable: operator.section194QApplicable,
      tds3cd: {
        sheets: {
          tds: tds3cd.tds.length,
          tcs: tds3cd.tcs.length,
          returns: tds3cd.returns.length,
          interestTds: tds3cd.interestTds.length,
          interestTcs: tds3cd.interestTcs.length,
        },
        totals: {
          tdsNotDeposited: money(tds3cd.tds.reduce((a, r) => a + r.notDeposited, 0)),
          tcsNotDeposited: money(tds3cd.tcs.reduce((a, r) => a + r.notDeposited, 0)),
          interestPayable: money(
            tds3cd.interestTds.reduce((a, r) => a + r.payable, 0) +
              tds3cd.interestTcs.reduce((a, r) => a + r.payable, 0),
          ),
        },
        skippedInterestQuarters: [...tds3cd.skippedInterestQuarters],
      },
      ...(dayBook
        ? {
            books: {
              vouchers: dayBook.vouchers.length,
              ledgersProjected: fetchSet.length,
              fromObserved: dayBook.observedFrom,
              toObserved: dayBook.observedTo,
              rejected: dayBook.rejected,
              mastersSource: mastersUnavailable.value
                ? dayBook.ledgers
                  ? ("bundle" as const)
                  : ("absent" as const)
                : ("live" as const),
            },
          }
        : {}),
    };
    lastTds = result;
    lastTdsBooks = {
      events: analysis.events,
      liabilities: analysis.liabilities,
      clause21b: analysis.clause21b,
      panOf: (party: string) => panOf.get(canonicalKey(party)) ?? null,
      panDerivedFromGstinOf: (party: string) => panDerived.has(canonicalKey(party)),
      panAliasOf: (party: string) => panAliasOf.get(canonicalKey(party)) ?? null,
      company,
      fromDate,
      toDate,
      booksSource: dayBook ? "daybook-file" : "live",
    };
    return result;
  }

  /**
   * Income Tax Act depreciation per block of assets, over the two-pass fetch
   * of the design's §5: pass 1 is cheap and whole-company (groups, two trial
   * balances, the depreciation expense ledger and the disposal-signal
   * ledgers, all month-chunked); pass 2 fetches month-chunked voucher rows
   * only for the asset ledgers whose residual is not already explained by
   * their own depreciation charge. TALLY_AGENT_DEP_FETCH_ALL=1 forces the
   * exhaustive path.
   */
  async function depreciationReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    operatorText: string | null,
  ): Promise<DepReviewResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;
    const operator = operatorText === null
      ? EMPTY_DEP_OPERATOR
      : parseDepOperatorFile(operatorText, fromDate, toDate);

    // Pass 1: cheap, whole-company. Opening = the trial balance as on the day
    // before the period; closing = as on its last day (R-MCP-5: positive =
    // debit; date-bounded, unlike the ledger master's CLOSINGBALANCE).
    const [groups, opening, closing] = await Promise.all([
      d.groups(company),
      d.trialBalance(company, dayBefore(fromDate)),
      d.trialBalance(company, toDate),
    ]);
    const c = buildClassifier(groups, overrides);
    classifier = c;
    // maskVoucherRow and the masking helpers below read this map, so it is
    // populated before anything is masked.
    for (const r of closing.rows) groupOfLedger.set(canonicalKey(r.name), r.parent);

    // buildClassifier's rootOf returns string | null — coerced once, here.
    const rootOf = (group: string): string => c.rootOf(group) ?? "";
    const groupOf = (ledger: string): string =>
      groupOfLedger.get(canonicalKey(ledger)) ?? "";

    const assetLedgers = closing.rows
      .filter((r) => canon(rootOf(r.parent)) === "fixed assets")
      .map((r) => r.name);
    const assetKeySet = new Set(assetLedgers.map(canonicalKey));
    const depreciationLedgers = closing.rows
      .filter((r) => DEP_EXPENSE_ROOTS.has(canon(rootOf(r.parent))) && DEP_EXPENSE_NAME.test(r.name))
      .map((r) => r.name);
    const disposalLedgers = closing.rows
      .filter((r) => DEP_DISPOSAL_ROOTS.has(canon(rootOf(r.parent))) && DEP_DISPOSAL_NAME.test(r.name))
      .map((r) => r.name);

    const pass1 = await fetchLedgerRows(
      company, [...depreciationLedgers, ...disposalLedgers], fromDate, toDate,
    );

    // The book charge per asset ledger, read once from the expense side: a
    // debit row on the depreciation expense ledger names the charged asset
    // and carries the charge, positive = debit (R-MCP-5).
    const chargeByAsset = new Map<string, number>();
    let depreciationLedgerDebits = 0;
    for (const l of depreciationLedgers) {
      for (const row of rowsByLedger(pass1.rows, l)) {
        if (row.amount <= 0) continue;
        depreciationLedgerDebits += row.amount;
        const key = canonicalKey(row.counterparty);
        chargeByAsset.set(key, (chargeByAsset.get(key) ?? 0) + row.amount);
      }
    }

    // Pass 2: only the ledgers the books do not already explain. The residual
    // is closing - opening + the charge pass 1 already attributed to this
    // ledger; a ledger whose only movement was its own depreciation nets to
    // nil and its FETCH is skipped. That is a transport optimisation only, not
    // a scope decision: an idle asset still carries an opening WDV and must be
    // an asset row, so it is added back below with no rows.
    // TALLY_AGENT_DEP_FETCH_ALL=1 disables the skip (design §5).
    const openingOf = new Map(opening.rows.map((r) => [canonicalKey(r.name), r.balance] as const));
    const closingOf = new Map(closing.rows.map((r) => [canonicalKey(r.name), r.balance] as const));
    const fetchAll = process.env.TALLY_AGENT_DEP_FETCH_ALL === "1";
    const needFetch = assetLedgers.filter((l) => {
      if (fetchAll) return true;
      const k = canonicalKey(l);
      const residual = (closingOf.get(k) ?? 0) - (openingOf.get(k) ?? 0) + (chargeByAsset.get(k) ?? 0);
      if (process.env.TALLY_AGENT_DEP_DEBUG) {
        console.error(`DEPDBG skip-check ledger=${JSON.stringify(l)} open=${openingOf.get(k)} close=${closingOf.get(k)} charge=${chargeByAsset.get(k)} residual=${residual} depKeys=${chargeByAsset.size}`);
      }
      return Math.abs(residual) > ZERO_TOLERANCE;
    });
    const pass2 = await fetchLedgerRows(company, needFetch, fromDate, toDate);

    // Every asset ledger of the company is an asset row, not only the ones
    // that moved: an idle ledger contributes its own opening WDV to the block's
    // allocation denominator and gets its pro-rata share of the Act figure
    // (design §15). Only a nil-opening, never-moved ledger stays out.
    const fetched = new Set(needFetch.map(canonicalKey));
    const inScope = assetLedgers.filter((l) =>
      isAssetRowInScope(openingOf.get(canonicalKey(l)) ?? 0, fetched.has(canonicalKey(l))));

    // The engine's ctx of closures: nothing Tally-shaped crosses here, only
    // what the ctx already carries. Opening block WDV comes from the operator
    // file when supplied, otherwise from the book balances (and the engine's
    // check 3 flags the seed as unverified).
    const blockSeed = new Map<string, number>();
    for (const r of opening.rows) {
      if (!assetKeySet.has(canonicalKey(r.name))) continue;
      const block = groupOf(r.name);
      blockSeed.set(block, round2((blockSeed.get(block) ?? 0) + r.balance));
    }
    const ctx: DepCtx = {
      fromDate,
      toDate,
      operator,
      groupOf,
      groupRootOf: (ledger) => rootOf(groupOf(ledger)),
      isAssetLedger: (ledger) => assetKeySet.has(canonicalKey(ledger)),
      openingWdv: (block) => {
        const row = operator.openingWdv.find((o) => canon(o.block) === canon(block));
        if (row) return { amount: row.amount, source: "operator" };
        return { amount: blockSeed.get(block) ?? 0, source: "book-seed" };
      },
      bookOpening: (ledger) => openingOf.get(canonicalKey(ledger)) ?? 0,
      bookClosing: (ledger) => closingOf.get(canonicalKey(ledger)) ?? 0,
      additionalDepreciationEligible: (ledger) =>
        operator.assetClass.find((a) => canon(a.ledger) === canon(ledger))
          ?.additionalDepreciation ?? false,
    };
    const input: DepAnalyzeInput = {
      ledgerRows: inScope.map((l) => ({ ledger: l, rows: rowsByLedger(pass2.rows, l) })),
      disposalSignals: disposalLedgers.map((l) => ({ ledger: l, rows: rowsByLedger(pass1.rows, l) })),
      depreciationLedgerDebits,
    };
    const result = analyzeDepreciation(input, ctx);

    // The masked view: registry first — the REAL ledger name against each
    // finding id BEFORE anything is masked (R-MCP-4 drill-down), exactly as
    // tdsReview does — then masking. Nothing real leaves this function.
    const maskDepLedger = (ledger: string): string =>
      ledger ? maskLedgerName(ledger, groupOf(ledger), c, vault) : "";
    const maskGroup = (group: string): string =>
      c.maskPolicy(group) === "mask" ? vault.pseudonym(group, "other" satisfies GroupRole) : scrubSecrets(group);
    const findings: DepMaskedFinding[] = result.findings.map((f: DepFinding) => {
      realLedgerByFinding.set(f.id, f.ledger);
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger: maskDepLedger(f.ledger),
        block: f.block ? maskGroup(f.block) : "",
        amount: f.amount,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    const maskedResult: DepReviewResult = {
      company,
      fromDate,
      toDate,
      counts,
      findings,
      blocks: result.blocks.map((b) => ({ ...b, block: maskGroup(b.block) })),
      assets: result.assets.map((a) => ({
        ...a, ledger: maskDepLedger(a.ledger), block: maskGroup(a.block),
        notes: scrubSecrets(maskKnownNames(a.notes, vault)),
      })),
      movements: result.movements.map((m) => ({
        ...m,
        ledger: maskDepLedger(m.ledger),
        counterparty: m.counterparty ? maskDepLedger(m.counterparty) : "",
      })),
      excluded: result.excluded.map((e) => ({ ...e, ledger: maskDepLedger(e.ledger) })),
      blockResiduals: result.blockResiduals.map((r) => ({
        ...r, block: maskGroup(r.block), reason: scrubSecrets(maskKnownNames(r.reason, vault)),
      })),
      bookCharge: result.bookCharge,
      seedSource: result.seedSource,
      assetLedgers: assetLedgers.length,
      fetched: needFetch.length,
      calls: pass1.calls + pass2.calls,
    };
    return maskedResult;
  }

  /**
   * Fixed asset purchase & sale register: groups + opening/closing trial
   * balances + every asset ledger + the incidental-pattern expense ledgers
   * + the disposal-signal ledgers, all month-chunked (D5). The masked view
   * (D11) registers real ledger names against finding ids BEFORE masking,
   * and voucher numbers travel as Doc N aliases.
   */
  async function faRegister(
    company: string | undefined,
    fromDate: string,
    toDate: string,
  ): Promise<FaReviewResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;
    const [groups, opening, closing] = await Promise.all([
      d.groups(company),
      d.trialBalance(company, dayBefore(fromDate)),
      d.trialBalance(company, toDate),
    ]);
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const r of closing.rows) groupOfLedger.set(canonicalKey(r.name), r.parent);
    const rootOf = (group: string): string => c.rootOf(group) ?? "";
    const groupOf = (ledger: string): string => groupOfLedger.get(canonicalKey(ledger)) ?? "";

    const assetLedgers = closing.rows
      .filter((r) => canon(rootOf(r.parent)) === "fixed assets")
      .map((r) => r.name);
    const assetKeySet = new Set(assetLedgers.map(canonicalKey));
    const incidentalExpenseLedgers = closing.rows
      .filter(
        (r) =>
          DEP_EXPENSE_ROOTS.has(canon(rootOf(r.parent))) &&
          COST_TYPES.some((t) => COST_VOCAB[t].test(r.name)),
      )
      .map((r) => r.name);
    const disposalLedgers = closing.rows
      .filter((r) => DEP_DISPOSAL_ROOTS.has(canon(rootOf(r.parent))) && DEP_DISPOSAL_NAME.test(r.name))
      .map((r) => r.name);

    const [assetPass, incidentalPass, disposalPass] = await Promise.all([
      fetchLedgerRows(company, assetLedgers, fromDate, toDate),
      fetchLedgerRows(company, incidentalExpenseLedgers, fromDate, toDate),
      fetchLedgerRows(company, disposalLedgers, fromDate, toDate),
    ]);

    const openingOf = new Map(opening.rows.map((r) => [canonicalKey(r.name), r.balance] as const));
    const closingOf = new Map(closing.rows.map((r) => [canonicalKey(r.name), r.balance] as const));
    const ctx: FaCtx = {
      fromDate,
      toDate,
      groupOf,
      groupRootOf: (ledger) => rootOf(groupOf(ledger)),
      isAssetLedger: (ledger) => assetKeySet.has(canonicalKey(ledger)),
      bookOpening: (ledger) => openingOf.get(canonicalKey(ledger)) ?? 0,
      closingBalanceOf: (ledger) => closingOf.get(canonicalKey(ledger)) ?? 0,
    };
    const result = analyzeFaRegister(
      {
        ledgerRows: assetLedgers.map((l) => ({ ledger: l, rows: rowsByLedger(assetPass.rows, l) })),
        incidentalExpenseRows: incidentalExpenseLedgers.map((l) => ({
          ledger: l,
          rows: rowsByLedger(incidentalPass.rows, l),
        })),
        disposalSignals: disposalLedgers.map((l) => ({
          ledger: l,
          rows: rowsByLedger(disposalPass.rows, l),
        })),
      },
      ctx,
    );

    // Masked view: registry first — the REAL ledger name against each finding
    // id BEFORE anything is masked (R-MCP-4 drill-down) — then masking. Voucher
    // numbers and references become Doc N aliases: scrubSecrets would otherwise
    // eat the 12+-digit voucher ids Tally mints, and the workbook needs them back.
    const maskFaLedger = (ledger: string): string =>
      ledger ? maskLedgerName(ledger, groupOf(ledger), c, vault) : "";
    const maskGroup = (group: string): string =>
      group && c.maskPolicy(group) === "mask"
        ? vault.pseudonym(group, "other" satisfies GroupRole)
        : scrubSecrets(group);
    const maskDoc = (s: string): string => (s ? vault.pseudonym(s, "doc" satisfies GroupRole) : "");

    const findings: FaMaskedFinding[] = result.findings.map((f) => {
      realLedgerByFinding.set(f.id, f.ledger);
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger: maskFaLedger(f.ledger),
        block: maskGroup(f.block),
        amount: f.amount,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    return {
      company,
      fromDate,
      toDate,
      counts,
      purchases: result.purchases.map((p) => ({
        ...p,
        asset: maskFaLedger(p.asset),
        block: maskGroup(p.block),
        counterparty: maskFaLedger(p.counterparty),
        vendor: maskFaLedger(p.vendor),
        voucherNumber: maskDoc(p.voucherNumber),
        reference: maskDoc(p.reference),
        incidentalSummary: scrubSecrets(p.incidentalSummary),
      })),
      disposals: result.disposals.map((x) => ({
        ...x,
        asset: maskFaLedger(x.asset),
        block: maskGroup(x.block),
        counterparty: maskFaLedger(x.counterparty),
        voucherNumber: maskDoc(x.voucherNumber),
        reference: maskDoc(x.reference),
        note: scrubSecrets(maskKnownNames(x.note, vault)),
      })),
      vehicleCosts: result.vehicleCosts.map((v) => ({
        ...v,
        vehicle: maskFaLedger(v.vehicle),
        block: maskGroup(v.block),
        where: maskFaLedger(v.where),
        voucherNumber: maskDoc(v.voucherNumber),
        reference: maskDoc(v.reference),
      })),
      vendors: result.vendors.map((v) => ({
        ...v,
        vendor: maskFaLedger(v.vendor),
        vehicles: v.vehicles.map(maskFaLedger),
      })),
      findings,
      assetLedgers: assetLedgers.length,
      calls: assetPass.calls + incidentalPass.calls + disposalPass.calls,
    };
  }

  /**
   * Clause 20(b) run (design §3, Q3): the operator day book is the primary
   * books channel — it carries every voucher's complete entries, which the
   * live Ledger-Vouchers report cannot, and it costs one file read instead
   * of ~14 sequential Ledger-Vouchers calls. Live Tally is the fallback with
   * no file in hand; it is never called alongside a day book.
   */
  async function pfEsiReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    operator: OperatorPfEsi;
    dayBook?: DayBookInput;
    pfOverrides?: Partial<FundLedgers>;
  }): Promise<PfEsiReviewResult> {
    const { company, fromDate, toDate, operator } = opts;
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    if (!operator || !Array.isArray(operator.challans)) {
      throw new Error("the operator challan template did not parse — pass the filled template's path again");
    }
    lastCompany = company;

    let groups: Array<{ name: string; parent: string }>;
    let masterPairs: Array<{ name: string; parent: string }>;
    let voucherList: VoucherRow[];
    let mastersSource: "live" | "bundle" | "absent";
    if (opts.dayBook) {
      voucherList = opts.dayBook.vouchers;
      groups = opts.dayBook.groups ?? [];
      masterPairs = opts.dayBook.ledgers ?? [];
      mastersSource = opts.dayBook.ledgers ? "bundle" : "absent";
    } else {
      const [g, m, v] = await Promise.all([
        d.groups(company),
        d.ledgers(company),
        d.vouchers(company, fromDate, toDate),
      ]);
      groups = g;
      masterPairs = m;
      voucherList = v;
      mastersSource = "live";
    }
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of masterPairs) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const groupOf = (ledger: string): string =>
      groupOfLedger.get(canonicalKey(ledger)) ?? "";
    const rootOf = (ledger: string): string => c.rootOf(groupOf(ledger)) ?? "";
    const ctx: BooksContext = { groupOf, rootOf };

    // The per-call overridesPath is optional; absent, the key parsed from the
    // session's own config/overrides.json is the promised default.
    const funds = findFundLedgers(
      [...masterPairs, ...groups],
      ctx,
      opts.pfOverrides ?? overrides.pfEsiLedgers,
    );
    const isFundLedger = new Map<string, string>();
    for (const l of [...funds.pf, ...funds.esi]) {
      if (l) isFundLedger.set(canonicalKey(l), l);
    }
    const maskFundLedger = (name: string): string => {
      if (!name) return "";
      const real = isFundLedger.get(canonicalKey(name));
      if (real) return vault.pseudonym(real, "other" satisfies GroupRole);
      return maskLedgerName(name, groupOf(name), c, vault);
    };

    const { events, findings: eventsFindings } = employeeEvents(voucherList, funds, ctx);
    const { rows, findings: joinFindings } = clause20b(events, operator);
    const rawFindings = [...eventsFindings, ...joinFindings];
    // Masking: pseudonym every fund ledger first (the details quote whole
    // ledger names), register the REAL name against the finding id for
    // tb_ledger_activity drill-down (R-MCP-4), then sweep.
    for (const f of rawFindings) if (f.ledger) maskFundLedger(f.ledger);
    const findings: PfEsiMaskedFinding[] = rawFindings.map((f) => {
      if (f.ledger && isFundLedger.has(canonicalKey(f.ledger))) {
        realLedgerByFinding.set(f.id, f.ledger);
      }
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger: f.ledger ? maskFundLedger(f.ledger) : "",
        group: scrubSecrets(f.group),
        amount: f.amount,
        side: null,
        expected: null,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    lastPfEsi = rows;
    return {
      company,
      fromDate,
      toDate,
      counts,
      findings,
      rows: rows.map((r) => ({
        fund: r.fund,
        wageMonth: r.wageMonth,
        amountCollected: r.amountCollected,
        dueDate: displayDate(r.dueDate),
        amountPaid: r.amountPaid,
        paidOn: r.paidOn === null ? null : displayDate(r.paidOn),
        delayDays: r.delayDays,
        disallowed: r.disallowed,
      })),
      funds: {
        pf: funds.pf.map(maskFundLedger),
        esi: funds.esi.map(maskFundLedger),
      },
      booksSource: opts.dayBook ? "daybook-file" : "live",
      ...(opts.dayBook
        ? {
            books: {
              vouchers: voucherList.length,
              rejected: opts.dayBook.rejected,
              mastersSource,
            },
          }
        : {}),
    };
  }

  /**
   * Winman Form 3CD clause 18 (depreciation under the Income-tax Act) books
   * side (Session.dep3cdReview). Day book only: the path-only channel keeps
   * the export off the wire, and the bundle's groups/ledgers are what make an
   * asset ledger knowable — without them the review degrades to a single
   * D3CD-013, never a throw.
   */
  async function dep3cdReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBookPath: string;
    templatePath?: string;
    sourcePath?: string;
  }): Promise<Dep3cdReviewResult> {
    const { company, fromDate, toDate } = opts;
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;

    const text = await readFile(opts.dayBookPath, "utf8");
    const dayBook = readDayBook(text, { company, fromDate, toDate });
    const voucherList = dayBook.vouchers;
    const groups = dayBook.groups ?? [];
    const ledgers = dayBook.ledgers ?? [];

    const template = opts.templatePath
      ? parseDep3cdTemplate(await readFile(opts.templatePath))
      : null;

    // Block lists: workbook (read-only) > template > default.
    let blockLists: { additions: readonly string[]; deletions: readonly string[] } = DEFAULT_BLOCK_LISTS;
    let blockSource: Dep3cdReviewResult["blockSource"] = "default";
    if (opts.sourcePath) {
      const pkg = readXlsm(await readFile(opts.sourcePath));
      const additions = readListValues(pkg, "Depreciation additions", "FISTCOL");
      const deletions = readListValues(pkg, "Depreciation deletions", "DELETIONDTLS");
      if (additions.length > 0 || deletions.length > 0) {
        blockLists = { additions, deletions };
        blockSource = "workbook";
      }
    }
    if (blockSource === "default" && template?.blockLists) {
      blockLists = template.blockLists;
      blockSource = "template";
    }

    if (groups.length === 0 || ledgers.length === 0) {
      lastDep3cd = undefined;
      return {
        company,
        fromDate: displayDate(fromDate),
        toDate: displayDate(toDate),
        counts: { critical: 1, warning: 0, review: 0 },
        blockSource,
        additions: [],
        deletions: [],
        totals: { additions: 0, deletions: 0, unwrittenAdditions: 0, unwrittenDeletions: 0 },
        findings: [
          {
            id: d3cdFindingId("d3cd_masters_absent", 1),
            check: "d3cd_masters_absent",
            severity: "critical",
            ledger: "",
            amount: 0,
            detail:
              `The day-book export carries no ledger masters, so asset ledgers and their ` +
              `fixed-asset groups are unknowable: ${count(voucherList.length)} vouchers were read and no ` +
              `addition or deletion could be identified. Re-export the day book with its groups and ` +
              `ledgers and run again.`,
          },
        ],
      };
    }

    const parent = new Map<string, string>();
    for (const p of [...groups, ...ledgers]) parent.set(canonicalKey(p.name), p.parent);
    const chainOf = (name: string): string[] => {
      const out: string[] = [];
      let cur = parent.get(canonicalKey(name));
      while (cur && !cur.startsWith("\u0004") && out.length < 20) {
        out.push(canonicalKey(cur));
        cur = parent.get(canonicalKey(cur));
      }
      return out;
    };
    const fixedAssets = canonicalKey("Fixed Assets");
    const ctx: Dep3cdCtx = {
      fromDate,
      toDate,
      chainOf,
      isAssetLedger: (l) => chainOf(l).includes(fixedAssets),
      assetGroupOf: (l) => parent.get(canonicalKey(l)) ?? "",
      blockLists,
      operator: template?.operator ?? EMPTY_DEP3CD_OPERATOR,
    };

    const result = analyzeDep3cd(voucherList, ctx);

    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of ledgers) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const groupOf = (ledger: string): string => groupOfLedger.get(canonicalKey(ledger)) ?? "";

    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of result.findings) counts[f.severity] += 1;

    // Register every real ledger against its finding id BEFORE masking, as
    // faRegister does; then mask. The block text is a Winman constant and
    // passes clear. Details go through the whole-token sweep then scrubSecrets.
    for (const f of result.findings) {
      if (f.ledger) realLedgerByFinding.set(f.id, f.ledger);
    }
    const findings = result.findings.map((f) => ({
      id: f.id,
      check: f.check,
      severity: f.severity,
      ledger: f.ledger ? maskLedgerName(f.ledger, groupOf(f.ledger), c, vault) : "",
      amount: f.amount,
      detail: scrubSecrets(maskKnownNames(f.detail, vault)),
    }));

    const additions = result.additions.map((a) => ({
      ledger: maskLedgerName(a.ledger, groupOf(a.ledger), c, vault),
      block: a.block,
      purchaseDate: displayDate(a.purchaseDate),
      putToUse: displayDate(a.putToUse),
      amount: a.amount,
      secondHalf: a.secondHalf,
      parts: a.parts.length,
      orphan: a.orphan,
    }));
    const deletions = result.deletions.map((d) => ({
      ledger: maskLedgerName(d.ledger, groupOf(d.ledger), c, vault),
      block: d.block,
      date: displayDate(d.date),
      amount: d.amount,
      basis: d.basis,
      halfAdd: d.halfAdd,
      bookCredit: d.bookCredit,
    }));

    // Paperback first (raw rows, raw dates) with the block lists the writer
    // re-checks every row against.
    lastDep3cd = {
      additions: result.additions,
      deletions: result.deletions,
      blockLists,
    };

    const sum = (xs: number[]): number => round2(xs.reduce((s, x) => s + x, 0));
    return {
      company,
      fromDate: displayDate(fromDate),
      toDate: displayDate(toDate),
      counts,
      blockSource,
      additions,
      deletions,
      totals: {
        additions: sum(result.additions.map((a) => a.amount)),
        deletions: sum(result.deletions.map((d) => d.amount)),
        unwrittenAdditions: result.additions.filter((a) => a.block === null).length,
        unwrittenDeletions: result.deletions.filter((d) => d.block === null).length,
      },
      findings,
    };
  }

  /**
   * Winman 3CD clause 31 (l.269SS/l.269T) and l.269ST books side
   * (Session.loansReview, task-6). Source: day-book primary by absolute path
   * (the path-only channel: the gateway reads the file, nothing rides the
   * session), else live `d.groups/d.ledgers/d.vouchers` — mirrored from
   * pfEsiReview. The day-book loader is readDayBook: it validates company
   * and period coverage before any engine work.
   */
  async function loansReview(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBookPath?: string;
    templatePath?: string;
    overridesPath?: string;
  }): Promise<LoansReviewResult> {
    const { company, fromDate, toDate } = opts;
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    if (opts.overridesPath) {
      console.error(
        "tally-agent: overridesPath is accepted for interface parity with pfEsiReview but carries no loans-specific key yet — ignored",
      );
    }
    lastCompany = company;

    let groups: Array<{ name: string; parent: string }>;
    let masterPairs: Array<{ name: string; parent: string; openingBalance?: number | null }>;
    let voucherList: VoucherRow[];
    let mastersSource: "bundle" | "live" | "absent";
    if (opts.dayBookPath) {
      const text = await readFile(opts.dayBookPath, "utf8");
      const dayBook = readDayBook(text, { company, fromDate, toDate });
      voucherList = dayBook.vouchers;
      groups = dayBook.groups ?? [];
      masterPairs = dayBook.ledgers ?? [];
      mastersSource = dayBook.ledgers?.length ? "bundle" : "absent";
    } else {
      const [g, m, v] = await Promise.all([
        d.groups(company),
        d.ledgers(company),
        d.vouchers(company, fromDate, toDate),
      ]);
      groups = g;
      masterPairs = m;
      voucherList = v;
      mastersSource = "live";
    }
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of masterPairs) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const groupOf = (ledger: string): string =>
      groupOfLedger.get(canonicalKey(ledger)) ?? "";

    // Addendum 2 (2026-09-26): master identity facts for row pre-fill. PAN
    // precedence: master PAN, else derived from the master GSTIN; address
    // keeps its case. The live path enriches from the verbose ledgers export
    // (degrades silently — PAN/address are best-effort pre-fill only).
    const masterFacts = new Map<string, { pan?: string; address?: string }>();
    const putFact = (pair: { name: string; pan?: string | null; gstin?: string | null; address?: string | null }): void => {
      const key = canonicalKey(pair.name);
      if (key === "") return;
      const pan =
        pair.pan && PAN_SHAPE.test(pair.pan.toUpperCase())
          ? pair.pan.toUpperCase()
          : panFromGstin(pair.gstin ?? null);
      const address = pair.address && pair.address.trim() !== "" ? pair.address.trim() : null;
      if (pan || address) {
        masterFacts.set(key, {
          ...(pan ? { pan } : {}),
          ...(address ? { address } : {}),
        });
      }
    };
    for (const l of masterPairs) putFact(l);
    if (!opts.dayBookPath) {
      try {
        for (const l of await d.ledgersTax(company)) putFact(l);
      } catch {
        console.error("tally-agent: verbose ledger masters unavailable for loans PAN/address pre-fill (degraded)");
      }
    }

    const template = opts.templatePath
      ? parseLoansTemplate(await readFile(opts.templatePath))
      : null;
    const operator: LoansOperator = template
      ? {
          parties: template.parties,
          ...(template.defaultBankMode ? { defaultBankMode: template.defaultBankMode } : {}),
          specifiedSums: template.specifiedSums,
          st26Declarations: template.st26Declarations,
        }
      : EMPTY_LOANS_OPERATOR;

    // Vault every operator-held identity before any row or detail is touched:
    // PAN/Aadhaar as tax_id aliases, addresses as other-role aliases (whole
    // values in, pseudonyms out — the aliases later ride the masked rows and
    // the sweep, and lastLoansVault lets write3cdLoans resolve them back).
    for (const p of template?.parties ?? []) {
      if (p.panOrAadhaar) vault.pseudonym(p.panOrAadhaar, "tax_id");
      if (p.address) vault.pseudonym(p.address, "other");
    }
    for (const r of template?.specifiedSums ?? []) {
      if (r.panAlias) vault.pseudonym(r.panAlias, "tax_id");
      if (r.address) vault.pseudonym(r.address, "other");
    }

    const ctx = buildLoansCtx(masterPairs, groups);
    const events = loanLedgerEvents(voucherList, ctx);

    // Addendum 3 (2026-09-26): opening balances feed MAXAMOUNT. The caller
    // resolves each loan ledger's opening into the loan-liability OUTSTANDING
    // (positive = money owed) with the flip at this seam. The BUNDLE carries
    // the raw Tally master sign (negative = debit, the M1 convention — a
    // liability's credit opening is therefore POSITIVE here), so the
    // outstanding is the raw value itself (fix 2026-09-26, 009: negating it
    // inverted every opening and understated MAXAMOUNT by 2× the opening).
    // The LIVE trial balance row is already gateway-flipped (positive =
    // debit), so a credit balance arrives negative and IS negated here.
    const openings = new Map<string, number>();
    const openingKeyOf = (name: string): string => {
      const key = canonicalKey(name);
      if (key === "" || ctx.isBankOdLoan(name) || !ctx.isLoanLedger(name)) return "";
      return key;
    };
    for (const l of masterPairs) {
      if (typeof l.openingBalance !== "number" || !Number.isFinite(l.openingBalance)) continue;
      const key = openingKeyOf(l.name);
      if (key === "") continue;
      openings.set(key, l.openingBalance);
    }
    if (!opts.dayBookPath) {
      try {
        const tb = await d.trialBalance(company, dayBefore(fromDate));
        for (const row of tb.rows) {
          if (typeof row.balance !== "number" || !Number.isFinite(row.balance)) continue;
          const key = openingKeyOf(row.name);
          if (key === "") continue;
          openings.set(key, -row.balance);
        }
      } catch {
        console.error("tally-agent: opening trial balance unavailable for loans MAXAMOUNT (degraded, estimated)");
      }
    }

    const books = buildLoansRows(events, operator, {
      mastersPresent: mastersSource !== "absent",
      // Addendum 2 (2026-09-26): auto-exempt bank lenders / OD-OCC ancestry
      // where the operator template has not spoken; the rows engine resolves
      // op.exempt/exemptNot precedence itself.
      autoExempt: loanAutoExemptNames(masterPairs, groups),
      masterFacts,
      openings,
    });
    // Called ONCE per run: the per-scan ordinal state lives inside scan269St.
    const st = scan269St(voucherList, ctx, operator, events);

    // Honest absence: a day-book bundle without its ledger masters cannot
    // even discover loan ledgers (no chains) — the run proceeds over the
    // vouchers but reports the gap under the allocated loans_party_unmastered
    // id instead of silently returning an all-empty review (R-MCP-4 analog).
    const unmasteredFinding: Finding | null =
      mastersSource === "absent" && voucherList.length > 0
        ? {
            id: findingId("loans_party_unmastered", 1),
            check: "loans_party_unmastered",
            severity: "warning",
            ledger: "",
            group: "",
            amount: 0,
            side: null,
            expected: null,
            detail:
              `The day-book export carries no ledger masters, so loan-ledger discovery and ` +
              `cash/bank ancestry are unavailable: ${count(voucherList.length)} vouchers were read and the ` +
              `clause-31/269ST scans could not identify any loan ledger. Re-export the day book ` +
              `with its groups and ledgers and run again.`,
          }
        : null;
    const rawFindings: Finding[] = [
      ...(unmasteredFinding ? [unmasteredFinding] : []),
      ...books.findings,
      ...st.findings,
    ];

    const rawSheets: Record<LoansSheetName, LoansSheetRow[]> = {
      sheet1: books.sheet1,
      sheet2: books.sheet2,
      sheet3: books.sheet3,
      sheet4: books.sheet4,
      sheet5: books.sheet5,
      sheet6: st.sheet6,
      sheet7: st.sheet7,
    };

    // Loan parties (both scans) vault as the real name, "other" role;
    // everything that is not a loan party masks through the same classifier
    // rule maskLedgerName applies everywhere else.
    const loanPartyReal = new Map<string, string>();
    for (const e of events) {
      if (!loanPartyReal.has(canonicalKey(e.party))) {
        loanPartyReal.set(canonicalKey(e.party), e.party);
      }
    }
    for (const p of operator.parties) {
      if (!loanPartyReal.has(canonicalKey(p.ledger))) {
        loanPartyReal.set(canonicalKey(p.ledger), p.ledger);
      }
    }
    for (const r of [...rawSheets.sheet2, ...rawSheets.sheet7]) {
      if (r.party && !loanPartyReal.has(canonicalKey(r.party))) {
        loanPartyReal.set(canonicalKey(r.party), r.party);
      }
    }
    const maskLoanName = (name: string): string => {
      if (!name) return "";
      const real = loanPartyReal.get(canonicalKey(name));
      if (real) return vault.pseudonym(real, "other" satisfies GroupRole);
      return maskLedgerName(name, groupOf(name), c, vault);
    };

    // PSEUDONYM EVERY LOAN PARTY FIRST — the pfEsi "mask every fund ledger
    // before any sweep" pattern: a row's narration/nature can quote a
    // DIFFERENT loan party than its own, and maskKnownNames only substitutes
    // names vaulted so far, so vaulting inside maskRow would let a later
    // party's real name leak through an already-swept string.
    // Parties with NO movements too: the quoted ledger can own no vouchers
    // whatsoever, but it is still a loan ledger in the masters — vault every
    // loan-ledger master the ctx can identify.
    for (const real of loanPartyReal.values()) {
      vault.pseudonym(real, "other" satisfies GroupRole);
    }
    for (const m of masterPairs) {
      if (ctx.isLoanLedger(m.name)) vault.pseudonym(m.name, "other" satisfies GroupRole);
    }

    // Order matters: PSEUDONYM FIRST (party names quoted whole in details),
    // then the whole-token sweep over free text, then scrubSecrets behind it.
    for (const f of rawFindings) {
      if (f.ledger) {
        realLedgerByFinding.set(f.id, f.ledger);
        maskLoanName(f.ledger);
      }
    }
    const findings: Finding[] = rawFindings.map((f) => ({
      id: f.id,
      check: f.check,
      severity: f.severity,
      ledger: f.ledger ? maskLoanName(f.ledger) : "",
      group: scrubSecrets(f.group),
      amount: f.amount,
      side: null,
      expected: null,
      detail: scrubSecrets(maskKnownNames(f.detail, vault)),
    }));

    const maskRow = (r: LoansSheetRow): LoansSheetRow => {
      // model side never carries the raw address; the raw cache keeps it.
      const { address: _dropped, ...rest } = r;
      const out: LoansSheetRow = { ...rest, party: maskLoanName(r.party) };
      // PanAlias from the template rows may still hold the RAW operator value
      // (see the LoansSheetRow contract): ride the tax_id alias onward.
      if (r.panAlias) out.panAlias = vault.pseudonym(r.panAlias, "tax_id");
      if (r.date) out.date = displayDate(r.date);
      // Free text (nature = voucher narration) gets the same sweep as details.
      if (r.nature) out.nature = scrubSecrets(maskKnownNames(r.nature, vault));
      return out;
    };
    const maskedSheets: Record<LoansSheetName, LoansSheetRow[]> = {
      sheet1: rawSheets.sheet1.map(maskRow),
      sheet2: rawSheets.sheet2.map(maskRow),
      sheet3: rawSheets.sheet3.map(maskRow),
      sheet4: rawSheets.sheet4.map(maskRow),
      sheet5: rawSheets.sheet5.map(maskRow),
      sheet6: rawSheets.sheet6.map(maskRow),
      sheet7: rawSheets.sheet7.map(maskRow),
    };

    // Paperback first (raw, unmasked, raw dates), then the vault snapshot so
    // write3cdLoans can resolve every alias back to its real value.
    lastLoansSheets = rawSheets;
    lastLoansVault = vault.entries();

    const sheets: Record<LoansSheetName, number> = {
      sheet1: maskedSheets.sheet1.length,
      sheet2: maskedSheets.sheet2.length,
      sheet3: maskedSheets.sheet3.length,
      sheet4: maskedSheets.sheet4.length,
      sheet5: maskedSheets.sheet5.length,
      sheet6: maskedSheets.sheet6.length,
      sheet7: maskedSheets.sheet7.length,
    };

    return {
      company,
      fromDate,
      toDate,
      findings,
      rows: LOANS_SHEET_NAMES.flatMap((n) => maskedSheets[n]),
      sheets,
      mastersSource,
      sectionSummary: LOANS_SHEET_NAMES.map(
        (n) => `${LOANS_SHEET_LABELS[n]}: ${sheets[n]} rows`,
      ),
    };
  }

  /**
   * Rewrite the P.F. / E.S.I. sheets of a Winman 3CD COPY from the cached
   * review's rows (§2.3 + §3 column sourcing). The source is read once and
   * never written; the copy lands beside `outPath` (the report directory by
   * caller default) under `<stem> - filled - <today>.xlsm`. The sheet
   * columns are two dates and two numbers — no vault-held name exists in
   * them, so de-masking has nothing to restore by construction.
   */
  async function write3cdPfEsi(opts: { sourcePath: string; outPath?: string }): Promise<string> {
    if (!lastPfEsi || lastPfEsi.length === 0) {
      throw new Error("run tb_pf_esi_review first: there are no PF/ESI clause 20(b) rows to write");
    }
    const pkg = readXlsm(await readFile(opts.sourcePath));
    // The handshake is the only reliable Winman discriminator; asserting it
    // (and the form id on both writable sheets) refuses anything else loudly.
    readHandshake(pkg);
    for (const sheetName of ["P.F.", "E.S.I."]) {
      const schema = readSchema(pkg, sheetName);
      if (schema.formId !== "EmployeePFESIfunds") {
        throw new Error(
          `${sheetName} belongs to form "${schema.formId || "unknown"}": this tool fills the Winman EmployeePFESIfunds workbook`,
        );
      }
    }
    const byFund: Record<FundKey, WinmanRow[]> = {
      PF: [],
      ESI: [],
    };
    for (const r of [...lastPfEsi].sort((a, b) => (a.wageMonth < b.wageMonth ? -1 : 1))) {
      byFund[r.fund].push({
        DUEDATE: { kind: "date", ymd: r.dueDate },
        ...(r.paidOn !== null ? { PAIDON: { kind: "date", ymd: r.paidOn } } : {}),
        ...(r.amountPaid !== null ? { AMOUNTPAID: { kind: "number", value: r.amountPaid } } : {}),
        AMOUNTCOLLECTED: { kind: "number", value: r.amountCollected },
      });
    }
    let out = pkg;
    for (const fund of ["PF", "ESI"] as const) {
      if (byFund[fund].length > 0) out = writeSheetRows(out, lawFor(fund).sheet, byFund[fund]);
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    // Copying onto the source would destroy the operator's template before
    // its contents were used; both entries are resolved through their real
    // paths where they exist so a dot-dotted outPath cannot slip past.
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    return target;
  }

  /**
   * Rewrite the five TDS/TCS clause-34 sheets of a Winman 3CD COPY from the
   * cached review's row slice (tds3cdResult, §clause-34 mapping). The source
   * is read once and never written; the copy lands beside `outPath` exactly
   * as write3cdPfEsi does. The sheet carries the operator TAN and company
   * name — data channels of the workbook itself, like the written report.
   */
  async function write3cdTdsTcs(opts: { sourcePath: string; outPath?: string }): Promise<string> {
    if (!lastTds3cd) {
      throw new Error("run tb_tds_review first: there is no TDS/TCS clause-34 slice to write");
    }
    if (lastWinmanNameMissing) {
      throw new Error(
        "the Winman TDS summary has no Deductor name (label \"Name\" or \"Name as per department records\") — the 3CD sheets need it",
      );
    }
    const { tan, deductor, tds, tcs, returns, interestTds, interestTcs } = lastTds3cd;
    const pkg = readXlsm(await readFile(opts.sourcePath));
    readHandshake(pkg);
    const quarterNo: Record<Tds3cdResult["returns"][number]["quarter"], number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
    const t = (value: string) => ({ kind: "text" as const, value });
    const n = (value: number) => ({ kind: "number" as const, value });
    const d = (ymd: string) => ({ kind: "date" as const, ymd });
    const tanCell = tan ? t(tan) : null;
    const tdsRows: WinmanRow[] = tds.map((r) => ({
      DEDUCTOR: t(r.deductor),
      TAN: tanCell,
      TDS: t(r.section),
      NATUREOFPAYMENT: t(r.nature),
      TOTALPAYMENTS: n(r.totalPayments),
      TDSSUMLIABLE: n(r.sumLiable),
      TDSATRATESUMLIABLE: n(r.atRateLiable),
      TDSATRATETDS: n(r.atRateTds),
      TDSATMINRATESUMLIABLE: n(r.lowerRateLiable),
      TDSATMINRATETDS: n(r.lowerRateTds),
      TDSDEDUCTED: n(r.notDeposited),
    }));
    const tcsRows: WinmanRow[] = tcs.map((r) => ({
      COLLECTOR: t(r.collector),
      TAN: tanCell,
      NATUREOFRECEIPT: t(r.nature),
      TOTALRECIEPT: n(r.totalReceipt),
      TCSSUMLIABLE: n(r.sumLiable),
      TCSATRATESUMLIABLE: n(r.atRateLiable),
      TCSATRATETDS: n(r.atRateTcs),
      TCSATMINRATESUMLIABLE: n(r.lowerRateLiable),
      TCSATMINRATETDS: n(r.lowerRateTcs),
      TCSCOLLECTED: n(r.notDeposited),
    }));
    const returnRows: WinmanRow[] = returns.map((r) => ({
      DEDUCTOR: t(r.deductor),
      TAN: tanCell,
      FORMNO: t(r.form),
      QUARTER: n(quarterNo[r.quarter]),
      DUEDATE: d(r.dueDate),
      DATEOFFILING: d(r.filedOn),
      RETURNACCURATE: t(r.accurate),
    }));
    const interestTdsRows: WinmanRow[] = interestTds.map((r) => ({
      DEDUCTOR: t(deductor),
      TAN: tanCell,
      FORMNO: t(r.form),
      QUARTER: n(quarterNo[r.quarter]),
      INTERESTPAYABLE: n(r.payable),
      ...(r.paid !== undefined ? { INTERESTPAID: n(r.paid) } : {}),
      ...(r.paidOn ? { DATEOFPAYMENT: d(r.paidOn) } : {}),
    }));
    const interestTcsRows: WinmanRow[] = interestTcs.map((r) => ({
      COLLECTOR: t(deductor),
      TAN: tanCell,
      FORMNO: t("27EQ"),
      QUARTER: n(quarterNo[r.quarter]),
      INTERESTPAYABLE: n(r.payable),
      ...(r.paid !== undefined ? { INTERESTPAID: n(r.paid) } : {}),
      ...(r.paidOn ? { DATEOFPAYMENT: d(r.paidOn) } : {}),
    }));
    const sheets: Array<[string, WinmanRow[]]> = [
      ["TDS", tdsRows],
      ["TCS", tcsRows],
      ["Return details", returnRows],
      ["Interest on TDS", interestTdsRows],
      ["Interest on TCS", interestTcsRows],
    ];
    let out = pkg;
    for (const [sheetName, rows] of sheets) {
      if (rows.length === 0) continue;
      let schema: ReturnType<typeof readSchema>;
      try {
        schema = readSchema(out, sheetName);
      } catch (e) {
        // The workbook may omit a sheet the operator has nothing to fill
        // (the TCS sheet over a TDS-only year); every other schema defect
        // still throws.
        if (e instanceof Error && /no sheet named/.test(e.message)) continue;
        throw e;
      }
      if (schema.formId !== "3cdTDS") {
        throw new Error(
          `${sheetName} belongs to form "${schema.formId || "unknown"}": this tool fills the Winman 3cdTDS workbook`,
        );
      }
      out = writeSheetRows(out, sheetName, rows);
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    return target;
  }

  /**
   * Rewrite the clause-31 / 269ST sheets of a Winman 3CD COPY from the cached
   * loans review's raw rows (write3cdPfEsi mechanics; design of record §2 of
   * the loans 269SS/T/ST plan). Unlike PF/ESI's date+number-only sheets, these
   * carry text columns: the workbook is an on-disk operator artifact and
   * carries REAL names/addresses/mode tokens — every vault alias in the raw
 * rows is resolved back through the cached vault snapshot (the 26AS-template
 * write-side precedent). Only non-empty sheets are written; an empty sheet's
 * pre-existing machinery rows stay untouched, and a sheet the workbook does
 * not carry at all is skipped (a workbook with none of the seven refuses).
 */
  async function write3cdLoans(opts: {
    sourcePath: string;
    outPath?: string;
  }): Promise<{ written: string }> {
    if (!lastLoansSheets) {
      throw new Error("run tb_loans_review first: there are no clause-31/269ST rows to write");
    }
    const rowsBySheet = lastLoansSheets;
    const hasRows = LOANS_SHEET_NAMES.some((n) => (rowsBySheet[n]?.length ?? 0) > 0);
    if (!hasRows) {
      throw new Error("run tb_loans_review first: there are no clause-31/269ST rows to write");
    }
    // Alias -> real: the raw cache's aliases (party names, PAN/Aadhaar,
    // addresses) resolve back to the operator's real values here.
    const realByAlias = new Map<string, string>();
    for (const { alias, real } of lastLoansVault ?? []) realByAlias.set(alias, real);
    const demask = (alias: string | undefined): string | undefined => {
      if (alias === undefined) return undefined;
      const real = realByAlias.get(alias);
      return real !== undefined ? real : alias;
    };

    const pkg = readXlsm(await readFile(opts.sourcePath));
    // The handshake is the only reliable Winman discriminator; asserting it
    // (and the loans form id on every writable sheet) refuses anything else
    // loudly, exactly as write3cdPfEsi does.
    readHandshake(pkg);
    const sheetNameOf: Record<LoansSheetName, string> = {
      sheet1: "Sec.269SS Loans & Deposits",
      sheet2: "Sec.269SS Specified sums",
      sheet3: "sec.269T",
      sheet4: "Sec.269T Repayments Others",
      sheet5: "Sec.269T Repayments Cheque & DD",
      sheet6: "Sec.269ST_others",
      sheet7: "Sec.269ST_Cheque & DD",
    };

    let out = pkg;
    let wroteAny = false;
    for (const name of LOANS_SHEET_NAMES) {
      const rows = rowsBySheet[name] ?? [];
      if (rows.length === 0) continue;
      const sheetName = sheetNameOf[name];
      // A Winman loans workbook can carry fewer clause-31 sheets than the
      // review produced rows for; a sheet the workbook does not carry is not
      // writable, and refusing the whole fill for it would strand every other
      // sheet's rows. Skip it — the wroteAny guard below still refuses the
      // degenerate workbook that carries none of the seven sheets at all.
      if (findSheetPart(pkg, sheetName) === undefined) {
        console.error(
          `tally-agent: loans sheet ${sheetName} not found in the source workbook — ` +
            `${rows.length} cached rows not written`,
        );
        continue;
      }
      const schema = readSchema(pkg, sheetName);
      if (schema.formId !== "269SS/269T_LoansAc/RpinCash") {
        throw new Error(
          `${sheetName} belongs to form "${schema.formId || "unknown"}": this tool fills the Winman 269SS/269T/269ST loans workbook`,
        );
      }
      const winmanRows: WinmanRow[] = rows.map((r) => {
        // write3cdPfEsi's cell-skip convention: an optional cell is written
        // only when the row actually carries it — a defined-but-empty text
        // value (e.g. bearer: "") omits the cell instead of writing an empty
        // inlineStr. NAME/AMOUNT are the sheet's required cells; MAXAMOUNT
        // and DATE are numbers/dates, where "defined" is the meaningful test.
        const cells: WinmanRow = {
          NAME: { kind: "text", value: demask(r.party) ?? "" },
          AMOUNT: { kind: "number", value: Math.round(r.amount * 100) / 100 },
          ...(r.panAlias && schema.keys.has("PANORAADHAAR")
            ? { PANORAADHAAR: { kind: "text", value: demask(r.panAlias) ?? "" } }
            : {}),
          ...(r.squaredUp && schema.keys.has("SQUAREDUP")
            ? { SQUAREDUP: { kind: "text", value: r.squaredUp } }
            : {}),
          ...(r.maxAmount !== undefined && schema.keys.has("MAXAMOUNT")
            ? { MAXAMOUNT: { kind: "number", value: Math.round(r.maxAmount * 100) / 100 } }
            : {}),
          ...(r.mode && schema.keys.has("RECEIPT")
            ? { RECEIPT: { kind: "text", value: r.mode } }
            : {}),
          ...(r.nonAcMode && schema.keys.has("RECIEPTNONAC")
            ? { RECIEPTNONAC: { kind: "text", value: r.nonAcMode } }
            : {}),
          ...(r.type && schema.keys.has("TYPEOFTRANSACTION")
            ? { TYPEOFTRANSACTION: { kind: "text", value: r.type } }
            : {}),
          ...(r.date !== undefined && schema.keys.has("DATE")
            ? { DATE: { kind: "date", ymd: String(r.date) } }
            : {}),
          ...(r.nature && schema.keys.has("NATUREOFTRANSACTION")
            ? { NATUREOFTRANSACTION: { kind: "text", value: r.nature } }
            : {}),
          ...(r.bearer && schema.keys.has("BEARER")
            ? { BEARER: { kind: "text", value: r.bearer } }
            : {}),
          ...(r.address && schema.keys.has("ADDRESS")
            ? { ADDRESS: { kind: "text", value: demask(r.address) ?? "" } }
            : {}),
        };
        return cells;
      });
      out = writeSheetRows(out, sheetName, winmanRows);
      wroteAny = true;
    }
    if (!wroteAny) {
      throw new Error("the workbook carries none of the Sec.269SS/269T/269ST sheets this tool fills");
    }

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    // Copying onto the source would destroy the operator's template before
    // its contents were used; both entries are resolved through their real
    // paths where they exist so a dot-dotted outPath cannot slip past.
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    return { written: target };
  }

  /**
   * Clause 44 run (design §4, Decision 2): vouchers come from the operator
   * day book when given, else live; the narrow ledgersTax GSTIN channel is
   * always called live and degrades to template-only status resolution. The
   * masking recipe is pfEsiReview's: pseudonym every party first (a creditor
   * name under a clear-rooted group still masks because the vault alias
   * exists), register real names for drill-down, then sweep every detail.
   */
  async function gst44Review(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    operator: OperatorGst44;
    dayBook?: DayBookInput;
  }): Promise<Gst44ReviewResult> {
    const { company, fromDate, toDate } = opts;
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;

    let groups: Array<{ name: string; parent: string }>;
    let masterPairs: Array<{ name: string; parent: string }>;
    let voucherList: VoucherRow[];
    let mastersSource: "live" | "bundle" | "absent";
    if (opts.dayBook) {
      voucherList = opts.dayBook.vouchers;
      groups = opts.dayBook.groups ?? [];
      masterPairs = opts.dayBook.ledgers ?? [];
      mastersSource = opts.dayBook.ledgers ? "bundle" : "absent";
    } else {
      const [g, m, v] = await Promise.all([
        d.groups(company),
        d.ledgers(company),
        d.vouchers(company, fromDate, toDate),
      ]);
      groups = g;
      masterPairs = m;
      voucherList = v;
      mastersSource = "live";
    }
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of masterPairs) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const groupOf = (ledger: string): string =>
      groupOfLedger.get(canonicalKey(ledger)) ?? "";
    const rootOf = (ledger: string): string => c.rootOf(groupOf(ledger)) ?? "";

    // Decision 2: the day book carries no GSTINs, so the narrow M2 tax-ID
    // channel is called live even beside a day book; a failure degrades to
    // template-only (hard error below when that is not enough).
    let gstinSource: "live" | "none" = "live";
    let ledgersTaxInfo: LedgerTaxInfo[] = [];
    try {
      ledgersTaxInfo = await d.ledgersTax(company);
      if (ledgersTaxInfo.length === 0) gstinSource = "none";
    } catch {
      gstinSource = "none";
    }
    const gstinByLedger = new Map<string, string>();
    for (const l of ledgersTaxInfo) {
      if (l.gstin && !gstinByLedger.has(canonicalKey(l.name))) {
        gstinByLedger.set(canonicalKey(l.name), l.gstin);
      }
    }
    const ctx: GstCtx = {
      groupOf,
      rootOf: (group) => c.rootOf(group),
      roleOf: (group) => c.role(group),
      inDutiesAndTaxes: (group) =>
        c.ancestry(group).some((g) => canonicalKey(g) === "duties & taxes"),
      gstinOf: (ledger) => gstinByLedger.get(canonicalKey(ledger)) ?? null,
    };

    const books = gst44(voucherList, ctx, opts.operator);

    // Never fabricate a break-up: with no GSTIN evidence, every spend-carrying
    // party must be covered by an operator status (Decision 1.3).
    if (gstinSource === "none") {
      const needing = books.parties.filter((p) => partySpend(p) > 0 && !p.override);
      if (needing.length > 0) {
        throw new Error(
          `no supplier GST-status evidence: Tally is unreachable for ledger GSTINs and the operator template names none of ` +
            `${needing.length} expenditure parties - start Tally or fill the GST Status sheet (tb_write_gst44_template)`,
        );
      }
    }

    // Operator statuses naming unknown ledgers (warning; the typed name is
    // pseudonymized below like every other real name).
    const rawFindings = [...books.findings];
    let unknownN = 0;
    for (const s of opts.operator.statuses) {
      if (masterPairs.length > 0 && !groupOfLedger.has(canonicalKey(s.ledger))) {
        unknownN += 1;
        rawFindings.push({
          id: findingId("gst44_status_override_unknown_ledger", unknownN),
          check: "gst44_status_override_unknown_ledger",
          severity: "warning",
          ledger: s.ledger,
          group: "",
          amount: null,
          detail: `the GST Status sheet names a ledger that is not in the masters; its row was ignored`,
        });
      }
    }

    // Masking: the pfEsiReview recipe — pseudonym every party first, register
    // the real name for drill-down, then sweep.
    const partyNames = new Set<string>();
    for (const f of rawFindings) if (f.ledger) partyNames.add(f.ledger);
    for (const p of books.parties) partyNames.add(p.party);
    for (const name of partyNames) vault.pseudonym(name, "other" satisfies GroupRole);
    const findings: Gst44MaskedFinding[] = rawFindings.map((f) => {
      if (f.ledger) realLedgerByFinding.set(f.id, f.ledger);
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger: f.ledger ? maskLedgerName(f.ledger, groupOf(f.ledger), c, vault) : "",
        group: scrubSecrets(f.group),
        amount: f.amount,
        side: null,
        expected: null,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    lastGst44 = books.rows;
    return {
      company,
      fromDate,
      toDate,
      counts,
      findings,
      rows: books.rows.map((r) => ({
        label: r.label, total: r.total, exempt: r.exempt,
        composition: r.composition, others: r.others, unregistered: r.unregistered,
      })),
      parties: books.parties.map((p) => ({
        party: maskLedgerName(p.party, p.group, c, vault),
        override: p.override,
        ambiguous: p.ambiguous,
        capital: p.capital,
        revenue: p.revenue,
      })),
      gstinSource,
      booksSource: opts.dayBook ? "daybook-file" : "live",
      confirms: GST44_CONFIRMS,
      ...(opts.dayBook
        ? { books: { vouchers: voucherList.length, rejected: opts.dayBook.rejected, mastersSource } }
        : {}),
    };
  }

  /**
   * Rewrite the "Break-up of GST expenditure" sheet of a Winman 3CD COPY.
   * Both rows are written always, zeros included: writeSheetRows replaces rows
   * at or after the first data row wholesale, so the sheet's pre-filled labels
   * are re-written by us. The sheet columns are a text label and five numbers —
   * no vault-held name exists in them, so de-masking has nothing to restore
   * by construction.
   *
   * Two sources, mutually exclusive by what the caller passes (captain's
   * addendum 2026-09-27, Q-F approval flow):
   * - `worksheetPath`: the operator's APPROVED GST nature-wise break-up
   *   working sheet (tb_write_gst_working_sheet). Its per-ledger treatments are
   *   the authority; readWorksheetTotals recomputes the two clause-44 rows from
   *   its literal cells. This is the flow when the operator edits the sheet.
   * - otherwise: the cached tb_gst44_review rows (mirror of write3cdPfEsi).
   */
  async function write3cdGst44(opts: {
    sourcePath: string;
    outPath?: string;
    worksheetPath?: string;
  }): Promise<string> {
    let clauseRows: Gst44Row[];
    if (opts.worksheetPath) {
      clauseRows = readWorksheetTotals(await readFile(opts.worksheetPath));
    } else {
      if (!lastGst44 || lastGst44.length === 0) {
        throw new Error("run tb_gst44_review first: there are no clause 44 rows to write");
      }
      clauseRows = lastGst44;
    }
    const pkg = readXlsm(await readFile(opts.sourcePath));
    // The handshake is the only reliable Winman discriminator; asserting it
    // (and the form id on the writable sheet) refuses anything else loudly.
    readHandshake(pkg);
    const schema = readSchema(pkg, GST44_SHEET);
    if (schema.formId !== GST44_FORM_ID) {
      throw new Error(
        `"${GST44_SHEET}" belongs to form "${schema.formId || "unknown"}": this tool fills the Winman ${GST44_FORM_ID} workbook`,
      );
    }
    const rows: WinmanRow[] = clauseRows.map((r) => ({
      PARTICULARS: { kind: "text", value: r.label },
      TOTALEXPENDITURE: { kind: "number", value: r.total },
      TOWARDSSUPPLIES: { kind: "number", value: r.exempt },
      COMPOSITIONSUPPLIER: { kind: "number", value: r.composition },
      OTHERS: { kind: "number", value: r.others },
      REGISTEREDUNDERGST: { kind: "number", value: r.unregistered },
    }));
    const out = writeSheetRows(pkg, GST44_SHEET, rows);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    // Copying onto the source would destroy the operator's template before
    // its contents were used; both entries are resolved through their real
    // paths where they exist so a dot-dotted outPath cannot slip past.
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    return target;
  }

  /**
   * The GST nature-wise break-up WORKING SHEET (captain's addendum
   * 2026-09-26, Phase B). Vouchers and masters come from the operator day
   * book (required: a bundle whose ledgers[] carry the groups the
   * classification and masking walk); GSTINs come from the bundle's masters
   * first, live ledgersTax filling gaps — either source may be absent, which
   * degrades party evidence rather than aborting, because the operator
   * reviews and corrects every seeded row before approval. The workbook on
   * disk carries real ledger names; everything returned here is masked by
   * the gst44Review recipe.
   */
  async function writeGstWorksheet(opts: {
    company?: string;
    fromDate: string;
    toDate: string;
    dayBook: DayBookInput;
    priorYear?: Buffer;
    rulesPath?: string;
    outPath: string;
  }): Promise<GstWorksheetWriteResult> {
    const { company, fromDate, toDate } = opts;
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || fromDate > toDate) {
      throw new Error("fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;
    if (extname(opts.outPath).toLowerCase() === ".json") {
      throw new Error("the outPath must name the .xlsx working sheet to write, not a data file");
    }

    const groups = opts.dayBook.groups ?? [];
    const masterPairs = opts.dayBook.ledgers ?? [];
    if (masterPairs.length === 0) {
      throw new Error(
        "the day-book file carries no ledger masters; the working sheet needs a bundle export whose ledgers[] name each ledger's group (scripts/export-daybook.mjs writes one)",
      );
    }
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of masterPairs) groupOfLedger.set(canonicalKey(l.name), l.parent);
    const groupOf = (ledger: string): string => groupOfLedger.get(canonicalKey(ledger)) ?? "";

    const gstins = new Map(opts.dayBook.ledgerGstins ?? []);
    const bundleGstins = gstins.size;
    try {
      const tax = await d.ledgersTax(company);
      for (const l of tax) {
        if (l.gstin && !gstins.has(canonicalKey(l.name))) gstins.set(canonicalKey(l.name), l.gstin);
      }
    } catch {
      // Live GSTINs are optional evidence here; the bundle (or none) stands.
    }
    const gstinSource: "bundle" | "live" | "none" =
      bundleGstins > 0 ? "bundle" : gstins.size > 0 ? "live" : "none";

    const ctx: GstCtx = {
      groupOf,
      rootOf: (group) => c.rootOf(group),
      roleOf: (group) => c.role(group),
      inDutiesAndTaxes: (group) =>
        c.ancestry(group).some((g) => canonicalKey(g) === "duties & taxes"),
      gstinOf: (ledger) => gstins.get(canonicalKey(ledger)) ?? null,
    };
    const masterNames = new Map(masterPairs.map((l) => [canonicalKey(l.name), l.name]));

    const prior = opts.priorYear ? readPriorWorksheet(opts.priorYear) : undefined;
    const warnings: string[] = [];
    const rules = await loadGst44TreatmentRules(opts.rulesPath, (m) => warnings.push(m));
    const rulesSource: "built-in" | "operator" = opts.rulesPath && warnings.length === 0 ? "operator" : "built-in";

    const result = gst44Worksheet(opts.dayBook.vouchers, ctx, { rules, prior, masterNames });

    const totalsOf = (rows: WsLedgerRow[]): GstWorksheetColumnTotals => {
      const t: GstWorksheetColumnTotals = {
        books: 0, exempt: 0, composition: 0, others: 0, unregistered: 0, notSupply: 0,
        unclassified: { count: 0, amount: 0 },
      };
      for (const r of rows) {
        t.books += r.amount;
        if (r.seed) {
          t.exempt += r.seed.d;
          t.composition += r.seed.e;
          t.unregistered += r.seed.h;
          t.notSupply += r.seed.j;
          t.others += r.amount - r.seed.d - r.seed.e - r.seed.h - r.seed.j;
        } else if (Math.abs(r.amount) > ZERO_TOLERANCE) {
          t.unclassified.count += 1;
          t.unclassified.amount += r.amount;
        }
      }
      t.books = round2(t.books);
      t.exempt = round2(t.exempt);
      t.composition = round2(t.composition);
      t.others = round2(t.others);
      t.unregistered = round2(t.unregistered);
      t.notSupply = round2(t.notSupply);
      t.unclassified.amount = round2(t.unclassified.amount);
      return t;
    };

    // Masking: the gst44Review recipe — pseudonym every named ledger first,
    // register the real names for drill-down, then sweep every detail.
    const named = new Set<string>();
    for (const f of result.findings) if (f.ledger) named.add(f.ledger);
    const unclassifiedRows = [...result.revenue, ...result.capital].filter(
      (r) => !r.seed && Math.abs(r.amount) > ZERO_TOLERANCE,
    );
    for (const r of unclassifiedRows) named.add(r.ledger);
    for (const name of named) vault.pseudonym(name, "other" satisfies GroupRole);
    const findings = result.findings.map((f) => {
      if (f.ledger) realLedgerByFinding.set(f.id, f.ledger);
      return {
        id: f.id,
        check: f.check,
        severity: f.severity,
        ledger: f.ledger ? maskLedgerName(f.ledger, groupOf(f.ledger), c, vault) : "",
        group: scrubSecrets(f.group),
        amount: f.amount,
        side: null,
        expected: null,
        detail: scrubSecrets(maskKnownNames(f.detail, vault)),
      };
    });
    const unclassified = unclassifiedRows.map((r) => ({
      ledger: maskLedgerName(r.ledger, r.group, c, vault),
      group: scrubSecrets(r.group),
      amount: round2(r.amount),
    }));

    const seedReasons: Record<string, number> = {};
    for (const r of [...result.revenue, ...result.capital]) {
      const key = r.seed ? r.seed.kind : "unclassified";
      seedReasons[key] = (seedReasons[key] ?? 0) + 1;
    }

    const buf = buildGstWorksheet({
      company,
      period: fyLabel(fromDate),
      revenueRows: result.revenue,
      capitalRows: result.capital,
      rules,
      priorYearUsed: !!opts.priorYear,
    });
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, buf);

    return {
      writePath: opts.outPath,
      company,
      fromDate,
      toDate,
      rows: { revenue: result.revenue.length, capital: result.capital.length },
      revenue: totalsOf(result.revenue),
      capital: totalsOf(result.capital),
      seedReasons,
      unclassified,
      findings,
      priorYearUsed: !!opts.priorYear,
      gstinSource,
      rulesSource,
      warnings,
    };
  }

  /**
   * Rewrite the clause-18 `Depreciation additions` / `Depreciation deletions`
   * sheets of a Winman 3CD workbook COPY from the cached depreciation review's
   * raw rows (write3cdPfEsi mechanics; design of record §2/§3). Block strings
   * are Winman constants, not sensitive, so the original-case block text is
   * written verbatim; ledger names never reach this writer. A row with no
   * resolvable block is skipped and counted; each sheet is written only when it
   * carries rows and the source is never written to.
   */
  async function write3cdDepreciation(opts: {
    sourcePath: string;
    outPath?: string;
  }): Promise<{ written: string; additions: number; deletions: number; skipped: number; notes: string[] }> {
    if (!lastDep3cd) {
      throw new Error("run tb_dep3cd_review first: there are no clause-18 rows to write");
    }
    const cache = lastDep3cd;
    const notes: string[] = [];
    const additions = cache.additions.filter((a) => a.block !== null);
    const deletions = cache.deletions.filter((d) => d.block !== null);
    const skipped =
      cache.additions.length - additions.length + (cache.deletions.length - deletions.length);
    if (additions.length === 0 && deletions.length === 0) {
      throw new Error("run tb_dep3cd_review first: there are no clause-18 rows to write");
    }

    const pkg = readXlsm(await readFile(opts.sourcePath));
    // The handshake is the only reliable Winman discriminator; asserting it
    // (and the form id on both writable sheets) refuses anything else loudly.
    readHandshake(pkg);
    for (const sheetName of ["Depreciation additions", "Depreciation deletions"]) {
      const schema = readSchema(pkg, sheetName);
      if (schema.formId !== "DepreciationNew") {
        throw new Error(
          `${sheetName} belongs to form "${schema.formId || "unknown"}": this tool fills the Winman DepreciationNew workbook`,
        );
      }
    }
    // Winman's dropdown validation is only a warning, so the writer enforces
    // the workbook's own list itself; a block text outside it would import as
    // invalid. The block text is a Winman constant and safe to echo.
    const addList = readListValues(pkg, "Depreciation additions", "FISTCOL");
    const delList = readListValues(pkg, "Depreciation deletions", "DELETIONDTLS");
    for (const a of additions) {
      if (!addList.includes(a.block!)) {
        throw new Error(
          `Depreciation additions: block "${a.block}" is not in this workbook's list; ` +
            `re-run tb_dep3cd_review with sourcePath=<this workbook>`,
        );
      }
    }
    for (const d of deletions) {
      if (!delList.includes(d.block!)) {
        throw new Error(
          `Depreciation deletions: block "${d.block}" is not in this workbook's list; ` +
            `re-run tb_dep3cd_review with sourcePath=<this workbook>`,
        );
      }
    }

    let out = pkg;
    if (additions.length > 0) {
      const rows = [...additions]
        .sort((a, b) =>
          a.purchaseDate !== b.purchaseDate
            ? a.purchaseDate < b.purchaseDate
              ? -1
              : 1
            : a.block! !== b.block!
              ? a.block! < b.block!
                ? -1
                : 1
              : a.amount - b.amount,
        )
        .map<WinmanRow>((a) => ({
          FISTCOL: { kind: "text", value: a.block! },
          DATE: { kind: "date", ymd: String(a.purchaseDate) },
          AMOUNT: { kind: "number", value: Math.round(a.amount * 100) / 100 },
          DEPRECIATION: { kind: "text", value: ADDITIONAL_DEPRECIATION_TEXT },
          TOUSE: { kind: "date", ymd: String(a.putToUse) },
        }));
      out = writeSheetRows(out, "Depreciation additions", rows);
    }
    if (deletions.length > 0) {
      const rows = [...deletions]
        .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.block! < b.block! ? -1 : 1))
        .map<WinmanRow>((d) => ({
          DELETIONDTLS: { kind: "text", value: d.block! },
          DATE: { kind: "date", ymd: String(d.date) },
          AMOUNT: { kind: "number", value: Math.round(d.amount * 100) / 100 },
          HALFADD: { kind: "text", value: d.halfAdd },
          DEPN: { kind: "text", value: DEPN_TEXT },
        }));
      out = writeSheetRows(out, "Depreciation deletions", rows);
    }

    // Excel's "~$" owner file beside the source means the workbook is open; the
    // copy still reflects its last saved state. This is not an error.
    if (existsSync(join(dirname(opts.sourcePath), "~$" + basename(opts.sourcePath)))) {
      notes.push("the source workbook is open in Excel; the copy reflects its last saved state");
    }

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    // Copying onto the source would destroy the operator's template before its
    // contents were used; both entries are resolved through their real paths
    // where they exist so a dot-dotted outPath cannot slip past.
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    return { written: target, additions: additions.length, deletions: deletions.length, skipped, notes };
  }

  /**
   * Fill the four clause 21(b) sheets of a Winman 3CD No-TDS COPY from the
   * cached noTdsReview rows (§3 of the design of record). Mirrors
   * write3cdPfEsi: handshake + per-sheet form id assertions, prototype-row
   * styles, sheets with no rows left byte-identical, and a target that can
   * never resolve to the source. The workbook copy on the operator's disk is
   * where real names and PANs belong — nothing here is masked.
   */
  async function write3cdNoTds(opts: { sourcePath: string; outPath?: string }): Promise<{ path: string; rowsBySheet: Record<NotdsSheetKey, number> }> {
    if (!lastNoTds || lastNoTds.length === 0) {
      throw new Error("run tb_notds_review first: there are no clause 21(b) rows to write");
    }
    const pkg = readXlsm(await readFile(opts.sourcePath));
    readHandshake(pkg);
    const notdsSheets: readonly NotdsSheetKey[] = [
      "40(a)(ia) to resident",
      "40(a)(i) to non-resident",
      "40(a)(ib) - Equalisation Levy",
      "40(a)(iii)",
    ];
    for (const sheetName of notdsSheets) {
      const schema = readSchema(pkg, sheetName);
      if (schema.formId !== NOTDS_FORM_ID) {
        throw new Error(
          `${sheetName} belongs to form "${schema.formId || "unknown"}": this tool fills the Winman ${NOTDS_FORM_ID} workbook`,
        );
      }
    }
    const bySheet: Record<NotdsSheetKey, WinmanRow[]> = {
      "40(a)(ia) to resident": [],
      "40(a)(i) to non-resident": [],
      "40(a)(ib) - Equalisation Levy": [],
      "40(a)(iii)": [],
    };
    for (const r of lastNoTds) {
      const done = doneKeyOf(r.sheet);
      const deposited = depositedKeyOf(r.sheet);
      const row: WinmanRow = {
        DEDUCTEENAME: { kind: "text", value: r.party },
        DATEOFPAYMENT: { kind: "date", ymd: r.date },
        [amountKeyOf(r.sheet)]: { kind: "number", value: r.amount },
        ...(done ? { [done]: { kind: "number", value: r.tdsDone } } : {}),
        ...(deposited ? { [deposited]: { kind: "number", value: r.tdsDeposited } } : {}),
        ...(r.section !== null ? { TDSSECTION: { kind: "text", value: r.section } } : {}),
        ...(r.nature !== null ? { NATUREOFPAYMENT: { kind: "text", value: r.nature } } : {}),
        ...(r.address !== null ? { ADDRESS: { kind: "text", value: r.address } } : {}),
        ...(r.city !== null ? { CITY: { kind: "text", value: r.city } } : {}),
        ...(r.state !== null ? { STATE: { kind: "text", value: r.state } } : {}),
        ...(r.pin !== null ? { PINZIP: { kind: "text", value: r.pin } } : {}),
        ...(r.country !== null ? { COUNTRY: { kind: "text", value: r.country } } : {}),
        ...(r.pan !== null ? { PANAADHAAR: { kind: "text", value: r.pan } } : {}),
      };
      bySheet[r.sheet].push(row);
    }
    let out = pkg;
    for (const sheetName of notdsSheets) {
      if (bySheet[sheetName].length > 0) out = writeSheetRows(out, sheetName, bySheet[sheetName]);
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stem = basename(opts.sourcePath, extname(opts.sourcePath));
    if (!opts.outPath) throw new Error("no output location for the filled workbook was given");
    const target =
      extname(opts.outPath).toLowerCase() === ".xlsm"
        ? opts.outPath
        : join(opts.outPath, `${stem} - filled - ${stamp}.xlsm`);
    const sourceId = await realPathId(opts.sourcePath);
    if (sourceId === (await realPathId(target))) {
      throw new Error("the outPath target resolves to the source workbook itself; write the copy somewhere else");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, writeXlsm(out));
    const rowsBySheet = Object.fromEntries(notdsSheets.map((s) => [s, bySheet[s].length])) as Record<NotdsSheetKey, number>;
    return { path: target, rowsBySheet };
  }

  /**
   * Clause 21(b) merge (design of record:
   * docs/design/2026-09-24-no-tds-disallowance-design.md §4): the books
   * candidates from the cached tb_tds_review run, cut by the operator's
   * decisions workbook — blank Include keeps, Include=N cures the row away,
   * Residency NR routes to the non-resident sheet under the operator's
   * NR-section spelling. The merged rows are cached unmasked for the Winman
   * writer; what comes back here is masked: pseudonymed parties, no PAN
   * anywhere, money()/displayDate() details. No disallowance percentage is
   * ever computed here — the sheets carry payment facts only.
   */
  async function noTdsReview(input: { templatePath?: string; operator?: NotdsOperatorFile }): Promise<NoTdsReviewResult> {
    if (!lastTdsBooks) {
      throw new Error("run tb_tds_review first: it caches the books the clause 21(b) merge reads");
    }
    const books = lastTdsBooks;
    const operator = input.templatePath
      ? parseNotdsTemplate(await readFile(input.templatePath))
      : input.operator ?? EMPTY_NOTDS_OPERATOR;

    const cands = booksCandidates(books.clause21b, books.panOf, books.panDerivedFromGstinOf);
    const rows: NoTdsRow[] = [];
    const findings: NoTdsMaskedFinding[] = [];
    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    const ords = new Map<NotdsCheckId, number>();
    const push = (
      check: NotdsCheckId,
      severity: Severity,
      party: string,
      section: string | null,
      amount: number,
      detail: string,
    ): void => {
      const n = (ords.get(check) ?? 0) + 1;
      ords.set(check, n);
      const masked: NoTdsMaskedFinding = {
        id: notdsFindingId(check, n),
        check,
        severity,
        party: party ? vault.pseudonym(party, "creditor") : "",
        section,
        amount,
        detail: scrubSecrets(maskKnownNames(detail, vault)),
      };
      findings.push(masked);
      counts[severity] += 1;
    };
    let cureExcluded = 0;

    for (const c of cands) {
      const dec = operator.decisions.get(c.key);
      if (dec && !dec.include) {
        cureExcluded += 1;
        push(
          "notds_cure_excluded",
          "review",
          c.party,
          winmanSectionOf(c.section),
          c.gross,
          `the operator excluded this row from clause 21(b) to cure the disallowance (cure reason: ${dec.cure}); the row is not written to the workbook — review it before the return is filed.`,
        );
        continue;
      }
      // Residency: blank R is the default; an NR mark routes the row. An
      // NR-routed row without a valid NR-section spelling is dropped loudly
      // (review-time guard, Focus #3) — never guessed across.
      const nrSection = dec?.nrSection;
      const section =
        dec?.residency === "NR"
          ? nrSection && isNrSectionSpelling(nrSection)
            ? nrSection
            : null
          : winmanSectionOf(c.section);
      if (section === null) {
        push(
          "notds_nr_missing_section",
          "critical",
          c.party,
          null,
          c.gross,
          `the operator marked this payee non-resident but gave no NR section spelling on the NR list; the row is dropped from clause 21(b) and the sheet understates the payment by that much until it is fixed.`,
        );
        continue;
      }
      const sheet: NotdsSheetKey =
        dec?.residency === "NR" ? "40(a)(i) to non-resident" : "40(a)(ia) to resident";
      const amount = dec?.amountOverride ?? c.gross;
      rows.push({
        sheet,
        party: c.party,
        date: c.date,
        amount,
        tdsDone: c.tdsDone,
        tdsDeposited: c.tdsDeposited,
        section,
        nature: dec?.nature ?? null,
        address: dec?.address ?? null,
        city: dec?.city ?? null,
        state: dec?.state ?? null,
        pin: dec?.pin ?? null,
        country: dec?.country ?? null,
        pan: dec?.pan ?? c.pan,
      });
      if (dec?.amountOverride !== undefined) {
        push(
          "notds_amount_override",
          "review",
          c.party,
          section,
          dec.amountOverride,
          `the operator overrode the books figure: the workbook states ${money(amount)} where the books expense was ${money(c.gross)}.`,
        );
      }
      if (!(dec && dec.residency === "NR")) {
        // Residency defaulted by the books (R or blank: the books cannot
        // show residency, so the operator's silence keeps the row on the
        // resident sheet). The PAN travels only as its TaxId pseudonym;
        // a derived PAN says so without printing one.
        const taxId = books.panAliasOf(c.party);
        const derived = books.panDerivedFromGstinOf(c.party);
        push(
          "notds_residency_defaulted",
          "review",
          c.party,
          section,
          c.liability,
          `residency was defaulted to resident; the row is written to the "${sheet}" sheet${taxId ? ` (PAN ${taxId} on file${derived ? " (PAN derived from GSTIN)" : ""})` : ""}.`,
        );
      }
      if (!c.pan && !dec?.pan) {
        push(
          "notds_no_pan",
          "review",
          c.party,
          section,
          amount,
          `no PAN is recorded anywhere on this payee; the 40(a)/40(ia) exposure cannot be measured per-deductor until it is filled.`,
        );
      }
    }

    for (const m of operator.manual) {
      rows.push({
        sheet: m.sheet,
        party: m.party,
        date: m.date,
        amount: m.amount,
        tdsDone: m.deducted,
        tdsDeposited: m.deposited,
        section: m.section ?? null,
        nature: m.nature ?? null,
        address: m.address ?? null,
        city: m.city ?? null,
        state: m.state ?? null,
        pin: m.pin ?? null,
        country: m.country ?? null,
        pan: m.pan ?? null,
      });
      push(
        "notds_manual_row",
        "review",
        m.party,
        m.section ?? null,
        m.amount,
        `an operator-added row on the "${m.sheet}" sheet for ${money(m.amount)} on ${displayDate(m.date)}${m.nature ? `, described as "${m.nature}"` : ""}${m.section ? `, section ${m.section}` : ""}.`,
      );
      if (!m.pan) {
        push(
          "notds_no_pan",
          "review",
          m.party,
          m.section ?? null,
          m.amount,
          `an operator-added row whose payee carries no PAN anywhere; clause 21(b)'s exposure cannot be measured per-deductor until it is filled.`,
        );
      }
    }

    // Bookings the engine could not section are excluded — visible once as an
    // aggregate line, count and gross only, never per-row.
    const unsectioned = books.events.bookings.filter((b) => b.section === null);
    if (unsectioned.length > 0) {
      const gross = unsectioned.reduce((a, b) => a + b.gross, 0);
      push(
        "notds_unsectioned_bookings",
        "review",
        "",
        null,
        gross,
        `${unsectioned.length} bookings totalling ${money(gross)} could not be placed under any TDS section from the operator file; they are excluded from clause 21(b). Map their ledgers in the operator file to include them.`,
      );
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.party.localeCompare(b.party));
    const sheets = {
      "40(a)(ia) to resident": 0,
      "40(a)(i) to non-resident": 0,
      "40(a)(ib) - Equalisation Levy": 0,
      "40(a)(iii)": 0,
    } as Record<NotdsSheetKey, number>;
    for (const r of rows) sheets[r.sheet] += 1;
    lastNoTds = rows;
    return {
      company: books.company,
      fromDate: books.fromDate,
      toDate: books.toDate,
      booksSource: books.booksSource,
      candidates: cands.length,
      sheets,
      cureExcluded,
      manualCount: operator.manual.length,
      findings,
      counts,
    };
  }

/**
 * An identity for a possibly-not-yet-existing path: its realpath when the
 * entry is there, else its parent directory's realpath joined with its
 * basename, else its resolved absolute form. Only ever used to detect a
 * self-overwrite, never as a general path normaliser.
 */
async function realPathId(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // not on disk (yet)
  }
  const abs = resolve(p);
  try {
    return join(await realpath(dirname(abs)), basename(abs));
  } catch {
    // the directory is missing too
  }
  return abs;
}

  function maskGstFinding(
    f: {
      id: string;
      check: string;
      severity: Severity;
      kind: GstKind;
      party: string;
      group: string;
      gstin: string | null;
      amount: number;
      detail: string;
    },
    c: Classifier,
  ): GstMaskedFinding {
    // Book parties mask by classifier (same policy as tb_review). A returns-only
    // identity is masked by kind role outward->Debtor / inward->Creditor; a
    // party with no usable name is vaulted by its GSTIN as TaxId N — the one
    // case where the raw GSTIN becomes the vault key, never the output.
    let ledger: string;
    if (f.group === RETURN_GROUP) {
      const real = f.party || f.gstin || "unnamed return row";
      ledger = vault.pseudonym(real, f.kind === "outward" ? "debtor" : "creditor");
      ledger = maskKnownNames(ledger, vault);
    } else if (f.party) {
      ledger = maskLedgerName(f.party, f.group, c, vault);
    } else if (f.gstin) {
      ledger = vault.pseudonym(f.gstin, "tax_id");
    } else {
      ledger = "unnamed ledger";
    }
    // Vaulting first, then the sweep: maskKnownNames substitutes any vaulted
    // real string in free text — party names and the GSTIN alike — and
    // scrubSecrets (tax-ID shapes + digit runs) still stands behind it.
    if (f.gstin) vault.pseudonym(f.gstin, "tax_id");
    const detail = scrubSecrets(maskKnownNames(f.detail, vault));
    return {
      id: f.id,
      check: f.check,
      severity: f.severity,
      kind: f.kind,
      ledger,
      group: scrubSecrets(f.group),
      amount: f.amount,
      detail,
    };
  }

  return {
    review,
    ledgerActivity,
    ledgerScrutiny,
    listCompanies: () => d.listCompanies(),
    vault,

    async gstSummary(company, fromDate, toDate) {
      const { books, classifier: c, ledgerGroupOf } = await gstAnalysis(
        company,
        fromDate,
        toDate,
      );
      const summary = gstSummary(books);
      // Tax ledger rows carry nominal ledger names; Duties & Taxes is on the
      // clear path, but role-based pseudonyms still apply through the same
      // ledgerPolicy rule maskLedgerName uses, so an override or a misfiled
      // group masks instead of leaking.
      for (const row of summary.taxLedgers) {
        const group = ledgerGroupOf.get(canonicalKey(row.ledger)) ?? "";
        row.ledger =
          c.ledgerPolicy(row.ledger, group) === "mask"
            ? vault.pseudonym(row.ledger, c.role(group))
            : scrubSecrets(row.ledger);
      }
      return summary;
    },

    async gstMismatch(company, fromDate, toDate, returnsText) {
      const { books, classifier: c } = await gstAnalysis(company, fromDate, toDate);
      const returns: ReturnRow[] = parseReturns(returnsText);
      const { findings, aggregate } = gstMismatch(books, returns);
      const masked = findings.map((f) => {
        // Book-party findings register their real ledger name so the existing
        // tb_ledger_activity drill-down works by finding id (R-MCP-4).
        if (f.group !== RETURN_GROUP && f.party) realLedgerByFinding.set(f.id, f.party);
        return maskGstFinding(f, c);
      });
      const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
      for (const f of masked) counts[f.severity] += 1;
      lastGst = { company, fromDate, toDate, returnRows: returns.length, counts, findings: masked, aggregate };
      return lastGst;
    },

    async ledgerNames(company) {
      try {
        const masters = await d.ledgersTax(company);
        return masters.map((m) => m.name).filter((n) => n);
      } catch {
        console.error(
          "tally-agent: ledger masters unavailable — the 26AS mapping template ships without a ledger list",
        );
        return [];
      }
    },

    // Addendum 2 (2026-09-26): pairs + groups for the loans template's
    // Exempt pre-fill; degrades to empty lists with a warning (the template
    // is still useful with a hand-filled party list).
    async ledgerPairs(company) {
      try {
        const [g, m] = await Promise.all([d.groups(company), d.ledgers(company)]);
        return { ledgers: m, groups: g };
      } catch {
        console.error(
          "tally-agent: ledger/group masters unavailable — the loans template ships without the Exempt pre-fill",
        );
        return { ledgers: [], groups: [] };
      }
    },

    tdsReview,
    as26Review,
    depreciationReview,
    faRegister,
    pfEsiReview,
    write3cdPfEsi,
    pfEsiRows: () => lastPfEsi,
    loansReview,
    loansRows: () =>
      lastLoansSheets
        ? { sheets: lastLoansSheets, vault: lastLoansVault ?? [] }
        : undefined,
    dep3cdReview,
    dep3cdRows: () => lastDep3cd,
    write3cdLoans,
    write3cdDepreciation,
    gst44Review,
    write3cdGst44,
    gst44Rows: () => lastGst44,
    writeGstWorksheet,
    write3cdTdsTcs,
    tds3cdResult: () => lastTds3cd,
    noTdsReview,
    notdsRows: () => lastNoTds,
    notdsCandidates: () =>
      lastTdsBooks
        ? booksCandidates(lastTdsBooks.clause21b, lastTdsBooks.panOf, lastTdsBooks.panDerivedFromGstinOf)
        : undefined,
    write3cdNoTds,
  };
}
