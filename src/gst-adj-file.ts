import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { money, displayDate } from "./format.js";
import type { GadjEntry, GstAdjResult, GstAdjResidual } from "./gst-adj.js";
import type { ThreeBSummary } from "./gst-adj-3b.js";
import type { VoucherRow } from "./downstream.js";
import type { GstAdjConfig } from "./gst-adj-config.js";

/**
 * Common Tally voucher fields defaulted to false/0/null for import envelopes.
 * `fbtpaymenttype` is deliberately absent: it is a Tally export artifact
 * (Facebook Business/Tally integration flag), not an intent the gateway
 * should propagate into an import voucher.
 */
const VOUCHER_CONSTANTS = {
  isBankVoucher: false,
  isReceiptVoucher: false,
  isContraVoucher: false,
  isJournalVoucher: false,
  useDefaultCreditNote: false,
  useDefaultDebitNote: false,
  dtlAdjust: false,
};

export interface WriteGstAdjImportOpts {
  reportDir: string;
  fy: string;
  entries: GadjEntry[];
  threeB: ThreeBSummary;
  voucherType: string;
}

export function gstAdjEnvelope(
  entries: GadjEntry[],
  threeB: ThreeBSummary,
  voucherType: string,
): unknown {
  const tallymessage = entries.map((entry) => ({
    ...VOUCHER_CONSTANTS,
    metadata: { type: "Voucher", action: "Create", objview: "Accounting Voucher View" },
    vchtype: voucherType,
    date: entry.date,
    vchstatusdate: entry.date,
    effectivedate: entry.date,
    narration: entry.narration,
    vouchertypename: voucherType,
    gstregistration: {
      value: threeB.state + " Registration",
      taxtype: "GST",
      taxregistration: threeB.gstin,
    },
    cmpgstin: threeB.gstin,
    cmpgststate: threeB.state,
    cmpgstregistrationtype: "Regular",
    numberingstyle: "Auto Renumber",
    vouchernumberseries: "Default",
    allledgerentries: entry.legs.flatMap((leg) => [
      {
        ledgername: leg.dr,
        isdeemedpositive: true,
        ispartyledger: false,
        amount: (-leg.amount).toFixed(2),
        vatexpamount: (-leg.amount).toFixed(2),
      },
      {
        ledgername: leg.cr,
        isdeemedpositive: false,
        ispartyledger: false,
        amount: leg.amount.toFixed(2),
        vatexpamount: leg.amount.toFixed(2),
      },
    ]),
  }));
  return { tallymessage };
}

export async function writeGstAdjImportFile(
  opts: WriteGstAdjImportOpts,
): Promise<string> {
  const { reportDir, fy, entries, threeB, voucherType } = opts;
  const path = join(reportDir, `gst-adjustments-${fy}.json`);
  const envelope = gstAdjEnvelope(entries, threeB, voucherType);
  const json = JSON.stringify(envelope);
  const crlf = json.replace(/\n/g, "\r\n");
  const body = Buffer.from(crlf, "utf16le");
  const bom = Buffer.from([0xff, 0xfe]);
  const full = Buffer.concat([bom, body]);
  await mkdir(reportDir, { recursive: true });
  await writeFile(path, full);
  return path;
}

export function headOf(ledger: string, config: GstAdjConfig): string {
  for (const [head, roles] of Object.entries(config.heads)) {
    if (Object.values(roles).includes(ledger)) return head;
  }
  return ledger;
}

