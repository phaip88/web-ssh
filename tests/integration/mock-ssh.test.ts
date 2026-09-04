/**
 * Integration: real SSH handshake against the in-process mock server using
 * ssh2's client, covering password auth, host key fingerprinting, shell I/O
 * and exec channels (the same primitives the gateway uses).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "ssh2";
import { startMockSshServer } from "@/lib/mock-ssh/server";
import { sha256Fingerprint } from "@/lib/ssh/connect";
import { createVirtualShell } from "@/lib/mock-ssh/vshell";

const PORT = 2299;

function connect(opts: { password: string; verifier?: (key: Buffer) => boolean }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c)).on("error", reject);
    c.connect({ host: "127.0.0.1", port: PORT, username: "demo", password: opts.password, hostVerifier: (key: Buffer) => (opts.verifier ? opts.verifier(key) : true), readyTimeout: 5000 });
  });
}

function exec(c: Client, cmd: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", (code: number | null) => resolve({ out, code }));
    });
  });
}

describe("mock ssh server", () => {
  beforeAll(() => {
    startMockSshServer();
  });
  afterAll(() => undefined);

  it("rejects bad passwords", async () => {
    await expect(connect({ password: "wrong" })).rejects.toBeTruthy();
  });

  it("presents a stable host key fingerprint and honours the verifier", async () => {
    let fp1 = "";
    const c1 = await connect({ password: "demo-password", verifier: (k) => ((fp1 = sha256Fingerprint(k)), true) });
    c1.end();
    let fp2 = "";
    const c2 = await connect({ password: "demo-password", verifier: (k) => ((fp2 = sha256Fingerprint(k)), true) });
    c2.end();
    expect(fp1).toMatch(/^SHA256:/);
    expect(fp1).toBe(fp2);
    await expect(connect({ password: "demo-password", verifier: () => false })).rejects.toBeTruthy();
  });

  it("executes virtual commands over an exec channel", async () => {
    const c = await connect({ password: "demo-password" });
    const r = await exec(c, "df -h");
    expect(r.out).toContain("/dev/vda1");
    expect(r.code).toBe(0);
    const g = await exec(c, "grep -c ERROR /var/log/app/app.log");
    expect(g.out.trim()).toBe("4");
    const missing = await exec(c, "cat /nope");
    expect(missing.code).toBe(1);
    c.end();
  });

  it("serves an interactive shell with echo and prompt", async () => {
    const c = await connect({ password: "demo-password" });
    const out = await new Promise<string>((resolve, reject) => {
      c.shell({ term: "xterm", cols: 80, rows: 24 }, (err, stream) => {
        if (err) return reject(err);
        let buf = "";
        stream.on("data", (d: Buffer) => {
          buf += d.toString();
          if (buf.includes("mock-web-01") && buf.includes("$ ") && !buf.includes("uid=")) stream.write("id\r");
          if (buf.includes("uid=1000")) {
            stream.end();
            resolve(buf);
          }
        });
      });
    });
    expect(out).toContain("groups=1000(demo),27(sudo)");
    c.end();
  });

  it("virtual shell never touches the real filesystem", () => {
    let out = "";
    const sh = createVirtualShell({ user: "demo", hostname: "h", interactive: false, write: (s) => (out += s), exit: () => undefined, size: () => ({ cols: 80, rows: 24 }) });
    expect(sh.runLine("rm -rf /")).toBe(1);
    expect(out).toContain("protected by mock server");
    out = "";
    sh.runLine("cat /etc/passwd");
    expect(out).toContain("demo:x:1000");
  });
});
