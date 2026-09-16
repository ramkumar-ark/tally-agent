import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream, LedgerVoucherRow, VoucherRow } from "./downstream.js";
import {
  analyzeDepreciation, round2,
  type AssetRow, type BlockResult, type DepAnalyzeInput, type DepCtx, type ExcludedRow, type MovementRow,
} from "./depreciation.js";
import { EMPTY_DEP_OPERATOR, parseDepOperatorFile } from "./depreciation-file.js";
import { gstBooks, gstMismatch, gstSummary, RETURN_GROUP, type GstBooks, type GstCtx, type GstSummaryView } from "./gst.js";
import type { ReturnRow } from "./returns.js";
import { parseReturns } from "./returns.js";
import { dayBefore } from "./format.js";
import { canonicalKey } from "./key.js";
import { maskFinding, maskKnownNames, maskLedgerName, scrubSecrets } from "./mask.js";
import { scrutinize, type MonthMovement } from "./scrutiny.js";
import { parseDayBook, parseOperatorFile, type OperatorFile } from "./tds-file.js";
import { analyzeTds, type TdsCtx, type TdsEvents, type TdsLedgerRows } from "./tds.js";
import { createVault, type Vault } from "./vault.js";
import {
  EMPTY_WRONG_GROUP,
  TOTALS_TOLERANCE,
  ZERO_TOLERANCE,
  type Finding,
  type GroupRole,
  type GstKind,
  type Severity,
  type Side,
  type TbRow,
  type TdsFinding,
  tdsFindingId,
  type WrongGroupConfig,
  type DepFinding,
} from "./types.js";

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
  findings: TdsMaskedFinding[];
  totals: {
    bySection: Array<{ section: string; gross: number; tax: number }>;
    notDeducted: number;
    shortDeducted: number;
    interestI: number;
    interestIi: number;
  };
  ledgerCalls: number;
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
   * operator file travels by path only; its text is read inside the gateway.
   */
  tdsReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    asOnDate: string,
    operatorText: string,
    fullCheckText?: string,
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
  vault: Vault;
}

