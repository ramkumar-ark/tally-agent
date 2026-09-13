import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream, VoucherRow } from "./downstream.js";
import { gstBooks, gstMismatch, gstSummary, RETURN_GROUP, type GstBooks, type GstCtx, type GstSummaryView } from "./gst.js";
import type { ReturnRow } from "./returns.js";
import { parseReturns } from "./returns.js";
import { dayBefore } from "./format.js";
import { canonicalKey } from "./key.js";
import { maskFinding, maskKnownNames, maskLedgerName, scrubSecrets } from "./mask.js";
import { scrutinize, type MonthMovement } from "./scrutiny.js";
import { createVault, type Vault } from "./vault.js";
import {
  TOTALS_TOLERANCE,
  type Finding,
  type GroupRole,
  type GstKind,
  type Severity,
  type Side,
  type TbRow,
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
  vault: Vault;
}

export function createSession(d: Downstream, overrides: Overrides): Session {
  const vault = createVault();
  /** finding id -> real ledger name, for drill-down without the model holding it. */
  const realLedgerByFinding = new Map<string, string>();
  const groupOfLedger = new Map<string, string>();
  let classifier: Classifier | undefined;
  let lastCompany: string | undefined;
  let lastGst: GstMismatchResult | undefined;
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
  };
}
