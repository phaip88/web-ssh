/**
 * Command Policy Engine. Combines the shell AST with per-command risk tables,
 * argument analysis, redirections, elevation, network, encoding and
 * credential-exfiltration heuristics, then applies the execution context
 * (environment, agent mode, caller permissions) to reach a decision.
 */
import { effectiveCommand, parseShell, type ShellAst, type SimpleCommand } from "./shell-parser";

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";
export type Decision = "allow" | "approval_required" | "blocked";
export type AgentMode = "ask" | "suggest" | "approval" | "auto" | "plan";

export interface Finding {
  code: string;
  message: string;
  risk: RiskLevel;
}

export interface PolicyContext {
  environment: string; // development|staging|production
  mode: AgentMode;
  callerCanAutoExecute: boolean; // agent:auto permission
  callerCanUseProduction: boolean;
  autoMaxRisk?: RiskLevel; // admin-defined ceiling for Auto mode (default R1)
}

export interface PolicyResult {
  risk: RiskLevel;
  decision: Decision;
  findings: Finding[];
  ast: ShellAst;
  summary: string;
}

const ORDER: RiskLevel[] = ["R0", "R1", "R2", "R3", "R4"];
export const riskIndex = (r: RiskLevel) => ORDER.indexOf(r);
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (riskIndex(a) >= riskIndex(b) ? a : b);
const bump = (r: RiskLevel, by = 1): RiskLevel => ORDER[Math.min(4, riskIndex(r) + by)];

