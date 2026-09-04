/**
 * Deterministic virtual shell used by the mock SSH server. Nothing here
 * touches the real operating system.
 */
export interface VShellOptions {
  user: string;
  hostname: string;
  interactive: boolean;
  write: (s: string) => void;
  exit: () => void;
  size: () => { cols: number; rows: number };
}

type VNode = { type: "dir"; children: Record<string, VNode> } | { type: "file"; content: string };

function dir(children: Record<string, VNode>): VNode {
  return { type: "dir", children };
}
function file(content: string): VNode {
  return { type: "file", content };
}

function buildFs(): VNode {
  const nginxLog = Array.from({ length: 40 }, (_, i) => {
    const status = i % 9 === 0 ? 502 : i % 7 === 0 ? 500 : 200;
    return `10.0.0.${(i % 20) + 1} - - [12/Mar/2026:10:${String(i).padStart(2, "0")}:11 +0000] "GET /api/orders HTTP/1.1" ${status} ${120 + i * 3} "-" "curl/8.5"`;
  }).join("\n");
  const appLog = [
    "2026-03-12T10:00:01Z INFO  server started on :8080",
    "2026-03-12T10:04:12Z WARN  db pool: 18/20 connections in use",
    "2026-03-12T10:05:44Z ERROR db pool exhausted: timeout acquiring connection after 5000ms",
    "2026-03-12T10:05:44Z ERROR request failed path=/api/orders status=500 err=pool timeout",
    "2026-03-12T10:06:02Z ERROR disk usage on /var/lib/app exceeded 92%",
    "2026-03-12T10:06:30Z ERROR OOMKilled worker pid=4123 rss=1.9GiB",
  ].join("\n");
  return dir({
    etc: dir({
      hostname: file("mock-web-01\n"),
      "os-release": file('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'),
      nginx: dir({ "nginx.conf": file("user www-data;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp { include /etc/nginx/sites-enabled/*; }\n") }),
      passwd: file("root:x:0:0:root:/root:/bin/bash\ndemo:x:1000:1000::/home/demo:/bin/bash\n"),
    }),
    home: dir({ demo: dir({ "README.md": file("# demo host\nThis is a virtual filesystem served by the WebSSH mock SSH server.\n"), ".bashrc": file("# ~/.bashrc\n"), app: dir({ "config.yaml": file("server:\n  port: 8080\ndatabase:\n  pool_size: 20\n  host: db.internal\n") }) }) }),
    var: dir({ log: dir({ nginx: dir({ "access.log": file(nginxLog + "\n"), "error.log": file("2026/03/12 10:05:44 [error] 1234#1234: *88 upstream prematurely closed connection while reading response header from upstream, client: 10.0.0.9, request: \"GET /api/orders HTTP/1.1\", upstream: \"http://127.0.0.1:8080/api/orders\"\n") }), app: dir({ "app.log": file(appLog + "\n") }), syslog: file("Mar 12 10:06:30 mock-web-01 kernel: Out of memory: Killed process 4123 (app-worker) total-vm:2400000kB\n") }), lib: dir({ app: dir({}) }) }),
    tmp: dir({}),
    proc: dir({ loadavg: file("2.31 1.87 1.42 3/412 5123\n"), meminfo: file("MemTotal:        4030000 kB\nMemFree:          210000 kB\nMemAvailable:     640000 kB\n") }),
  });
}

const PS = `USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root           1  0.0  0.1 168000 11000 ?        Ss   Mar11   0:04 /sbin/init
root         612  0.0  0.3  72000 24000 ?        Ss   Mar11   0:02 /usr/sbin/sshd -D
www-data    1234  0.4  0.9 210000 38000 ?        S    Mar11   1:12 nginx: worker process
demo        4090  0.0  0.2  12000  9000 ?        Ss   Mar11   0:00 /home/demo/app/app-server
demo        4124 92.5 45.1 2400000 1820000 ?     R    10:06  5:44 /home/demo/app/app-worker
demo        5123  0.0  0.1   8000  4000 pts/0    R+   10:10   0:00 ps aux
`;

