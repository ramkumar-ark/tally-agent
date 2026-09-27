import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GadjEntry } from "./gst-adj.js";
import type { ThreeBSummary } from "./gst-adj-3b.js";

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