const R0 = new Set(["echo", "printf", "true", "false", "pwd", "whoami", "id", "hostname", "uname", "date", "uptime", "cal", "which", "type", "help", "clear", "history", "alias", "env", "printenv", "arch", "nproc", "lscpu", "lsblk", "lsusb", "lspci", "free", "df", "du", "w", "who", "last", "groups", "getent", "test", "["]);
const R1 = new Set(["ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "find", "locate", "stat", "file", "wc", "sort", "uniq", "cut", "awk", "sed", "tr", "diff", "cmp", "md5sum", "sha256sum", "sha1sum", "ps", "top", "htop", "pgrep", "lsof", "netstat", "ss", "ip", "ifconfig", "ping", "dig", "nslookup", "host", "traceroute", "journalctl", "dmesg", "systemctl", "service", "docker", "kubectl", "git", "tar", "gzip", "zip", "unzip", "jq", "yq", "xxd", "od", "strings", "base64", "readlink", "realpath", "dirname", "basename", "tree", "column", "tee", "xargs", "sleep", "watch", "nc", "curl", "wget", "ssh", "scp", "sftp", "rsync", "python", "python3", "node", "perl", "ruby", "php", "make", "npm", "pip", "pip3", "cargo", "go", "java", "mysql", "psql", "redis-cli", "mongo", "mongosh", "crontab", "mount", "vmstat", "iostat", "sar", "ulimit", "sysctl", "openssl"]);
const R2 = new Set(["cp", "mv", "mkdir", "rmdir", "touch", "ln", "chmod", "chown", "chgrp", "truncate", "kill", "pkill", "killall", "nohup", "screen", "tmux", "vi", "vim", "nano", "emacs", "patch", "install", "setfacl", "renice"]);
const R3 = new Set(["rm", "apt", "apt-get", "yum", "dnf", "apk", "pacman", "zypper", "snap", "brew", "systemctl", "service", "docker", "kubectl", "helm", "crontab", "useradd", "usermod", "groupadd", "chsh", "hostnamectl", "timedatectl", "ufw", "firewall-cmd", "iptables", "nft", "ip", "ifdown", "ifup", "nmcli", "modprobe", "sysctl", "mount", "umount", "swapoff", "swapon", "reboot", "shutdown", "halt", "poweroff", "init", "telinit", "git", "mysql", "psql", "redis-cli", "mongo", "mongosh", "terraform", "ansible", "ansible-playbook"]);
const R4 = new Set(["mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "mkswap", "dd", "shred", "wipefs", "fdisk", "sfdisk", "parted", "gdisk", "passwd", "chpasswd", "visudo", "userdel", "groupdel", "deluser", "delgroup", "setenforce", "auditctl", "chattr", "crontab", "fsck", "resize2fs", "lvremove", "vgremove", "pvremove", "zpool"]);

const SYSTEM_PATHS = ["/", "/*", "/etc", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/var", "/root", "/home", "/opt", "/srv"];
const AUTH_PATHS = [/^\/etc\/(passwd|shadow|group|gshadow|sudoers|pam\.d|ssh\/sshd_config|security)/, /\.ssh\/authorized_keys$/];
const SECRET_PATHS = [/\.ssh\/id_[a-z0-9]+$/, /\.aws\/credentials/, /\.kube\/config/, /\.docker\/config\.json/, /\.netrc$/, /\.npmrc$/, /\.pgpass$/, /\/etc\/shadow/, /\.env(\.|$)/, /\.git-credentials/];
const SECURITY_SERVICES = ["auditd", "fail2ban", "apparmor", "selinux", "firewalld", "ufw", "sshd", "falco", "crowdsec", "osqueryd", "wazuh"];
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "perl", "ruby", "node"]);
const NETWORK_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet"]);

function isSystemPath(p: string): boolean {
  const norm = p.replace(/\/+$/, "") || "/";
  return SYSTEM_PATHS.some((s) => norm === s || norm === `${s}/*`);
}

function classifySimple(cmd: SimpleCommand, ast: ShellAst, pipelineNames: string[], findings: Finding[]): RiskLevel {
  const { name, args, elevated } = effectiveCommand(cmd);
  const joined = [name, ...args].join(" ");
  let risk: RiskLevel = "R1";

  // ---- base table
  if (R4.has(name)) risk = "R4";
  else if (R3.has(name) && !R1.has(name)) risk = "R3";
  else if (R2.has(name)) risk = "R2";
  else if (R1.has(name)) risk = "R1";
  else if (R0.has(name)) risk = "R0";
  else if (name === "") risk = "R0";
  else {
    risk = "R2";
    findings.push({ code: "UNKNOWN_COMMAND", message: `Unknown command '${name}' treated as R2`, risk: "R2" });
  }

  // ---- dual-use commands: refine by subcommand
  if (name === "systemctl" || name === "service") {
    const sub = name === "systemctl" ? args.find((a) => !a.startsWith("-")) : args[1];
    const readOnly = new Set(["status", "show", "list-units", "list-unit-files", "is-active", "is-enabled", "is-failed", "cat", "list-timers", "list-dependencies"]);
    risk = sub && readOnly.has(sub) ? "R1" : "R3";
    const unit = args.find((a) => SECURITY_SERVICES.some((s) => a.startsWith(s)));
    if (unit && ["stop", "disable", "mask", "kill"].includes(sub ?? "")) {
      risk = "R4";
      findings.push({ code: "SECURITY_SERVICE_DISABLE", message: `Disables security service ${unit}`, risk: "R4" });
    }
  }
  if (name === "docker" || name === "kubectl" || name === "helm") {
    const sub = args.find((a) => !a.startsWith("-"));
    const ro = new Set(["ps", "images", "logs", "inspect", "top", "stats", "version", "info", "get", "describe", "explain", "api-resources", "cluster-info", "history", "list", "status", "diff", "events", "port-forward", "config"]);
    const destructive = new Set(["rm", "rmi", "prune", "delete", "kill", "system", "uninstall", "drain", "cordon", "taint"]);
    if (sub === "system" && args.includes("prune")) risk = "R4";
    else if (sub && destructive.has(sub)) risk = args.includes("--all") || args.includes("-a") ? "R4" : "R3";
    else if (sub && ro.has(sub)) risk = "R1";
    else if (sub === "exec" || sub === "run" || sub === "apply" || sub === "restart" || sub === "scale" || sub === "rollout") risk = "R3";
    else risk = "R2";
  }
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    const ro = new Set(["status", "log", "diff", "show", "branch", "remote", "fetch", "describe", "blame", "rev-parse", "ls-files", "stash"]);
    risk = sub && ro.has(sub) ? "R1" : args.includes("--force") || args.includes("-f") || sub === "reset" || sub === "clean" ? "R3" : "R2";
  }
  if (name === "ip" || name === "sysctl" || name === "mount") {
    const writes = args.some((a) => ["add", "del", "set", "flush", "replace", "change", "-w", "--write"].includes(a)) || args.some((a) => a.includes("="));
    risk = writes ? "R3" : "R1";
  }
  if (name === "crontab") risk = args.includes("-l") ? "R1" : args.includes("-r") ? "R4" : "R3";
  if (["mysql", "psql", "redis-cli", "mongo", "mongosh"].includes(name)) {
    const sqlish = joined.toLowerCase();
    if (/\b(drop\s+(database|table|schema)|truncate|flushall|flushdb|delete\s+from\s+\w+\s*;?$)/.test(sqlish)) {
      risk = "R4";
      findings.push({ code: "DATABASE_DESTRUCTIVE", message: "Destructive database statement", risk: "R4" });
    } else risk = /\b(insert|update|delete|alter|create|grant|revoke)\b/.test(sqlish) ? "R3" : "R1";
  }
  if (name === "rm") {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    const targets = args.filter((a) => !a.startsWith("-"));
    if (targets.some(isSystemPath) || targets.some((t) => t === "~" || t === "$HOME" || t === "*")) {
      risk = "R4";
      findings.push({ code: "SYSTEM_PATH_DELETE", message: "Deletes a system or home directory", risk: "R4" });
    } else if (recursive) risk = "R3";
    else risk = "R2";
    if (targets.some((t) => /backup|\.bak$|snapshot|dump/i.test(t))) {
      risk = maxRisk(risk, "R4");
      findings.push({ code: "BACKUP_DESTROY", message: "Targets backup data", risk: "R4" });
    }
  }
  if (name === "chmod" || name === "chown") {
    const recursive = args.some((a) => /^-[a-zA-Z]*R/.test(a));
    const targets = args.filter((a) => !a.startsWith("-")).slice(1);
    if (targets.some(isSystemPath) && recursive) risk = "R4";
    if (name === "chmod" && args.some((a) => /^[0-7]*777$/.test(a) || /^[ugoa]*\+s/.test(a))) {
      risk = maxRisk(risk, "R3");
      findings.push({ code: "PERMISSIVE_MODE", message: "World-writable or setuid mode", risk: "R3" });
    }
  }
  if (name === "dd" && !args.some((a) => a.startsWith("of=/dev/"))) risk = "R3";
  if (name === "useradd" || name === "usermod") {
    if (args.some((a) => ["-G", "-g", "--groups"].includes(a)) && args.some((a) => /(sudo|wheel|admin|root|docker)/.test(a))) {
      risk = "R4";
      findings.push({ code: "PRIVILEGED_ACCOUNT", message: "Grants administrative group membership", risk: "R4" });
    }
    if (args.includes("-u") && args.includes("0")) risk = "R4";
  }
  if (name === "iptables" || name === "nft" || name === "ufw" || name === "firewall-cmd") {
    const ro = args.some((a) => ["-L", "-S", "list", "status", "--list-all", "show"].includes(a));
    risk = ro ? "R1" : "R4";
    if (!ro) findings.push({ code: "FIREWALL_CHANGE", message: "Modifies firewall configuration", risk: "R4" });
  }
  if (["reboot", "shutdown", "halt", "poweroff", "init", "telinit"].includes(name)) {
    risk = "R4";
    findings.push({ code: "POWER_STATE", message: "Changes machine power state", risk: "R4" });
  }
  if (name === "history" && (args.includes("-c") || args.includes("-w"))) {
    risk = "R4";
    findings.push({ code: "AUDIT_BYPASS", message: "Clears shell history", risk: "R4" });
  }
  if (name === "unset" && args.some((a) => /HIST/.test(a))) {
    risk = "R4";
    findings.push({ code: "AUDIT_BYPASS", message: "Disables shell history", risk: "R4" });
  }
  if (["chattr", "setenforce", "auditctl"].includes(name)) findings.push({ code: "SECURITY_CONTROL", message: `Changes security control via ${name}`, risk: "R4" });

  // ---- argument path analysis
  const pathArgs = args.filter((a) => a.startsWith("/") || a.startsWith("~") || a.includes("/."));
  for (const p of pathArgs) {
    if (AUTH_PATHS.some((re) => re.test(p)) && risk !== "R0" && name !== "cat" && name !== "ls" && name !== "stat") {
      risk = maxRisk(risk, "R4");
      findings.push({ code: "AUTH_CONFIG_WRITE", message: `Touches authentication config ${p}`, risk: "R4" });
    }
    if (SECRET_PATHS.some((re) => re.test(p)) && ["cat", "less", "more", "head", "tail", "base64", "xxd", "cp", "scp", "curl", "wget", "nc", "tar", "grep", "strings", "od"].includes(name)) {
      risk = maxRisk(risk, "R4");
      findings.push({ code: "CREDENTIAL_EXPOSURE", message: `Reads or exfiltrates secret material ${p}`, risk: "R4" });
    }
  }
  if (/\$\{?(AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|OPENAI_API_KEY|.*PASSWORD.*|.*SECRET.*|.*TOKEN.*)\}?/.test(joined) && ["echo", "printf", "curl", "wget", "nc"].includes(name)) {
    risk = maxRisk(risk, "R4");
    findings.push({ code: "CREDENTIAL_EXPOSURE", message: "Prints or transmits a credential environment variable", risk: "R4" });
  }
  if ((name === "env" || name === "printenv" || name === "set") && args.length === 0) {
    risk = maxRisk(risk, "R2");
    findings.push({ code: "ENV_DUMP", message: "Dumps the full environment (may contain secrets)", risk: "R2" });
  }

  // ---- redirections
  for (const r of cmd.redirects) {
    if (r.op === "<") continue;
    risk = maxRisk(risk, "R2");
    if (r.target.startsWith("/etc/") || r.target.startsWith("/boot") || r.target.startsWith("/usr")) {
      risk = maxRisk(risk, "R3");
      findings.push({ code: "SYSTEM_FILE_WRITE", message: `Writes to ${r.target}`, risk: "R3" });
    }
    if (r.target.startsWith("/dev/sd") || r.target.startsWith("/dev/nvme") || r.target.startsWith("/dev/vd") || r.target.startsWith("/dev/mapper")) {
      risk = "R4";
      findings.push({ code: "BLOCK_DEVICE_WRITE", message: `Writes directly to block device ${r.target}`, risk: "R4" });
    }
    if (AUTH_PATHS.some((re) => re.test(r.target))) {
      risk = "R4";
      findings.push({ code: "AUTH_CONFIG_WRITE", message: `Overwrites ${r.target}`, risk: "R4" });
    }
    if (/\/dev\/tcp\//.test(r.target)) {
      risk = maxRisk(risk, "R4");
      findings.push({ code: "REVERSE_SHELL", message: "Bash /dev/tcp network redirection", risk: "R4" });
    }
  }

  // ---- network + pipe-to-shell
  if (NETWORK_TOOLS.has(name)) {
    findings.push({ code: "NETWORK_ACCESS", message: `Network access via ${name}`, risk: "R1" });
    if (name === "curl" && args.some((a) => ["-T", "--upload-file", "-d", "--data", "--data-binary", "-F", "--form"].includes(a))) {
      risk = maxRisk(risk, "R3");
      findings.push({ code: "DATA_UPLOAD", message: "Uploads data to a remote endpoint", risk: "R3" });
    }
    if (name === "nc" && args.includes("-e")) {
      risk = "R4";
      findings.push({ code: "REVERSE_SHELL", message: "netcat -e spawns a shell", risk: "R4" });
    }
  }
  const idx = pipelineNames.indexOf(cmd.name);
  const downstream = pipelineNames.slice(idx + 1);
  if (NETWORK_TOOLS.has(name) && downstream.some((d) => SHELLS.has(d))) {
    risk = "R4";
    findings.push({ code: "PIPE_TO_SHELL", message: "Downloads and executes a remote script", risk: "R4" });
  }
  if (name === "base64" && args.some((a) => a === "-d" || a === "--decode") && downstream.some((d) => SHELLS.has(d))) {
    risk = "R4";
    findings.push({ code: "ENCODED_EXECUTION", message: "Decodes and executes encoded content", risk: "R4" });
  }
  if (SHELLS.has(name) && args.some((a) => a === "-c" || a === "-e")) {
    const inline = args.slice(args.findIndex((a) => a === "-c" || a === "-e") + 1).join(" ");
    if (inline) {
      const nested = evaluateCommandRisk(inline);
      risk = maxRisk(risk, nested.risk);
      findings.push(...nested.findings.map((f) => ({ ...f, code: `NESTED_${f.code}` })));
    }
  }
  if (/[A-Za-z0-9+/]{80,}={0,2}/.test(joined) && (name === "echo" || name === "printf")) {
    risk = maxRisk(risk, "R3");
    findings.push({ code: "ENCODED_PAYLOAD", message: "Long encoded payload in command", risk: "R3" });
  }
  if (/\$\{?IFS\}?|\\x[0-9a-f]{2}|\$'\\/i.test(cmd.raw) || /\w\*\w|\w\?\w/.test(cmd.name)) {
    risk = maxRisk(risk, "R3");
    findings.push({ code: "OBFUSCATION", message: "Possible command obfuscation", risk: "R3" });
  }

  // ---- elevation: privileged execution moves every non-trivial operation up one level
  if (elevated) {
    if (risk !== "R0") risk = bump(risk);
    findings.push({ code: "ELEVATED", message: "Runs with elevated privileges", risk });
    if (args.includes("-i") || args.includes("-s") || name === "su") {
      risk = maxRisk(risk, "R3");
    }
  }
  if (name === "su") risk = maxRisk(risk, "R3");
  return risk;
}

export function evaluateCommandRisk(command: string): { risk: RiskLevel; findings: Finding[]; ast: ShellAst } {
  const ast = parseShell(command);
  const findings: Finding[] = [];
  let risk: RiskLevel = "R0";
  for (const p of ast.pipelines) {
    const names = p.commands.map((c) => c.name);
    for (const c of p.commands) risk = maxRisk(risk, classifySimple(c, ast, names, findings));
    if (p.background) {
      risk = maxRisk(risk, "R2");
      findings.push({ code: "BACKGROUND_JOB", message: "Starts a background job", risk: "R2" });
    }
  }
  if (ast.hasCommandSubstitution) {
    risk = maxRisk(risk, "R2");
    findings.push({ code: "COMMAND_SUBSTITUTION", message: "Contains command substitution", risk: "R2" });
  }
  if (ast.hasProcessSubstitution) {
    risk = maxRisk(risk, "R2");
    findings.push({ code: "PROCESS_SUBSTITUTION", message: "Contains process substitution", risk: "R2" });
  }
  if (ast.hasEval) {
    risk = maxRisk(risk, "R3");
    findings.push({ code: "EVAL", message: "Uses eval", risk: "R3" });
  }
  if (ast.unbalancedQuotes) {
    risk = maxRisk(risk, "R3");
    findings.push({ code: "UNBALANCED_QUOTES", message: "Unbalanced quotes – possible injection", risk: "R3" });
  }
  if (ast.pipelines.length > 6) {
    risk = maxRisk(risk, "R2");
    findings.push({ code: "COMPLEX_COMMAND", message: "Highly compound command", risk: "R2" });
  }
  return { risk, findings, ast };
}

const HARD_BLOCK_CODES = new Set([
  "SYSTEM_PATH_DELETE",
  "BLOCK_DEVICE_WRITE",
  "PIPE_TO_SHELL",
  "ENCODED_EXECUTION",
  "REVERSE_SHELL",
  "AUDIT_BYPASS",
  "CREDENTIAL_EXPOSURE",
  "SECURITY_SERVICE_DISABLE",
  "BACKUP_DESTROY",
]);

/**
 * Applies the execution context to a risk assessment.
 * - Hard-block categories are never executable by the agent (humans may still type them in the terminal, which is audited).
 * - Auto mode may only run up to `autoMaxRisk` (default R1) and never in production without env:production.
 * - Everything else requires approval.
 */
export function decideCommand(command: string, ctx: PolicyContext): PolicyResult {
  const { risk: baseRisk, findings, ast } = evaluateCommandRisk(command);
  let risk = baseRisk;
  if (ctx.environment === "production" && riskIndex(risk) >= 2) {
    risk = bump(risk);
    findings.push({ code: "PRODUCTION_ENV", message: "Target is a production host", risk });
  }
  const summary = summarize(ast);
  if (ctx.mode === "ask") return { risk, decision: "blocked", findings: [...findings, { code: "MODE_ASK", message: "Ask mode never executes commands", risk }], ast, summary };
  if (findings.some((f) => HARD_BLOCK_CODES.has(f.code) || f.code.startsWith("NESTED_") && HARD_BLOCK_CODES.has(f.code.slice(7)))) {
    return { risk: "R4", decision: "blocked", findings, ast, summary };
  }
  if (ctx.environment === "production" && !ctx.callerCanUseProduction) {
    return { risk, decision: "blocked", findings: [...findings, { code: "NO_PRODUCTION_GRANT", message: "Caller lacks env:production", risk }], ast, summary };
  }
  if (risk === "R4") return { risk, decision: "approval_required", findings, ast, summary };
  if (ctx.mode === "auto" && ctx.callerCanAutoExecute) {
    const ceiling = ctx.autoMaxRisk ?? "R1";
    if (riskIndex(risk) <= riskIndex(ceiling) && ctx.environment !== "production") return { risk, decision: "allow", findings, ast, summary };
  }
  if (riskIndex(risk) <= 1 && ctx.mode !== "plan" && ctx.mode !== "suggest") {
    // R0/R1 read-only commands in Approval mode still require a click; only Auto mode skips it.
    return { risk, decision: "approval_required", findings, ast, summary };
  }
  return { risk, decision: "approval_required", findings, ast, summary };
}

function summarize(ast: ShellAst): string {
  return ast.pipelines
    .map((p) => p.commands.map((c) => effectiveCommand(c).name || "?").join(" | ") + (p.background ? " &" : ""))
    .join(" ; ");
}
