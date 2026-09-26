import type { LedgerVoucherRow } from "./downstream.js";
import { quarterOfDate, type TdsLedgerRows } from "./tds.js";
import { round2 } from "./as26.js";

export { quarterOfDate };

/**
 * The TCS engine leaf: pure functions of its inputs, mirroring the TDS
 * booking/deduction/deposit trichotomy for collections and deposits. Signs
 * follow the gateway convention (positive = debit) and are never re-flipped.
 */

const CANCELLED_VOUCHER = /^(cancel|credit note)/i;

export function isCancelledVoucher(voucherType: string): boolean {
  return CANCELLED_VOUCHER.test(voucherType);
}

export interface TcsCollection {
  date: string;
  voucherNumber: string;
  party: string;
  /** TcsNature.key */
  nature: string;
  gross: number;
  tax: number;
  ledger: string;
}

export interface TcsDeposit {
  date: string;
  party: string;
  tax: number;
  ledger: string;
}

export interface TcsAnalysis {
  collections: TcsCollection[];
  deposits: TcsDeposit[];
  totals: {
    byNature: { nature: string; gross: number; tax: number }[];
    notDeposited: number;
  };
}

export function analyzeTcs(
  dutyRows: TdsLedgerRows[],
  receiptRows: TdsLedgerRows[],
  natureOfReceipt: (ledger: string) => string | null
): TcsAnalysis {
  // Receipt debits, for byNature gross and voucher-level joins.
  const receiptByVoucher = new Map<string, LedgerVoucherRow[]>();
  const allReceipts: { nature: string; amount: number }[] = [];
  for (const lr of receiptRows) {
    const nature = natureOfReceipt(lr.ledger);
    if (nature === null) continue;
    for (const r of lr.rows) {
      if (isCancelledVoucher(r.voucherType)) continue;
      if (r.amount > 0) {
        allReceipts.push({ nature, amount: r.amount });
        const voucherKey = String(r.voucherNumber);
        const list = receiptByVoucher.get(voucherKey) ?? [];
        list.push(r);
        receiptByVoucher.set(voucherKey, list);
      }
    }
  }

  const collections: TcsCollection[] = [];
  const deposits: TcsDeposit[] = [];
  for (const lr of dutyRows) {
    const nature = natureOfReceipt(lr.ledger);
    for (const r of lr.rows) {
      if (isCancelledVoucher(r.voucherType)) continue;
      if (r.amount < 0) {
        const joined = receiptByVoucher.get(String(r.voucherNumber));
        let gross = 0;
        if (joined && joined.length > 0) {
          const sameVoucher = joined.find((j) => j.date === r.date) ?? joined[0];
          gross = sameVoucher.amount;
        }
        collections.push({
          date: r.date,
          voucherNumber: String(r.voucherNumber),
          party: r.counterparty,
          nature: nature ?? "unknown",
          gross: round2(gross),
          tax: round2(-r.amount),
          ledger: lr.ledger,
        });
      } else if (r.amount > 0) {
        deposits.push({
          date: r.date,
          party: r.counterparty,
          tax: round2(r.amount),
          ledger: lr.ledger,
        });
      }
    }
  }

  // All receipt debits feed grossByNature; the voucher join only picks each
  // collection's gross, never the nature totals.
  const grossByNature = new Map<string, number>();
  for (const rec of allReceipts) grossByNature.set(rec.nature, (grossByNature.get(rec.nature) ?? 0) + rec.amount);
  const taxByNature = new Map<string, number>();
  for (const c of collections) taxByNature.set(c.nature, (taxByNature.get(c.nature) ?? 0) + c.tax);
  const depositByNature = new Map<string, number>();
  for (const d of deposits) {
    const nature = natureOfReceipt(d.ledger);
    if (nature === null) continue;
    depositByNature.set(nature, (depositByNature.get(nature) ?? 0) + d.tax);
  }

  const byNature = [...new Set([...taxByNature.keys(), ...grossByNature.keys()])]
    .sort()
    .map((nature) => ({
      nature,
      gross: round2(grossByNature.get(nature) ?? 0),
      tax: round2(taxByNature.get(nature) ?? 0),
    }));

  let notDeposited = 0;
  for (const nature of new Set([...taxByNature.keys(), ...depositByNature.keys()])) {
    const outstanding = (taxByNature.get(nature) ?? 0) - (depositByNature.get(nature) ?? 0);
    notDeposited += Math.max(0, outstanding);
  }

  return {
    collections,
    deposits,
    totals: { byNature, notDeposited: round2(notDeposited) },
  };
}
