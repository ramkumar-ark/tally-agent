import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream, VoucherRow } from "./downstream.js";
import { gstBooks, gstMismatch, gstSummary, RETURN_GROUP, type GstBooks, type GstCtx, type GstSummaryView } from "./gst.js";
import type { ReturnRow } from "./returns.js";
import { parseReturns } from "./returns.js";
import { canonicalKey } from "./key.js";
import { maskFinding, maskKnownNames, maskLedgerName, scrubSecrets } from "./mask.js";
import { createVault, type Vault } from "./vault.js";
import {
  TOTALS_TOLERANCE,
  type Finding,
  type GstKind,
  type Severity,
} from "./types.js";

/**
 * Ledger-bearing fields in a downstream voucher row. The real
 * tally_prime_mcp_server report envelope carries the counterparty under
 * partyLedgerName and counterLedgerName, and the queried ledger itself under
 * matchedLedgerName — not the "counterparty"/"ledgerName"/"partyName"/"party"
 * fields the plan draft assumed. See src/downstream.ts.
 */
const NAME_FIELDS = ["partyLedgerName", "counterLedgerName", "matchedLedgerName"] as const;

function maskVoucherRow(
  row: unknown,
  classifier: Classifier,
  vault: Vault,
  groupOf: Map<string, string>,
): unknown {
  if (typeof row !== "object" || row === null) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of NAME_FIELDS) {
    const v = out[field];
    if (typeof v !== "string" || !v) continue;
    const group = groupOf.get(canonicalKey(v)) ?? "";
    out[field] = maskLedgerName(v, group, classifier, vault);
  }
  // NAME_FIELDS is not an allowlist of every field that can carry a real
  // name: narration, reference and similar free-text fields can too. Sweep
  // every remaining string value for any name the vault already knows (from
  // the fields above, or from this session's findings) and substitute its
  // pseudonym, canonical-key-aware so a whitespace variant still matches.
  // This only catches known names — see the design doc's stated limitation
  // on free-text name detection for names never otherwise masked.
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") out[k] = maskKnownNames(v, vault);
  }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") out[k] = scrubSecrets(v as string);
  }
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

export interface Session {
  review(company: string | undefined, asOnDate: string): Promise<ReviewResult>;
  ledgerActivity(findingId: string, fromDate: string, toDate: string): Promise<unknown[]>;
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
