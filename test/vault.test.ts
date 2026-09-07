import { describe, expect, it } from "vitest";
import { createVault } from "../src/vault.js";

describe("vault", () => {
  it("gives the same alias for the same name", () => {
    const v = createVault();
    const a = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    const b = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    expect(a).toBe(b);
  });

  it("gives different aliases to different names", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).not.toBe(v.pseudonym("Beta", "creditor"));
  });

  it("labels the alias by role and numbers within that role", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).toBe("Creditor 1");
    expect(v.pseudonym("Beta", "creditor")).toBe("Creditor 2");
    expect(v.pseudonym("HDFC 50200012345678", "bank")).toBe("Bank 1");
  });

  it("matches names case-insensitively", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).toBe(v.pseudonym("ACME", "creditor"));
  });

  it("resolves an alias back to the real name", () => {
    const v = createVault();
    const alias = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    expect(v.resolve(alias)).toBe("Acme Traders Pvt Ltd");
  });

  it("returns undefined for an alias it never issued", () => {
    expect(createVault().resolve("Creditor 99")).toBeUndefined();
  });
});
