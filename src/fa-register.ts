import type { LedgerVoucherRow } from "./downstream.js";
import {
  classifyCredit, groupAcquisitions, netDiscounts, resolveRate, round2,
  type Acquisition, type DepCtx,
} from "./depreciation.js";
import { EMPTY_DEP_OPERATOR } from "./depreciation-file.js";
import { displayDate, money } from "./format.js";
import {
  faFindingId, FA_CHECK_ORDINAL, sideOf, ZERO_TOLERANCE,
  type FaCheckId, type FaFinding, type Severity,
} from "./types.js";

/**
 * The fixed asset purchase & sale register: a pure, Tally-free engine that
 * reuses the depreciation engine's exported acquisition grouping and credit
 * classification (design of record §3, D10). Its artifact is for auditors;
 * it recomputes nothing and changes no depreciation figure.
 */

/** Road-transport vocabulary, tested against the asset LEDGER name and its BLOCK GROUP name (D3). */
export const VEHICLE_NAME =
  /vehicle|motor ?cycle|two[- ]?wheeler|three[- ]?wheeler|auto ?rickshaw|\bcar\b|\blorry\b|\btruck\b|\btipper\b|\bbus\b|\bvan\b|\bjeep\b|\btempo\b|\btrailer\b|\bscooter\b|\bambulance\b/i;
export const INSURANCE_NAME = /insur/i;
export const RTO_NAME = /\brto\b|registrat|road tax|life tax|m\.?v\.? tax|motor vehicle tax/i;
export const ACCESSORY_NAME = /accessor|fitting|seat cover|music system|audio|gps|tracking device|fastag/i;

export type FaCostType = "insurance" | "rto" | "accessories";
export const COST_VOCAB: Record<FaCostType, RegExp> = {
  insurance: INSURANCE_NAME, rto: RTO_NAME, accessories: ACCESSORY_NAME,
};
export const COST_TYPES: readonly FaCostType[] = ["insurance", "rto", "accessories"];
/** Absence is flagged only for these: accessories are optional, insurance and registration are not (D4). */
export const ABSENCE_CHECKED: readonly FaCostType[] = ["insurance", "rto"];

export function isVehicleAsset(ledgerName: string, groupName: string): boolean {
  return VEHICLE_NAME.test(ledgerName) || VEHICLE_NAME.test(groupName);
}

export const VEHICLE_WINDOW_BEFORE_DAYS = 30;
export const VEHICLE_WINDOW_AFTER_DAYS = 90;

const at = (ymd: string): number =>
  Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));

/** True when `date` falls VEHICLE_WINDOW_BEFORE_DAYS before through VEHICLE_WINDOW_AFTER_DAYS after `firstUse`. */
export function inVehicleWindow(firstUse: string, date: string): boolean {
  const diff = (at(date) - at(firstUse)) / 86400000;
  return diff >= -VEHICLE_WINDOW_BEFORE_DAYS && diff <= VEHICLE_WINDOW_AFTER_DAYS;
}

const canon = (s: string): string => s.trim().toLowerCase();

const SEVERITY: Record<FaCheckId, Severity> = {
  fa_vehicle_incidental_expensed: "review",
  fa_vehicle_incidental_missing: "review",
  fa_vehicle_vendor_unsettled: "review",
  fa_disposal_unmatched: "review",
};
