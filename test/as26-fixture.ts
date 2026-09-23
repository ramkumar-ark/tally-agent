// test/as26-fixture.ts — invented data only, real TRACES layout (§0).
import { buildWorkbook, type CellValue, type Sheet } from "../src/xlsx.js";

const BLANKS = 16;
const cols = Array.from({ length: BLANKS }, () => ({ header: "", width: 8 }));

const row = (...cells: CellValue[]): CellValue[] => cells;

// Machine headers of the summary sheets, per §0.1/§0.3.
const TDS_SUMMARY_HEADERS = ["DEDUCTORNAME", "TAN", "TDSOWN", "TDSCLAIMEDCY",
  "BALANCETDSCF", "GROSSRECEIPTSASPER26AS", "HEADOFINCOME", "GROSSRECEIPT", "SECTION"];
const TCS_SUMMARY_HEADERS = ["COLLECTORNAME", "TAN", "TCSCOLLECTED", "TCSCLAIMEDCY",
  "BALANCETDSCF", "EXPENDITURE26AS", "HEADOFINCOME", "GROSSRECEIPT", "SECTION"];
const TDS_DETAIL_HEADERS = ["Name of Deductor", "Transaction Date", "Amount Paid / Credited(Rs.)",
  "Total amount paid-Deductorwise", "Tax Deducted(Rs.)", "Total Tax Deducted-Deductorwise",
  "TAN of Deductor", "TDS Deposited(Rs.)", "Status of Booking", "Date of Booking", "Section"];
const TCS_DETAIL_HEADERS = ["Name of Collector", "Transaction Date", "Amount Paid/Debited(Rs.)",
  "Total amount paid-Collectorwise", "Tax Collected(Rs.)", "Total Tax Collected-Collectorwise",
  "TAN of Collector", "TCS Deposited(Rs.)", "Status of Booking", "Date of Booking", "Section"];

export interface As26FixtureOpts {
  /** Two TDS deductors: one name that canonical-matches a books ledger, one that needs the operator map. */
  tdsSummary: CellValue[][];
  tdsDetail: CellValue[][];
  tcsSummary: CellValue[][];
  tcsDetail: CellValue[][];
}

/** The invented baseline: figures chosen so every check fires somewhere downstream. */
export function defaultAs26Fixture(): As26FixtureOpts {
  const tdsSummary = [
    row("TDS", "TDS - Form 16A", "8", "1.0"),
    row(...TDS_SUMMARY_HEADERS),
    row(), row(),
    row("Name of Deductor", "TAN", "TDS Deducted (Rs.)"),
    row(), row("-", "-", "-", "-", "-", "-", "-", "-", "-"),
    // data rows: name, TAN(never bound), taxOwn, claimedCf, balCf, gross, head, grossReceipt, section
    row("Nagar Palika Nagar Bhavan", "MUMA01234E", 18000, 18000, 0, 900000, "", 900000, "194C"),
    row("Anand Buildmart Pvt Ltd", "PUNB05678F", 4600.15, 4600.15, 0, 230000, "", 230000, "194C"),
  ];
  const tdsDetail = [
    row(), row(),
    row(...TDS_DETAIL_HEADERS),
    // name, date(text), amount, subtotal(D,never bound), tax, subtotal(F,never bound),
    // TAN(never bound), deposited(never bound), status, bookingDate, section
    row("NAGAR PALIKA NAGAR BHAVAN", "14-Apr-2025", 300000, null, 6000, null, "MUMA01234E", null, "F", "30-May-2025", "194C"),
    row(null, "12-Jun-2025", 400000, null, 8000, 12000, null, null, "F", "28-Jul-2025", "194C"),
    row("ANAND BUILDMART PVT LTD", "09-Sep-2025", 230000.8900000001, null, 4600.15, 4600.15, "PUNB05678F", null, "F", "15-Oct-2025", "194C"),
  ];
  const tcsSummary = [
    row("TCS", "TCS", "8", "1.0"),
    row(...TCS_SUMMARY_HEADERS),
    row(), row(),
    row("Name of Collector", "TAN", "TCS Collected (Rs.)"),
    row(), row("-", "-", "-", "-", "-", "-", "-", "-", "-"),
    row("Kaveri Minerals Trading", "BLRA09876D", 1200, 1200, 0, 60000, "", 60000, "206CL"),
  ];
  const tcsDetail = [
    row(), row(),
    row(...TCS_DETAIL_HEADERS),
    row("KAVERI MINERALS TRADING", "03-Nov-2025", 60000, null, 1200, 1200, "BLRA09876D", null, "F", "12-Dec-2025", "206CL"),
  ];
  return { tdsSummary, tdsDetail, tcsSummary, tcsDetail };
}

export function buildAs26Fixture(opts: As26FixtureOpts = defaultAs26Fixture()): Buffer {
  const sheet = (name: string, state: string, rows: CellValue[][]): Sheet => ({
    name, state, columns: cols, rows,
  });
  return buildWorkbook([
    sheet("Enable Macros", "visible", [row("Enable Macros")]),
    sheet("TDS - Form 16A", "hidden", opts.tdsSummary),
    sheet("TDS_Detailed", "hidden", opts.tdsDetail),
    sheet("TCS", "hidden", opts.tcsSummary),
    sheet("TCS_Detailed", "hidden", opts.tcsDetail),
    sheet("TDS - Form 16B,16C,16D,16E", "hidden", []),
  ]);
}
