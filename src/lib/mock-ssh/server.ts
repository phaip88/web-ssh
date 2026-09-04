/**
 * Mock SSH server for local development and automated tests. It speaks real
 * SSH (via ssh2's server implementation) but executes NOTHING on the host:
 * commands run against an in-memory virtual filesystem/shell. Its host key is
 * persisted under .data/ so fingerprints stay stable across restarts.
 */
import { generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server, type ServerChannel } from "ssh2";
import { config } from "@/lib/config";
import { createVirtualShell } from "./vshell";

const g = globalThis as typeof globalThis & { __mockSshServer?: Server };

function loadOrCreateHostKey(): Buffer {
  const dir = join(process.cwd(), ".data");
  const file = join(dir, "mock-ssh-host-key.pem");
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  writeFileSync(file, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function startMockSshServer(): Server | null {
  if (!config.mockSshEnabled()) return null;
  if (g.__mockSshServer) return g.__mockSshServer;
  const port = config.mockSshPort();
  const user = config.mockSshUser();
  const password = config.mockSshPassword();

  const server = new Server({ hostKeys: [loadOrCreateHostKey()], ident: "SSH-2.0-WebSSH-Mock" }, (client) => {
    let authedUser = "";
    client
      .on("authentication", (ctx) => {
        if (ctx.method === "password" && safeEqual(ctx.username, user) && safeEqual(ctx.password, password)) {
          authedUser = ctx.username;
          return ctx.accept();
        }
        if (ctx.method === "publickey" && ctx.username === user) {
          // Any key is accepted for the demo user so key-based flows can be exercised in tests.
          authedUser = ctx.username;
          return ctx.accept();
        }
        ctx.reject(["password", "publickey"]);
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          let cols = 80;
          let rows = 24;
          session.on("pty", (acceptPty, _reject, info) => {
            cols = info.cols;
            rows = info.rows;
            acceptPty?.();
          });
          session.on("window-change", (acceptWc, _reject, info) => {
            cols = info.cols;
            rows = info.rows;
            acceptWc?.();
          });
          session.on("shell", (acceptShell) => {
            const channel: ServerChannel = acceptShell();
            const shell = createVirtualShell({ user: authedUser, hostname: "mock-web-01", interactive: true, write: (s) => channel.write(s), exit: () => channel.end(), size: () => ({ cols, rows }) });
            shell.start();
            channel.on("data", (d: Buffer) => shell.input(d.toString("utf8")));
            channel.on("close", () => shell.dispose());
          });
          session.on("exec", (acceptExec, _reject, info) => {
            const channel = acceptExec();
            const shell = createVirtualShell({ user: authedUser, hostname: "mock-web-01", interactive: false, write: (s) => channel.write(s), exit: () => undefined, size: () => ({ cols, rows }) });
            const code = shell.runLine(info.command);
            channel.exit(code);
            channel.end();
          });
        });
      })
      .on("error", () => {
        /* client errors are expected during scans/tests */
      });
  });
  server.on("error", (err: Error) => console.error("[mock-ssh] server error", err.message));
  server.listen(port, "127.0.0.1", () => console.log(`[mock-ssh] listening on 127.0.0.1:${port} (user=${user})`));
  g.__mockSshServer = server;
  return server;
}
