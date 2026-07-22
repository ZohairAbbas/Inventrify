import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Envelope encryption for third-party API keys.
 *
 * Courierify and Financify keys were stored as plaintext columns. Anyone with read
 * access to the database — a backup, a replica, a support query, a dump in a bug
 * report — could use them against the merchant's account on those services.
 *
 * Format: "enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>". Values that do not carry the
 * prefix are returned as-is on decrypt, so rows written before this change keep working
 * and get upgraded the next time they are saved.
 */

const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 16) return null;
  // Accept any passphrase length; derive a stable 32-byte key.
  return createHash("sha256").update(secret).digest();
}

/** True when encryption is configured. */
export function isEncryptionConfigured(): boolean {
  return key() !== null;
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  const k = key();
  if (!k) {
    // Fail loudly in logs but do not break the merchant's save; the value is stored
    // as before. Deployments should set ENCRYPTION_KEY.
    console.error(
      "[crypto] ENCRYPTION_KEY is not set — storing integration key unencrypted",
    );
    return plaintext;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext

  const k = key();
  if (!k) {
    console.error("[crypto] ENCRYPTION_KEY is not set — cannot decrypt integration key");
    return null;
  }

  try {
    const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(":");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    console.error(
      "[crypto] failed to decrypt integration key:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
