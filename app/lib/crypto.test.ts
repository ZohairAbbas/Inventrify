import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isLegacyPlaintext,
  upgradeLegacySecret,
} from "./crypto.server";

const KEY = "test-encryption-key-0123456789";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = saved;
});

describe("upgradeLegacySecret", () => {
  it("re-encrypts a plaintext key so it decrypts back to the original", () => {
    const upgraded = upgradeLegacySecret("cfy_live_abc123");
    expect(upgraded).toMatch(/^enc:v1:/);
    expect(upgraded).not.toContain("cfy_live_abc123");
    expect(decryptSecret(upgraded)).toBe("cfy_live_abc123");
  });

  it("is idempotent: an encrypted or empty value needs nothing", () => {
    const encrypted = encryptSecret("cfy_live_abc123");
    expect(upgradeLegacySecret(encrypted)).toBeNull();
    expect(upgradeLegacySecret(null)).toBeNull();
    expect(upgradeLegacySecret("")).toBeNull();
  });

  it("refuses to run without an encryption key", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => upgradeLegacySecret("cfy_live_abc123")).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("isLegacyPlaintext", () => {
  it("tells plaintext from encrypted values", () => {
    expect(isLegacyPlaintext("cfy_live_abc123")).toBe(true);
    expect(isLegacyPlaintext(encryptSecret("x"))).toBe(false);
    expect(isLegacyPlaintext(null)).toBe(false);
  });
});
