import type { VoucherRow } from "../../src/downstream.js";

export const D3_GROUPS = [
  { name: "Fixed Assets", parent: "\u0004 Primary" },
  { name: "Block 15%", parent: "Fixed Assets" }, { name: "Block 40%", parent: "Fixed Assets" },
  { name: "Block 10%", parent: "Fixed Assets" },
  { name: "Current Liabilities", parent: "\u0004 Primary" }, { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Duties & Taxes", parent: "Current Liabilities" },
  { name: "Current Assets", parent: "\u0004 Primary" }, { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" }, { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Sales Accounts", parent: "\u0004 Primary" }, { name: "Purchase Accounts", parent: "\u0004 Primary" },
  { name: "Indirect Expenses", parent: "\u0004 Primary" }, { name: "Indirect Incomes", parent: "\u0004 Primary" },
];

export const D3_LEDGERS = [
  { name: "Mixer Unit", parent: "Block 15%" }, { name: "Site Van", parent: "Block 15%" },
  { name: "Store Box", parent: "Block 15%" }, { name: "Pump Set", parent: "Block 15%" },
  { name: "Old Loader", parent: "Block 15%" }, { name: "Old Tractor", parent: "Block 15%" },
  { name: "Notebook PC", parent: "Block 40%" }, { name: "Desk Set", parent: "Block 10%" },
  { name: "Alpha Tools", parent: "Sundry Creditors" }, { name: "Beta Motors", parent: "Current Liabilities" },
  { name: "Gamma Traders", parent: "Sundry Creditors" },
  { name: "Input CGST", parent: "Duties & Taxes" }, { name: "Input SGST", parent: "Duties & Taxes" },
  { name: "Output CGST", parent: "Duties & Taxes" }, { name: "Output SGST", parent: "Duties & Taxes" },
  { name: "Freight Inward", parent: "Purchase Accounts" },
  { name: "Sale of Fixed Asset", parent: "Sales Accounts" },
  { name: "Profit on Sale of Fixed Asset", parent: "Indirect Incomes" },
  { name: "Loss on Sale of Fixed Asset", parent: "Indirect Expenses" },
  { name: "Depreciation", parent: "Indirect Expenses" },
  { name: "Main Bank", parent: "Bank Accounts" }, { name: "Buyer One", parent: "Sundry Debtors" },
  { name: "Cash", parent: "Cash-in-Hand" },
];

const v = (date: string, voucherType: string, voucherNumber: string, entries: Array<[string, number]>): VoucherRow => ({
  date, voucherType, voucherNumber, partyLedgerName: "", cancelled: false,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount })),
});

/** POST-FLIP sign: positive = debit. */
export const D3_VOUCHERS: VoucherRow[] = [
  v("20250408", "Purchase", "P-1", [["Mixer Unit", 100000], ["Freight Inward", 2000], ["Input CGST", 9180], ["Input SGST", 9180], ["Alpha Tools", -120360]]),
  v("20250410", "GST/inwrd/Txble", "G-1", [["Site Van", 500000], ["Beta Motors", -500000]]),
  v("20250410", "Journal", "J-1", [["Site Van", 40000], ["Beta Motors", -40000]]),
  v("20250416", "Debit Note", "DN-1", [["Beta Motors", 20000], ["Site Van", -20000]]),
  v("20250522", "Payment", "PY-1", [["Site Van", 15000], ["Main Bank", -15000]]),
  v("20250630", "Fixed Asset Sale", "S-1", [["Buyer One", 236000], ["Sale of Fixed Asset", -200000], ["Output CGST", -18000], ["Output SGST", -18000]]),
  v("20250630", "Journal", "J-2", [["Sale of Fixed Asset", 200000], ["Pump Set", -200000]]),
  v("20250630", "Journal", "J-3", [["Loss on Sale of Fixed Asset", 35000], ["Pump Set", -35000]]),
  v("20250701", "Purchase", "P-2", [["Store Box", 200000], ["Gamma Traders", -200000]]),
  v("20250701", "Purchase", "P-3", [["Store Box", 210000], ["Gamma Traders", -210000]]),
  v("20250801", "Payment", "PY-2", [["Desk Set", 12000], ["Cash", -12000]]),
  v("20251106", "Journal", "J-4", [["Buyer One", 90000], ["Old Loader", -90000]]),
  v("20251106", "Journal", "J-5", [["Old Loader", 5000], ["Profit on Sale of Fixed Asset", -5000]]),
  v("20251215", "Receipt", "R-1", [["Main Bank", 300000], ["Old Tractor", -250000], ["Profit on Sale of Fixed Asset", -50000]]),
  v("20260113", "Purchase", "P-4", [["Notebook PC", 50000], ["Gamma Traders", -50000]]),
  v("20260331", "Journal", "J-6", [["Depreciation", 95000], ["Mixer Unit", -15000], ["Site Van", -80000]]),
];

/** Expected rows with no template (Notebook PC / Desk Set unmapped: rates 40 and 10 are ambiguous). */
export const D3_EXPECTED_ADDITIONS = [
  { ledger: "Mixer Unit", block: "5. Plant/ Machinery 15%:", purchaseDate: "20250408", amount: 100000 },
  { ledger: "Site Van", block: "5. Plant/ Machinery 15%:", purchaseDate: "20250410", amount: 535000 },
  { ledger: "Store Box", block: "5. Plant/ Machinery 15%:", purchaseDate: "20250701", amount: 200000 },
  { ledger: "Store Box", block: "5. Plant/ Machinery 15%:", purchaseDate: "20250701", amount: 210000 },
  { ledger: "Desk Set", block: null, purchaseDate: "20250801", amount: 0 },
  { ledger: "Notebook PC", block: null, purchaseDate: "20260113", amount: 50000 },
];

export const D3_EXPECTED_DELETIONS = [
  { ledger: "Pump Set", block: "5. Plant/ Machinery 15%:", date: "20250630", amount: 200000, basis: "transfer" },
  { ledger: "Old Loader", block: "5. Plant/ Machinery 15%:", date: "20251106", amount: 90000, basis: "receipt" },
  { ledger: "Old Tractor", block: "5. Plant/ Machinery 15%:", date: "20251215", amount: 300000, basis: "receipt" },
];