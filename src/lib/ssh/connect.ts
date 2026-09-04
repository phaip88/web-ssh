/**
 * Builds ssh2 connection configs from host + credential records, enforcing the
 * host key policy. Secrets are decrypted here, handed to ssh2 and zeroed as
 * soon as the handshake completes.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ConnectConfig } from "ssh2";
import { db } from "@/db";
import { credentials, sshHostKeys, sshHosts } from "@/db/schema";
import { decryptSecret, isEnvelopePayload } from "@/lib/crypto/envelope";
import { ApiError } from "@/lib/http";
import { audit } from "@/lib/audit";

export type HostRow = typeof sshHosts.$inferSelect;

export interface SecretPayload {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  certificate?: string;
}

export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export interface HostKeyOutcome {
  status: "trusted" | "unknown" | "mismatch";
  fingerprint: string;
  keyType: string;
}

/**
 * Creates a hostVerifier callback. The outcome is captured so the caller can
 * translate a rejected handshake into a precise error (unknown vs. changed).
 */
export async function buildHostVerifier(host: HostRow, actorId: string) {
  const known = await db
    .select()
    .from(sshHostKeys)
    .where(and(eq(sshHostKeys.hostId, host.id), eq(sshHostKeys.status, "trusted")));
  const outcome: { current: HostKeyOutcome | null } = { current: null };

  const verifier = (key: Buffer, cb: (ok: boolean) => void) => {
    const fingerprint = sha256Fingerprint(key);
    const keyType = key.subarray(4, 4 + key.readUInt32BE(0)).toString();
    const match = known.find((k) => k.fingerprintSha256 === fingerprint);
    if (match) {
      outcome.current = { status: "trusted", fingerprint, keyType };
      return cb(true);
    }
    if (known.length > 0) {
      outcome.current = { status: "mismatch", fingerprint, keyType };
      void audit({
        actorId,
        tenantId: host.orgId,
        workspaceId: host.workspaceId,
        resourceType: "ssh_host",
        resourceId: host.id,
        action: "ssh.hostkey.mismatch",
        result: "denied",
        riskLevel: "R4",
        metadata: { presented: fingerprint, expected: known.map((k) => k.fingerprintSha256) },
      });
      return cb(false);
    }
    outcome.current = { status: "unknown", fingerprint, keyType };
    // Persist the presented key as pending so the UI can offer an explicit approval.
    void db
      .insert(sshHostKeys)
      .values({ orgId: host.orgId, hostId: host.id, keyType, fingerprintSha256: fingerprint, publicKey: key.toString("base64"), status: host.hostKeyPolicy === "tofu" ? "trusted" : "pending", approvedBy: host.hostKeyPolicy === "tofu" ? actorId : null, approvedAt: host.hostKeyPolicy === "tofu" ? new Date() : null })
      .onConflictDoNothing();
    if (host.hostKeyPolicy === "tofu") {
      outcome.current = { status: "trusted", fingerprint, keyType };
      return cb(true);
    }
    return cb(false);
  };
  return { verifier, outcome };
}

export async function loadSecret(credentialId: string, orgId: string): Promise<SecretPayload> {
  const [cred] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.id, credentialId), eq(credentials.orgId, orgId)))
    .limit(1);
  if (!cred || cred.deletedAt) throw new ApiError("NOT_FOUND", "Credential not found");
  if (cred.revokedAt) throw new ApiError("FORBIDDEN", "Credential has been revoked");
  if (cred.expiresAt && cred.expiresAt < new Date()) throw new ApiError("FORBIDDEN", "Credential has expired");
  if (!isEnvelopePayload(cred.encryptedSecret)) throw new ApiError("INTERNAL", "Credential payload is corrupt");
  const parsed = JSON.parse(decryptSecret(cred.encryptedSecret, `credential:${cred.id}`)) as SecretPayload;
  await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, cred.id));
  return parsed;
}

export function scrubSecret(secret: SecretPayload) {
  // Strings are immutable in JS; dropping references is the best we can do here.
  // ssh2 receives Buffers for key material which we zero below.
  secret.password = undefined;
  secret.privateKey = undefined;
  secret.passphrase = undefined;
}

export async function buildConnectConfig(host: HostRow, actorId: string): Promise<{ config: ConnectConfig; outcome: { current: HostKeyOutcome | null }; cleanup: () => void }> {
  if (!host.credentialId) throw new ApiError("VALIDATION_ERROR", "Host has no credential bound");
  const secret = await loadSecret(host.credentialId, host.orgId);
  const { verifier, outcome } = await buildHostVerifier(host, actorId);
  const buffers: Buffer[] = [];
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: host.connectionTimeout * 1000,
    keepaliveInterval: host.keepaliveInterval * 1000,
    hostVerifier: verifier,
    // Agent forwarding is opt-in per host and can be disabled tenant-wide by policy.
    agentForward: false,
  };
  if (host.authType === "password") {
    if (!secret.password) throw new ApiError("VALIDATION_ERROR", "Credential has no password");
    cfg.password = secret.password;
  } else {
    if (!secret.privateKey) throw new ApiError("VALIDATION_ERROR", "Credential has no private key");
    const keyBuf = Buffer.from(secret.privateKey, "utf8");
    buffers.push(keyBuf);
    cfg.privateKey = keyBuf;
    if (secret.passphrase) cfg.passphrase = secret.passphrase;
  }
  const cleanup = () => {
    for (const b of buffers) b.fill(0);
    scrubSecret(secret);
  };
  return { config: cfg, outcome, cleanup };
}
