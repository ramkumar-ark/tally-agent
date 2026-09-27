import { readFileSync } from "fs";
import { canonicalKey } from "./key.js";

export interface GstAdjHeadRoles {
  input: string; output: string; payable: string; unclaimed: string;
  tds: string; toBeBooked: string; toBeReversed: string;
}

export interface GstAdjConfig {
  voucherType: string;
  heads: Record<string, GstAdjHeadRoles>;
  gstTdsCredit: Record<string, Record<string, number>>;
  residualMarks: Record<string, Record<string, string>>;
  registration?: string;
}

const HEAD_NAMES = ["cgst", "sgst", "igst", "cess"] as const;
const HEAD_DISPLAY: Record<string, string> = { cgst: "CGST", sgst: "SGST", igst: "IGST", cess: "Cess" };

function defaultHeadRoles(display: string): GstAdjHeadRoles {
  return {
    input: `Input ${display} A/c`,
    output: `Output ${display} A/c`,
    payable: `${display} Payable A/c`,
    unclaimed: `Unclaimed ${display} A/c`,
    tds: `GST TDS ${display} A/c`,
    toBeBooked: `Input ${display} To Be Booked A/c`,
    toBeReversed: `Input ${display} To Be Reversed A/c`,
  };
}

function defaultConfig(): GstAdjConfig {
  const heads: Record<string, GstAdjHeadRoles> = {};
  for (const h of HEAD_NAMES) heads[h] = defaultHeadRoles(HEAD_DISPLAY[h]);
  return { voucherType: "Journal", heads, gstTdsCredit: {}, residualMarks: {} };
}

function throwKey(path: string | undefined, key: string, msg: string): never {
  const p = path ?? "<no config path>";
  throw new Error(`gst-adj config ${p}: ${key} — ${msg}`);
}

function normalizeMonth(key: string, path: string | undefined, parent: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) throwKey(path, `${parent}.${key}`, "key must be YYYY-MM");
  return key;
}

export function loadGstAdjConfig(path: string | undefined, warn: (msg: string) => void): GstAdjConfig {
  if (!path) {
    warn("gst-adj config: using defaults (no config file at <path>)");
    return defaultConfig();
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "unreadable";
    if (code === "ENOENT") {
      warn("gst-adj config: using defaults (no config file at " + path + ")");
      return defaultConfig();
    }
    warn("gst-adj config: unreadable at " + path + " — " + code);
    return defaultConfig();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throwKey(path, "<json>", "malformed JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throwKey(path, "<json>", "must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const cfg = defaultConfig();
  for (const [k, v] of Object.entries(obj)) {
    switch (k) {
      case "voucherType":
        if (typeof v !== "string") throwKey(path, k, "must be a string");
        cfg.voucherType = v;
        break;
      case "heads": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) throwKey(path, k, "must be an object");
        const headsObj = v as Record<string, unknown>;
        for (const [hk, hv] of Object.entries(headsObj)) {
          const canon = canonicalKey(hk);
          if (!HEAD_NAMES.includes(canon as typeof HEAD_NAMES[number])) {
            throwKey(path, `heads.${hk}`, "unknown head");
          }
          const roleObj = hv as Record<string, unknown> | undefined;
          if (!roleObj) throwKey(path, `heads.${hk}`, "must be an object");
          const merged = { ...cfg.heads[canon] };
          for (const [rk, rv] of Object.entries(roleObj)) {
            if (!(rk in merged)) throwKey(path, `heads.${hk}.${rk}`, "unknown role");
            if (typeof rv !== "string") throwKey(path, `heads.${hk}.${rk}`, "must be a string");
            (merged as Record<string, string>)[rk] = rv;
          }
          cfg.heads[canon] = merged;
        }
        break;
      }
      case "gstTdsCredit": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) throwKey(path, k, "must be an object");
        const creditObj = v as Record<string, unknown>;
        for (const [mk, mv] of Object.entries(creditObj)) {
          normalizeMonth(mk, path, k);
          const headObj = mv as Record<string, unknown> | undefined;
          if (!headObj) throwKey(path, `${k}.${mk}`, "must be an object");
          for (const [hk, hv] of Object.entries(headObj)) {
            if (typeof hv !== "number") throwKey(path, `${k}.${mk}.${hk}`, "must be a number");
            cfg.gstTdsCredit[mk] = cfg.gstTdsCredit[mk] ?? {};
            cfg.gstTdsCredit[mk][hk] = hv;
          }
        }
        break;
      }
      case "residualMarks": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) throwKey(path, k, "must be an object");
        const marksObj = v as Record<string, unknown>;
        for (const [mk, mv] of Object.entries(marksObj)) {
          normalizeMonth(mk, path, k);
          const headObj = mv as Record<string, unknown> | undefined;
          if (!headObj) throwKey(path, `${k}.${mk}`, "must be an object");
          for (const [hk, hv] of Object.entries(headObj)) {
            if (typeof hv !== "string") throwKey(path, `${k}.${mk}.${hk}`, "must be a string");
            cfg.residualMarks[mk] = cfg.residualMarks[mk] ?? {};
            cfg.residualMarks[mk][hk] = hv;
          }
        }
        break;
      }
      case "registration":
        if (typeof v !== "string") throwKey(path, k, "must be a string");
        cfg.registration = v;
        break;
      default:
        throwKey(path, k, "unknown key");
    }
  }
  return cfg;
}
