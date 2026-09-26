/**
 * Law of record for the Winman Form 3CD clause-18 additions/deletions fill.
 * Design: docs/design/2026-09-27-winman-3cd-depreciation-design.md §4.
 * Income-tax Act 1961 (AY 2026-27). `confirm: true` rows await the captain.
 */
export const PURCHASE_VOUCHER = /purc|inw(a)?rd/i;                       // C5
export const REDUCTION_VOUCHER = /debit\s*note|purchase\s*return/i;
export const SALE_PL_NAME = /\b(profit|loss|gain)\b.{0,12}\b(sale|disposal)\b/i;
export const CHARGE_NAME =
  /load|unload|freight|carriage|transport|install|erect|commission/i;    // C4
export const TAX_NAME = /\b(c|s|i|u)gst\b|\bgst\b|\bcess\b|\btcs\b|\btds\b/i;
export const CASH_COST_LIMIT = 10000;                                    // C11
export const INCLUDE_SAME_VOUCHER_CHARGES = false;                       // C4
export const ADDITIONAL_DEPRECIATION_TEXT = "N/A";
export const DEPN_TEXT = "No";
export const HALFADD_DEFAULT = "No";                                     // C8

/** Copied from the Winman AY 2026-27 (v9.6.1 build 1623) workbook's INTER lists. */
export const DEFAULT_BLOCK_LISTS = {
  additions: [
    "1. Buildings 5%:", "2. Buildings 10%:", "3. Buildings 40%:", "4. Furnitures/ fittings 10%:",
    "5. Plant/ Machinery 15%:", "6. Plant/ Machinery 30%:", "7. Plant/ Machinery 40%:",
    "9. Ships/ vessels 20%:", "10. Intangible assets 25%:",
  ],
  deletions: [
    "1. Buildings 5%:", "2. Buildings 10%:", "3. Buildings 40%:", "4. Furnitures/ fittings 10%:",
    "5. Plant/ Machinery 15%:", "6. Plant/ Machinery 30%:", "7. Plant/ Machinery 40%:",
    "8. Plant/ Machinery 45%:", "9. Ships/ vessels 20%:", "10. Intangible assets 25%:",
  ],
} as const satisfies { additions: readonly string[]; deletions: readonly string[] };

export function rateOfBlock(item: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(item);
  return m ? Number(m[1]) : null;
}

export const DEP3CD_CONFIRM: Array<{ id: string; rule: string; source: string; confirm: boolean }> = [
  { id: "C1", rule: "date put to use = first purchase-voucher date", source: "captain; s.32(1) second proviso; DEP D8", confirm: true },
  { id: "C2", rule: "later capitalised debits fold into the first acquisition's amount and date", source: "captain; s.43(1)", confirm: true },
  { id: "C3", rule: "insurance capitalised in books included as booked", source: "s.43(1)", confirm: true },
  { id: "C4", rule: "same-voucher expensed charges are not added to tax cost", source: "captain; s.43(1)", confirm: true },
  { id: "C5", rule: "each purchase-class voucher is its own addition", source: "captain", confirm: true },
  { id: "C6", rule: "deletion = moneys payable excluding GST; never book value or P/L", source: "s.43(6)(c); s.50", confirm: true },
  { id: "C7", rule: "selling expenses not deducted from consideration", source: "s.43(6)(c); s.48", confirm: true },
  { id: "C8", rule: "HALFADD No, DEPN No", source: "Winman workbook (undocumented)", confirm: true },
  { id: "C9", rule: "block by unique rate; ambiguous rates need the operator", source: "Rule 5, Appendix I", confirm: true },
  { id: "C10", rule: "Adjustments column left blank", source: "Winman workbook list", confirm: true },
  { id: "C11", rule: "cash part above Rs 10,000 excluded from cost", source: "s.43(1) third proviso; s.40A(3)", confirm: true },
  { id: "C12", rule: "availed input tax not in cost; blocked credit included as booked", source: "s.43(1)", confirm: true },
  { id: "C13", rule: "capitalised debit without a purchase this year is its own row", source: "s.43(1)", confirm: true },
  { id: "C14", rule: "asset-to-asset transfers make no row; flagged across blocks", source: "s.43(6)", confirm: true },
  { id: "C15", rule: "day-book channel only in v1", source: "AGENTS.md transport limits", confirm: true },
];