export function createSession(
  d: Downstream,
  overrides: Overrides,
  wrongGroup: WrongGroupConfig = EMPTY_WRONG_GROUP,
  /** Per-install options: the Rule 119A(c) switch is the config layer's (Task 4). */
  options: { tdsRound100?: boolean } = {},
): Session {
  const vault = createVault();
  /** finding id -> real ledger name, for drill-down without the model holding it. */
  const realLedgerByFinding = new Map<string, string>();
  const groupOfLedger = new Map<string, string>();
  let classifier: Classifier | undefined;
  let lastCompany: string | undefined;
  let lastGst: GstMismatchResult | undefined;
  let lastTds: TdsReviewResult | undefined;
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
  ): Promise<{ rows: Map<string, LedgerVoucherRow[]>; calls: number }> => {
    const rows = new Map<string, LedgerVoucherRow[]>();
    let calls = 0;
    for (const ledger of ledgers) {
      for (const [f, t] of monthChunks(fromDate, toDate)) {
        const fetched = await d.ledgerVoucherRows(company, ledger, f, t);
        calls += 1;
        const list = rows.get(canonicalKey(ledger)) ?? [];
        list.push(...fetched.rows);
        rows.set(canonicalKey(ledger), list);
      }
    }
    return { rows, calls };
  };

  /** Voucher-row groups keyed by the queried (real) ledger, engine-ready. */
  const rowsByLedger = (rows: Map<string, LedgerVoucherRow[]>, ledger: string): LedgerVoucherRow[] =>
    rows.get(canonicalKey(ledger)) ?? [];

  const asTdsLedgerRows = (
    rows: Map<string, LedgerVoucherRow[]>,
    ledgers: string[],
  ): TdsLedgerRows[] =>
    ledgers.map((ledger) => ({ ledger: canonicalKey(ledger), rows: rowsByLedger(rows, ledger) }));

  async function tdsReview(
    company: string | undefined,
    fromDate: string,
    toDate: string,
    asOnDate: string,
    operatorText: string,
    fullCheckText?: string,
  ): Promise<TdsReviewResult> {
    if (!/^\d{8}$/.test(fromDate) || !/^\d{8}$/.test(toDate) || !/^\d{8}$/.test(asOnDate) || fromDate > toDate) {
      throw new Error("fromDate, toDate and asOnDate must be YYYYMMDD, with fromDate on or before toDate");
    }
    lastCompany = company;
    const operator: OperatorFile = parseOperatorFile(operatorText);
    // The verbose whole-company master export is the heaviest downstream call
    // and the only one a large company can wedge — the captain asked for the
    // narrowest request on a shared Tally. When it fails (P1 fields absent or
    // the live server unreachable), the session degrades to operator-file-only
    // facts: flags/PANs read as absent, never guessed, and the run records it.
    const mastersUnavailable = { value: false } as { value: boolean };
    const [groups, masters] = await Promise.all([
      d.groups(company),
      d.ledgersTax(company).catch((e: unknown) => {
        mastersUnavailable.value = true;
        console.error(
          `tally-agent: verbose ledger masters unavailable (${e instanceof Error ? e.message : e}); running without them`,
        );
        return [] as Awaited<ReturnType<Downstream["ledgersTax"]>>;
      }),
    ]);
    const c = buildClassifier(groups, overrides);
    classifier = c;
    for (const l of masters) groupOfLedger.set(canonicalKey(l.name), l.parent);

    // PAN channel: a real PAN travels only as its TaxId N pseudonym (M2
    // pattern). The PAN's 4th character feeds the statutory rate.
    const panAliasOf = new Map<string, string>();
    for (const l of masters) {
      if (l.pan && !panAliasOf.has(canonicalKey(l.name))) {
        panAliasOf.set(canonicalKey(l.name), vault.pseudonym(l.pan, "tax_id"));
      }
    }
    const realOf = (party: string): string =>
      masters.find((l) => canonicalKey(l.name) === canonicalKey(party))?.name ?? party;

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
    const fetchSet = unique([...dutyLedgerNames, ...operatorDutyLedgers, ...expenseLedgerNames, ...partyLedgerNames]);
    const fetched = await fetchLedgerRows(company, fetchSet, fromDate, toDate);

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
    const entityOf = (party: string): "P" | "H" | "C" | "F" | null => {
      const real = realOf(party);
      const pan = masters.find((l) => canonicalKey(l.name) === canonicalKey(real))?.pan ?? null;
      if (!pan || pan.length < 4) return null;
      const ch = pan[3].toUpperCase();
      return ch === "P" || ch === "H" || ch === "C" || ch === "F" ? (ch as "P" | "H" | "C" | "F") : null;
    };
    const panKeyOf = (party: string): string | null => panAliasOf.get(canonicalKey(realOf(party))) ?? null;
    const deducteeTypeOf = (party: string): string =>
      masters.find((l) => canonicalKey(l.name) === canonicalKey(realOf(party)))?.tdsDeducteeType ?? "";

    const ctx: TdsCtx = {
      tdsParties: unique([
        ...partyLedgerNames,
        ...operator.parties.filter((p) => p.tdsApplicable).map((p) => p.ledger),
      ]).filter((n) => !operatorNoKeys.has(canonicalKey(n))),
      resolveSection,
      dutySectionOf,
      panKeyOf,
      entityOf,
      deducteeTypeOf,
      certificateRateOf,
      transporterDeclared,
      deducteeFiledReturn,
      asOnDate,
      round100: options.tdsRound100 ?? true,
      period: { fromDate, toDate },
    };

    // The engine runs month-chunked book events; the day-book reconciliation
    // (an operator fullCheck export) runs the same engine on operator rows.
    const bookRows = asTdsLedgerRows(fetched.rows, fetchSet);
    const analysis = analyzeTds(
      bookRows.filter((r) => dutyLedgerNames.some((n) => canonicalKey(n) === r.ledger)),
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

    const result: TdsReviewResult = {
      company,
      mastersAvailable: !mastersUnavailable.value,
      fromDate,
      toDate,
      asOnDate,
      counts,
      findings,
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
    };
    lastTds = result;
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
    // nil and is skipped. TALLY_AGENT_DEP_FETCH_ALL=1 disables the skip
    // (design §5).
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
      ledgerRows: needFetch.map((l) => ({ ledger: l, rows: rowsByLedger(pass2.rows, l) })),
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
      bookCharge: result.bookCharge,
      seedSource: result.seedSource,
      assetLedgers: assetLedgers.length,
      fetched: needFetch.length,
      calls: pass1.calls + pass2.calls,
    };
    return maskedResult;
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

    tdsReview,
    depreciationReview,
  };
}
