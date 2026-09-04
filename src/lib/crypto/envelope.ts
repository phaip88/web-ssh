/**
 * Envelope encryption: each secret gets a random Data Encryption Key (DEK)
 * which is itself wrapped by the Key Encryption Key (KEK) loaded from
 * APP_MASTER_KEY. Rotating the KEK only requires re-wrapping DEKs, and a
 * KMS/Vault backed KEK can replace the local one without touching ciphertexts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isProduction } from "@/lib/config";

export interface EnvelopePayload {
  v: 1;
  alg: "aes-256-gcm";
  keyVersion: number;
  wrappedDek: string; // base64: iv|tag|ciphertext
  ciphertext: string; // base64: iv|tag|ciphertext
}

let cachedKek: Buffer | null = null;

function loadKek(): Buffer {
  if (cachedKek) return cachedKek;
  const raw = process.env.APP_MASTER_KEY;
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error("APP_MASTER_KEY must be 32 bytes, base64 encoded");
    }
    cachedKek = buf;
    return buf;
  }
  if (isProduction()) {
    // Never silently fall back to a known key in production.
    throw new Error("APP_MASTER_KEY is required when APP_ENV=production");
  }
  console.warn("[security] APP_MASTER_KEY not set – using an insecure DEVELOPMENT-ONLY key");
  cachedKek = createHash("sha256").update("webssh-dev-only-master-key-do-not-use").digest();
  return cachedKek;
}

function aeadEncrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function aeadDecrypt(key: Buffer, packed: string, aad: string): Buffer {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptSecret(plaintext: string, aad = "webssh"): EnvelopePayload {
  const kek = loadKek();
  const dek = randomBytes(32);
  try {
    return {
      v: 1,
      alg: "aes-256-gcm",
      keyVersion: 1,
      wrappedDek: aeadEncrypt(kek, dek, `dek:${aad}`),
      ciphertext: aeadEncrypt(dek, Buffer.from(plaintext, "utf8"), aad),
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Returns the plaintext as a Buffer so callers can zero it after use.
 */
export function decryptSecretBuffer(payload: EnvelopePayload, aad = "webssh"): Buffer {
  const kek = loadKek();
  const dek = aeadDecrypt(kek, payload.wrappedDek, `dek:${aad}`);
  try {
    return aeadDecrypt(dek, payload.ciphertext, aad);
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(payload: EnvelopePayload, aad = "webssh"): string {
  const buf = decryptSecretBuffer(payload, aad);
  const s = buf.toString("utf8");
  buf.fill(0);
  return s;
}

export function isEnvelopePayload(x: unknown): x is EnvelopePayload {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as EnvelopePayload).v === 1 &&
    typeof (x as EnvelopePayload).wrappedDek === "string" &&
    typeof (x as EnvelopePayload).ciphertext === "string"
  );
}