export function createVirtualShell(opts: VShellOptions) {
  const root = buildFs();
  let cwd = `/home/${opts.user}`;
  let line = "";
  let disposed = false;
  const history: string[] = [];
  const env: Record<string, string> = { HOME: `/home/${opts.user}`, USER: opts.user, PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash", TERM: "xterm-256color", APP_ENV: "production" };

  const out = (s: string) => {
    if (!disposed) opts.write(opts.interactive ? s.replace(/\n/g, "\r\n") : s);
  };
  const prompt = () => out(`\x1b[1;32m${opts.user}@${opts.hostname}\x1b[0m:\x1b[1;34m${cwd.replace(`/home/${opts.user}`, "~")}\x1b[0m$ `);

  const resolve = (p: string): string => {
    if (!p) return cwd;
    let full = p.startsWith("~") ? `${env.HOME}${p.slice(1)}` : p.startsWith("/") ? p : `${cwd}/${p}`;
    const parts: string[] = [];
    for (const seg of full.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    full = "/" + parts.join("/");
    return full;
  };
  const node = (p: string): VNode | null => {
    let cur: VNode = root;
    for (const seg of resolve(p).split("/").filter(Boolean)) {
      if (cur.type !== "dir" || !cur.children[seg]) return null;
      cur = cur.children[seg];
    }
    return cur;
  };

  const commands: Record<string, (args: string[]) => number> = {
    echo: (a) => (out(a.map((x) => x.replace(/^\$(\w+)$/, (_, v) => env[v] ?? "")).join(" ") + "\n"), 0),
    pwd: () => (out(cwd + "\n"), 0),
    whoami: () => (out(opts.user + "\n"), 0),
    id: () => (out(`uid=1000(${opts.user}) gid=1000(${opts.user}) groups=1000(${opts.user}),27(sudo)\n`), 0),
    hostname: () => (out(opts.hostname + "\n"), 0),
    uname: (a) => (out((a.includes("-a") ? `Linux ${opts.hostname} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux` : "Linux") + "\n"), 0),
    uptime: () => (out(" 10:10:42 up 1 day,  3:22,  1 user,  load average: 2.31, 1.87, 1.42\n"), 0),
    date: () => (out(new Date().toUTCString() + "\n"), 0),
    env: () => (out(Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"), 0),
    printenv: () => (out(Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"), 0),
    history: () => (out(history.map((h, i) => `  ${i + 1}  ${h}`).join("\n") + "\n"), 0),
    clear: () => (out("\x1b[2J\x1b[H"), 0),
    cd: (a) => {
      const target = resolve(a[0] ?? "~");
      const n = node(target);
      if (!n || n.type !== "dir") return out(`bash: cd: ${a[0]}: No such file or directory\n`), 1;
      cwd = target;
      return 0;
    },
    ls: (a) => {
      const long = a.includes("-l") || a.includes("-la") || a.includes("-al");
      const all = a.includes("-a") || a.includes("-la") || a.includes("-al");
      const target = a.find((x) => !x.startsWith("-")) ?? ".";
      const n = node(target);
      if (!n) return out(`ls: cannot access '${target}': No such file or directory\n`), 2;
      if (n.type === "file") return out(target + "\n"), 0;
      const names = Object.keys(n.children).filter((k) => all || !k.startsWith(".")).sort();
      if (long) {
        out(`total ${names.length}\n`);
        for (const k of names) {
          const c = n.children[k];
          out(`${c.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--"} 1 ${opts.user} ${opts.user} ${c.type === "dir" ? 4096 : c.content.length} Mar 12 10:00 ${k}\n`);
        }
      } else out(names.join("  ") + (names.length ? "\n" : ""));
      return 0;
    },
    cat: (a) => {
      let code = 0;
      for (const f of a.filter((x) => !x.startsWith("-"))) {
        const n = node(f);
        if (!n) (out(`cat: ${f}: No such file or directory\n`), (code = 1));
        else if (n.type === "dir") (out(`cat: ${f}: Is a directory\n`), (code = 1));
        else out(n.content);
      }
      return code;
    },
    head: (a) => tailHead(a, "head"),
    tail: (a) => tailHead(a, "tail"),
    grep: (a) => {
      const flags = a.filter((x) => x.startsWith("-"));
      const rest = a.filter((x) => !x.startsWith("-"));
      const [pattern, ...files] = rest;
      if (!pattern) return out("usage: grep PATTERN FILE...\n"), 2;
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags.includes("-i") ? "i" : "");
      } catch {
        return out("grep: invalid pattern\n"), 2;
      }
      let found = 0;
      for (const f of files) {
        const n = node(f);
        if (!n || n.type !== "file") continue;
        for (const l of n.content.split("\n")) {
          if (!re.test(l)) continue;
          found++;
          if (!flags.includes("-c")) out((files.length > 1 ? `${f}:` : "") + l + "\n");
        }
      }
      if (flags.includes("-c")) out(String(found) + "\n");
      return found ? 0 : 1;
    },
    wc: (a) => {
      const f = a.find((x) => !x.startsWith("-"));
      const n = f ? node(f) : null;
      if (!n || n.type !== "file") return out(`wc: ${f}: No such file or directory\n`), 1;
      out(`${n.content.split("\n").length - 1} ${n.content.split(/\s+/).filter(Boolean).length} ${n.content.length} ${f}\n`);
      return 0;
    },
    df: () => (out("Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        40G   37G  2.1G  95% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm\n/dev/vdb1       100G   92G  8.0G  92% /var/lib/app\n"), 0),
    du: () => (out("4.0K\t./app\n8.0K\t.\n"), 0),
    free: (a) => (out(a.includes("-h") || a.includes("-m") ? "               total        used        free      shared  buff/cache   available\nMem:           3.8Gi       3.2Gi       205Mi        12Mi       450Mi       625Mi\nSwap:             0B          0B          0B\n" : "               total        used        free      shared  buff/cache   available\nMem:         4030000     3350000      210000       12000      470000      640000\nSwap:              0           0           0\n"), 0),
    ps: () => (out(PS), 0),
    top: () => (out("top - 10:10:42 up 1 day, load average: 2.31, 1.87, 1.42\nTasks: 112 total, 2 running\n%Cpu(s): 92.5 us, 3.1 sy\n" + PS), 0),
    nproc: () => (out("2\n"), 0),
    systemctl: (a) => {
      const sub = a.find((x) => !x.startsWith("-"));
      const unit = a.filter((x) => !x.startsWith("-"))[1] ?? "app";
      if (sub === "status") return out(`● ${unit}.service - ${unit}\n     Loaded: loaded (/etc/systemd/system/${unit}.service; enabled)\n     Active: ${unit === "app" ? "activating (auto-restart) (Result: oom-kill)" : "active (running)"} since Wed 2026-03-12 10:06:31 UTC\n`), unit === "app" ? 3 : 0;
      if (sub === "list-units") return out("UNIT             LOAD   ACTIVE SUB     DESCRIPTION\napp.service      loaded failed failed  app\nnginx.service    loaded active running nginx\nssh.service      loaded active running OpenSSH\n"), 0;
      if (sub === "is-active") return out(unit === "app" ? "activating\n" : "active\n"), unit === "app" ? 3 : 0;
      out(`[mock] systemctl ${a.join(" ")}: operation simulated (no changes applied)\n`);
      return 0;
    },
    journalctl: () => (out(node("/var/log/app/app.log")!.type === "file" ? (node("/var/log/app/app.log") as { type: "file"; content: string }).content : ""), 0),
    docker: (a) => {
      if (a[0] === "ps") return out("CONTAINER ID   IMAGE           COMMAND        STATUS                      PORTS                  NAMES\n3f1a9c2b7d10   app:1.4.2       \"/app/server\"  Restarting (137) 8s ago                            app\n8b2c1d3e4f50   nginx:1.27      \"nginx -g …\"   Up 26 hours                 0.0.0.0:80->80/tcp     edge\n"), 0;
      if (a[0] === "logs") return out("fatal error: runtime: out of memory\n"), 0;
      out(`[mock] docker ${a.join(" ")}: simulated\n`);
      return 0;
    },
    kubectl: (a) => (out(a[0] === "get" ? "NAME                   READY   STATUS             RESTARTS   AGE\napp-7d9f8b6c5-x2k9q    0/1     CrashLoopBackOff   12         26h\napp-7d9f8b6c5-p4m1z    1/1     Running            0          26h\n" : `[mock] kubectl ${a.join(" ")}: simulated\n`), 0),
    mkdir: (a) => {
      const p = a.find((x) => !x.startsWith("-"));
      if (!p) return 1;
      const parent = node(resolve(p).split("/").slice(0, -1).join("/") || "/");
      if (!parent || parent.type !== "dir") return out(`mkdir: cannot create directory '${p}'\n`), 1;
      parent.children[resolve(p).split("/").pop()!] = dir({});
      return 0;
    },
    touch: (a) => {
      const p = a[0];
      if (!p) return 1;
      const parent = node(resolve(p).split("/").slice(0, -1).join("/") || "/");
      if (!parent || parent.type !== "dir") return 1;
      const name = resolve(p).split("/").pop()!;
      if (!parent.children[name]) parent.children[name] = file("");
      return 0;
    },
    rm: (a) => {
      const targets = a.filter((x) => !x.startsWith("-"));
      for (const t of targets) {
        const full = resolve(t);
        if (full === "/" || full.split("/").length <= 2) return out(`rm: refusing to remove '${t}': protected by mock server\n`), 1;
        const parent = node(full.split("/").slice(0, -1).join("/") || "/");
        if (parent?.type === "dir") delete parent.children[full.split("/").pop()!];
      }
      return 0;
    },
    sleep: () => 0,
    true: () => 0,
    false: () => 1,
    exit: () => {
      out("logout\n");
      opts.exit();
      return 0;
    },
    logout: () => (opts.exit(), 0),
  };

  function tailHead(a: string[], mode: "head" | "tail"): number {
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-n") n = Number(a[++i]);
      else if (/^-\d+$/.test(a[i])) n = Number(a[i].slice(1));
      else if (!a[i].startsWith("-")) files.push(a[i]);
    }
    let code = 0;
    for (const f of files) {
      const nd = node(f);
      if (!nd || nd.type !== "file") (out(`${mode}: cannot open '${f}' for reading: No such file or directory\n`), (code = 1));
      else {
        const lines = nd.content.replace(/\n$/, "").split("\n");
        out((mode === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n") + "\n");
      }
    }
    return code;
  }

  function split(cmd: string): string[] {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    const outArr: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd))) outArr.push(m[1] ?? m[2] ?? m[3]);
    return outArr;
  }

  function runSimple(cmd: string): number {
    const parts = split(cmd.trim());
    if (!parts.length) return 0;
    let [name, ...args] = parts;
    if (name === "sudo") {
      out(`[mock] sudo: simulated privilege elevation for '${args.join(" ")}'\n`);
      [name, ...args] = args;
      if (!name) return 0;
    }
    const fn = commands[name];
    if (!fn) return out(`bash: ${name}: command not found\n`), 127;
    return fn(args);
  }

  function runLine(lineText: string): number {
    if (lineText.trim()) history.push(lineText);
    // Support ; && || and simple pipes into grep/head/tail/wc by capturing output.
    let code = 0;
    for (const seg of lineText.split(/;|&&/)) {
      const stages = seg.split("|").map((s) => s.trim()).filter(Boolean);
      if (stages.length <= 1) {
        code = runSimple(seg);
        continue;
      }
      let buffer = "";
      const origWrite = opts.write;
      opts.write = (s) => (buffer += s);
      code = runSimple(stages[0]);
      for (const stage of stages.slice(1)) {
        const input = buffer;
        buffer = "";
        const parts = split(stage);
        const lines = input.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
        if (parts[0] === "grep") {
          const pat = parts.filter((x) => !x.startsWith("-"))[1];
          const inv = parts.includes("-v");
          const re = new RegExp(pat ?? "", parts.includes("-i") ? "i" : "");
          const matched = lines.filter((l) => re.test(l) !== inv);
          buffer = parts.includes("-c") ? `${matched.length}\n` : matched.join("\n") + (matched.length ? "\n" : "");
        } else if (parts[0] === "head" || parts[0] === "tail") {
          const nIdx = parts.indexOf("-n");
          const n = nIdx >= 0 ? Number(parts[nIdx + 1]) : Number((parts.find((p) => /^-\d+$/.test(p)) ?? "-10").slice(1));
          buffer = (parts[0] === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n") + "\n";
        } else if (parts[0] === "wc") {
          buffer = parts.includes("-l") ? `${lines.filter(Boolean).length}\n` : `${lines.length} ${input.split(/\s+/).filter(Boolean).length} ${input.length}\n`;
        } else if (parts[0] === "sort") {
          buffer = [...lines].sort().join("\n") + "\n";
        } else if (parts[0] === "uniq") {
          buffer = lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join("\n") + "\n";
        } else {
          buffer = input;
        }
      }
      opts.write = origWrite;
      out(buffer);
    }
    return code;
  }

  return {
    start() {
      out(`Welcome to WebSSH Mock Server (virtual shell – no real commands are executed)\nLast login: ${new Date().toUTCString()} from 10.0.0.2\nTry: tail -n 5 /var/log/app/app.log | df -h | systemctl status app\n\n`);
      prompt();
    },
    input(data: string) {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          out("\n");
          runLine(line);
          line = "";
          if (!disposed) prompt();
        } else if (ch === "\x7f" || ch === "\b") {
          if (line.length) {
            line = line.slice(0, -1);
            out("\b \b");
          }
        } else if (ch === "\x03") {
          out("^C\n");
          line = "";
          prompt();
        } else if (ch === "\x04") {
          if (!line) commands.exit([]);
        } else if (ch === "\x0c") {
          commands.clear([]);
          prompt();
          out(line);
        } else if (ch >= " " || ch === "\t") {
          if (ch === "\t") continue;
          line += ch;
          out(ch);
        }
      }
    },
    runLine,
    dispose() {
      disposed = true;
    },
  };
}