export async function writeGstAdjPaper(
  opts: {
    reportDir: string;
    fy: string;
    threeB: ThreeBSummary;
    result: GstAdjResult;
    config: GstAdjConfig;
    contributions: Map<string, VoucherRow[]>;
    alreadyPosted?: VoucherRow[];
  },
): Promise<string> {
  const { reportDir, fy, result, config, contributions, alreadyPosted } = opts;
  const path = join(reportDir, `gst-adjustments-${fy}-working-paper.md`);

  const lines: string[] = [];

  lines.push(`# GST Adjustments — FY ${fy}`);
  lines.push("");

  // Month × Kind × Head table
  lines.push("## Month × Kind × Head");
  lines.push("");
  lines.push("| Month | Kind | Head | Amount |");
  lines.push("| --- | --- | --- | --- |");

  const grouped = new Map<string, number>();
  for (const entry of result.entries) {
    const head = headOf(entry.legs[0]?.dr ?? "", config);
    const key = `${entry.month}|${entry.kind}|${head}`;
    grouped.set(key, (grouped.get(key) ?? 0) + entry.legs.reduce((sum, l) => sum + l.amount, 0));
  }
  const sortedKeys = Array.from(grouped.keys()).sort();
  for (const key of sortedKeys) {
    const [month, kind, head] = key.split("|");
    lines.push(`| ${month} | ${kind} | ${head} | ${money(grouped.get(key) ?? 0)} |`);
  }
  lines.push("");

  // Already-posted GST adjustment vouchers (plan §6.2)
  if (alreadyPosted && alreadyPosted.length > 0) {
    lines.push("## Already posted in books");
    lines.push("");
    lines.push("The following GST adjustment vouchers are already present in the books and were excluded\n" +
      "from the movement; a re-run does not re-post them:");
    lines.push("");
    for (const row of alreadyPosted) {
      lines.push(`- ${row.voucherType} ${row.voucherNumber} — ${displayDate(row.date)} — ${row.narration}`);
    }
    lines.push("");
  }

  // Residual section
  lines.push("## Residual");
  lines.push("");
  for (const r of result.residual) {
    lines.push(`Route for ${r.head}: ${r.route} — ${money(r.amount)} over months: ${r.months.join(", ")}`);
  }
  lines.push("");

  // Contributions (traced vouchers)
  lines.push("## Contributions");
  lines.push("");
  const sortedMonths = Array.from(contributions.keys()).sort();
  for (const month of sortedMonths) {
    const vouchers = contributions.get(month) ?? [];
    for (const row of vouchers) {
      const amount = row.entries.reduce((sum, e) => sum + e.amount, 0);
      const ref = (row as { reference?: string }).reference ?? "n/a";
      lines.push(`${row.voucherType} ${row.voucherNumber} — ${displayDate(row.date)} — ref: ${ref} — ${money(amount)}`);
    }
  }
  lines.push("");

  // Findings
  lines.push("## Findings");
  lines.push("");
  for (const f of result.findings) {
    lines.push(`- ${f.id}: ${f.detail}`);
  }
  lines.push("");

  // Tie-out table
  lines.push("## Tie-out");
  lines.push("");
  lines.push("| Month | Kind | Head | Entry | ThreeB | Note |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of result.tieout) {
    const threeBVal = t.threeB !== null ? money(t.threeB) : "null";
    lines.push(`| ${t.month} | ${t.kind} | ${t.head} | ${money(t.entry)} | ${threeBVal} | ${t.note ?? ""} |`);
  }
  lines.push("");

  // Live validation checklist
  lines.push("## Live validation");
  lines.push("");
  lines.push("- **Import acceptance**: JSON file written UTF-16 LE with BOM (0xFF 0xFE); vouchernumber omitted\n" +
    "  from every tallymessage (Tally assigns on import); fbtpaymenttype absent from the envelope.\n" +
    "  Import a sample voucher into a scratch company and confirm it posts without error.\n" +
    "  On a fresh export check for duplicate-period files (two files claiming the same month) —\n" +
    "  parseItc2bFolder warns and first-wins; confirm no period appears twice in gstinByMonth.");
  lines.push("- **Narration wording**: kinds 4–7/R narration is pattern-extended from DSV/RVS examples —\n" +
    "  validate against a live import; current templates are placeholders pending confirmation.");
  lines.push("- **TDS-figure cross-check**: on any month where Table 12 appears in 3B, compare the 3B TDS\n" +
    "  figure (tdsSectionPresent) against the books TDS credit (gstTdsCredit in config); reconcile\n" +
    "  before treating the month's net ITC as final.");
  lines.push("- **3B-GSTIN vs books-GSTIN vs 2B-list-GSTIN agreement**: confirm the GSTIN read from the 3B\n" +
    "  summary sheet matches the books GSTIN and the 2B list GSTIN per month (gstinByMonth);\n" +
    "  flag any mismatch as a finding.");
  lines.push("");

  await mkdir(reportDir, { recursive: true });
  await writeFile(path, lines.join("\n"));
  return path;
}
