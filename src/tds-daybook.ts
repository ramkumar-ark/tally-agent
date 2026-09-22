import type { LedgerVoucherRow, VoucherRow } from "./downstream.js";
import { canonicalKey } from "./key.js";
import type { TdsLedgerRows } from "./tds.js";

const ZERO = 0.005;

export function counterpartyOf(v: VoucherRow, index: number): string {
  const self = v.entries[index];
  if (!self) return "";
  let bestLedger = "";
  let bestAmount = 0;
  v.entries.forEach((e, i) => {
    if (i === index) return;
    if (Math.abs(e.amount) <= ZERO) return;
    if (Math.sign(e.amount) === Math.sign(self.amount)) return;
    if (Math.abs(e.amount) > Math.abs(bestAmount)) {
      bestLedger = e.ledger;
      bestAmount = e.amount;
    }
  });
  return bestLedger || v.partyLedgerName;
}

export function projectLedgerRows(
  vouchers: VoucherRow[],
  ledgers: string[],
): TdsLedgerRows[] {
  const byLedger = new Map<string, LedgerVoucherRow[]>();
  for (const l of ledgers) byLedger.set(canonicalKey(l), []);
  for (const v of vouchers) {
    if (v.cancelled) continue;
    v.entries.forEach((entry, i) => {
      const rows = byLedger.get(canonicalKey(entry.ledger));
      if (!rows) return;
      rows.push({
        date: String(v.date ?? ""),
        voucherType: String(v.voucherType ?? ""),
        voucherNumber: String(v.voucherNumber ?? ""),
        reference: "",
        counterparty: counterpartyOf(v, i),
        amount: entry.amount,
        matchStatus: "unknown",
        tax: null,
      });
    });
  }
  return ledgers.map((l) => ({
    ledger: l,
    rows: byLedger.get(canonicalKey(l)) ?? [],
  }));
}
