/**
 * A pragmatic POSIX shell parser producing a small AST: a command list of
 * pipelines of simple commands with redirections, background markers and
 * substitution flags. It is not a full bash grammar, but it is structural
 * (quotes, operators, substitutions) so the policy engine does not depend on
 * naive substring blacklists.
 */
export interface Redirect {
  op: ">" | ">>" | "<" | "2>" | "2>>" | "&>" | ">&";
  target: string;
}

export interface SimpleCommand {
  name: string;
  args: string[];
  assignments: string[]; // leading VAR=value
  redirects: Redirect[];
  raw: string;
}

export interface Pipeline {
  commands: SimpleCommand[];
  background: boolean;
  operatorBefore: ";" | "&&" | "||" | null;
}

export interface ShellAst {
  pipelines: Pipeline[];
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  hasHereDoc: boolean;
  hasEval: boolean;
  unbalancedQuotes: boolean;
}

type Token =
  | { kind: "word"; value: string; quoted: boolean }
  | { kind: "op"; value: string };

const REDIRECT_OPS = new Set([">", ">>", "<", "2>", "2>>", "&>", ">&"]);

export function tokenize(input: string): { tokens: Token[]; unbalanced: boolean; hasCmdSub: boolean; hasProcSub: boolean; hasHereDoc: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  let cur = "";
  let quoted = false;
  let inWord = false;
  let hasCmdSub = false;
  let hasProcSub = false;
  let hasHereDoc = false;
  let unbalanced = false;

  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: cur, quoted });
    cur = "";
    quoted = false;
    inWord = false;
  };

  while (i < input.length) {
    const c = input[i];
    const next = input[i + 1];
    if (c === "\\") {
      cur += next ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) {
        unbalanced = true;
        cur += input.slice(i + 1);
        i = input.length;
      } else {
        cur += input.slice(i + 1, end);
        i = end + 1;
      }
      quoted = true;
      inWord = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < input.length) {
        if (input[j] === "\\" && j + 1 < input.length) {
          buf += input[j + 1];
          j += 2;
          continue;
        }
        if (input[j] === '"') {
          closed = true;
          break;
        }
        if (input[j] === "$" && input[j + 1] === "(") hasCmdSub = true;
        if (input[j] === "`") hasCmdSub = true;
        buf += input[j];
        j++;
      }
      if (!closed) unbalanced = true;
      cur += buf;
      quoted = true;
      inWord = true;
      i = closed ? j + 1 : input.length;
      continue;
    }
    if (c === "`") hasCmdSub = true;
    if (c === "$" && next === "(") hasCmdSub = true;
    if ((c === "<" || c === ">") && next === "(") hasProcSub = true;
    if (c === "<" && next === "<") hasHereDoc = true;

    if (/\s/.test(c)) {
      flush();
      i++;
      continue;
    }
    // operators
    const three = input.slice(i, i + 3);
    const two = input.slice(i, i + 2);
    if (three === "2>>") {
      flush();
      tokens.push({ kind: "op", value: three });
      i += 3;
      continue;
    }
    if (["&&", "||", ">>", "2>", "&>", ">&", ";;"].includes(two)) {
      flush();
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (["|", ";", "&", ">", "<", "(", ")"].includes(c)) {
      flush();
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  flush();
  return { tokens, unbalanced, hasCmdSub, hasProcSub, hasHereDoc };
}

export function parseShell(input: string): ShellAst {
  const { tokens, unbalanced, hasCmdSub, hasProcSub, hasHereDoc } = tokenize(input);
  const pipelines: Pipeline[] = [];
  let current: Pipeline = { commands: [], background: false, operatorBefore: null };
  let cmd: SimpleCommand | null = null;
  let rawParts: string[] = [];
  let hasEval = false;

  const endCommand = () => {
    if (cmd) {
      cmd.raw = rawParts.join(" ");
      current.commands.push(cmd);
    }
    cmd = null;
    rawParts = [];
  };
  const endPipeline = (op: Pipeline["operatorBefore"], background = false) => {
    endCommand();
    if (current.commands.length) {
      current.background = background;
      pipelines.push(current);
    }
    current = { commands: [], background: false, operatorBefore: op };
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "op") {
      if (REDIRECT_OPS.has(t.value)) {
        const target = tokens[i + 1];
        if (!cmd) cmd = { name: "", args: [], assignments: [], redirects: [], raw: "" };
        cmd.redirects.push({ op: t.value as Redirect["op"], target: target?.kind === "word" ? target.value : "" });
        rawParts.push(t.value, target?.kind === "word" ? target.value : "");
        if (target?.kind === "word") i++;
        continue;
      }
      if (t.value === "|") {
        endCommand();
        continue;
      }
      if (t.value === ";" || t.value === "&&" || t.value === "||") {
        endPipeline(t.value);
        continue;
      }
      if (t.value === "&") {
        endPipeline(";", true);
        continue;
      }
      // parentheses / subshell markers are ignored structurally
      continue;
    }
    if (!cmd) {
      cmd = { name: "", args: [], assignments: [], redirects: [], raw: "" };
    }
    if (!cmd.name && !t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value)) {
      cmd.assignments.push(t.value);
    } else if (!cmd.name) {
      cmd.name = t.value;
      if (t.value === "eval") hasEval = true;
    } else {
      cmd.args.push(t.value);
    }
    rawParts.push(t.value);
  }
  endPipeline(null);

  return {
    pipelines,
    hasCommandSubstitution: hasCmdSub,
    hasProcessSubstitution: hasProcSub,
    hasHereDoc,
    hasEval,
    unbalancedQuotes: unbalanced,
  };
}

/** Flattens wrappers like sudo/env/nice/time/nohup/xargs to reach the effective command. */
export function effectiveCommand(cmd: SimpleCommand): { name: string; args: string[]; elevated: boolean; wrappers: string[] } {
  let name = cmd.name;
  let args = [...cmd.args];
  let elevated = false;
  const wrappers: string[] = [];
  const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "ionice", "time", "nohup", "command", "exec", "xargs", "timeout", "stdbuf", "busybox"]);
  let guard = 0;
  while (WRAPPERS.has(name) && guard++ < 6) {
    wrappers.push(name);
    if (name === "sudo" || name === "doas") elevated = true;
    // skip option flags and, for timeout/nice, their numeric operand
    let idx = 0;
    while (idx < args.length && args[idx].startsWith("-")) {
      const flag = args[idx];
      idx++;
      if ((name === "sudo" && ["-u", "-g", "-p", "-C", "-h"].includes(flag)) || (name === "nice" && flag === "-n")) idx++;
    }
    if (name === "timeout" && idx < args.length) idx++;
    if (name === "env") {
      while (idx < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[idx])) idx++;
    }
    if (idx >= args.length) break;
    name = args[idx];
    args = args.slice(idx + 1);
  }
  return { name: name.split("/").pop() ?? name, args, elevated, wrappers };
}
