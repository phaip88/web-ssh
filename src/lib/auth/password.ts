import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}
const N = 16384;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEYLEN, { N })) as Buffer;
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, nStr, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !nStr || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = (await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(nStr),
  })) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include upper, lower case letters and digits";
  }
  return null;
}
