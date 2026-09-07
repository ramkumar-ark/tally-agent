import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream } from "./downstream.js";
import { canonicalKey } from "./key.js";
import { maskFinding, maskKnownNames, maskLedgerName, scrubDigits } from "./mask.js";
import { createVault, type Vault } from "./vault.js";
import { TOTALS_TOLERANCE, type Finding, type Severity } from "./types.js";

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
    if (typeof v === "string") out[k] = scrubDigits(v as string);
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

export interface Session {
  review(company: string | undefined, asOnDate: string): Promise<ReviewResult>;
  ledgerActivity(findingId: string, fromDate: string, toDate: string): Promise<unknown[]>;
  listCompanies(): Promise<string[]>;
  vault: Vault;
}

export function createSession(d: Downstream, overrides: Overrides): Session {
  const vault = createVault();
  /** finding id -> real ledger name, for drill-down without the model holding it. */
  const realLedgerByFinding = new Map<string, string>();
  const groupOfLedger = new Map<string, string>();
  let classifier: Classifier | undefined;
  let lastCompany: string | undefined;

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

  return { review, ledgerActivity, listCompanies: () => d.listCompanies(), vault };
}
