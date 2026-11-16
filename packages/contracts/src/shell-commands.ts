/**
 * A shell script read as the commands it runs, for the subjects a rule
 * matcher is tested against (`CallAssessment.subjects`).
 */

/** A subject no realistic allow glob can cover: what a script the splitter cannot read becomes. */
export const UNPARSED_SUBJECT_PREFIX = "\u0000unparsed ";

/** How deep substitutions, subshells, groups and quotes inside `${…}` nest before the grammar gives up (and the splitter reads no further). */
const MAX_PARSE_DEPTH = 32;

/**
 * What the splitter reads but no rule should be trusted to: shells disagree
 * on it (`dash` has no `$'…'`), or a line can hide a command behind it. Each
 * makes a `sandbox.run` card show every time, with this as its reason.
 */
export const SHELL_QUOTING_REASON = "uses ANSI-C or locale quoting";
export const SHELL_CONTINUATION_REASON = "continues a line with a backslash";
export const SHELL_BRACED_EXPANSION_REASON = "uses braced parameter expansion";
export const SHELL_PROCESS_SUBSTITUTION_REASON = "uses process substitution";

/** A script read as `/bin/sh` reads it: its simple commands, and what in it no rule should cover. */
export interface ShellScriptReading {
  readonly commands: readonly string[];
  readonly opaque: readonly string[];
}

/** The quoting a character sits in: `'…'`, `$'…'`, `"…"` or a `${…}` expansion. */
type ShellContext = "'" | "$'" | '"' | "${";

/** A `${…}` body that is a plain name or position (`${HOME}`, `${1}`): it expands, nothing more. */
const PLAIN_PARAMETER = /^(?:[A-Za-z_]\w*|\d+)$/;
/** What in a `${…}` body shells read differently: quotes, escapes and operators. */
const AMBIGUOUS_PARAMETER = /['"`;&|<>()\n]/;

/**
 * What may stand before a `{` that opens a group: nothing, or the reserved
 * words `!` and `time [-p]` (bash, the macOS `/bin/sh`, groups `time { …; }`).
 */
const COMMAND_START = /^(?:(?:!|time(?:\s+-p)?)(?:\s+(?:!|time(?:\s+-p)?))*)?$/;

/** `script` with every backslash-newline at `at` removed, as `/bin/sh` removes one before it reads a word. */
function joinLines(script: string, at: number): string {
  let end = at;
  while (script[end] === "\\" && script[end + 1] === "\n") end += 2;
  return end === at ? script : script.slice(0, at) + script.slice(end);
}

/**
 * The index of the character that closes a substitution whose body starts at
 * `start`, skipping quoted text, `${…}` and escapes while counting nesting;
 * `-1` when the body never closes. A backquoted body ends at the next
 * unescaped backquote, quoted or not, as `/bin/sh` reads it.
 */
function substitutionEnd(script: string, start: number, close: ")" | "`", depth = 0): number {
  if (close === "`") {
    for (let index = start; index < script.length; index += 1) {
      if (script[index] === "\\") index += 1;
      else if (script[index] === "`") return index;
    }
    return -1;
  }
  if (depth > MAX_PARSE_DEPTH) return -1;
  let open = 1;
  const stack: ShellContext[] = [];
  for (let index = start; index < script.length; index += 1) {
    const char = script[index]!;
    const top = stack.at(-1);
    if (top === "'") {
      if (char === "'") stack.pop();
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (top === "$'") {
      if (char === "'") stack.pop();
      continue;
    }
    if (char === "`" || (char === "$" && script[index + 1] === "(")) {
      const end = char === "`" ? substitutionEnd(script, index + 1, "`") : substitutionEnd(script, index + 2, ")", depth + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "$" && (script[index + 1] === "{" || (script[index + 1] === "'" && top !== '"'))) {
      stack.push(script[index + 1] === "{" ? "${" : "$'");
      index += 1;
      continue;
    }
    if (top === '"') {
      if (char === '"') stack.pop();
      continue;
    }
    if (char === "'" || char === '"') {
      stack.push(char);
      continue;
    }
    if (top === "${") {
      if (char === "}") stack.pop();
      continue;
    }
    if (char === "(") open += 1;
    if (char === ")") {
      open -= 1;
      if (open === 0) return index;
    }
  }
  return -1;
}

/**
 * Read a shell script into its simple commands, so a rule must cover each one:
 * `ls && rm -rf /` is two subjects, and an allow rule for `ls *` covers only
 * the first. Command substitutions — unquoted or inside double quotes — and
 * subshells are lifted out as their own commands. Quoting is read as `/bin/sh`
 * reads it: `'…'`, `$'…'` (where `\'` does not close), `"…"`, and `${…}`, whose
 * `#` or `;` is not a comment or a separator; a backslash-newline outside
 * single quotes joins its lines first. A script this cannot read (an
 * unterminated quote or substitution, a `${…}` holding quotes or operators, or
 * substitutions nested deeper than `MAX_PARSE_DEPTH`) adds a subject no allow
 * glob covers, so ambiguity can only fail to match an allow rule — never widen one.
 * Inside a `[[ … ]]` test, `&&`, `||`, `<`, `>` and parentheses are its own
 * operands, so the test is one subject; `<(…)` and `>(…)` there still run what
 * they hold. A `[[` that never closes is read as if it were a plain word, so
 * what follows it is still split into the commands it may run.
 */
export function readShellScript(original: string): ShellScriptReading {
  return readShellScriptAt(original, 0);
}

/** `readShellScript` for a substitution's body `depth` levels down; `conditionals: false` reads `[[` as a plain word. */
function readShellScriptAt(original: string, depth: number, conditionals = true): ShellScriptReading {
  const commands: string[] = [];
  const nested: string[] = [];
  const opaque = new Set<string>();
  const stack: ShellContext[] = [];
  /** Where each open `${…}`'s body starts in `current`. */
  const braces: number[] = [];
  let script = original;
  let current = "";
  let unreadable = false;
  /** Whether `current` is a `[[ … ]]` test that has not yet reached its `]]`. */
  let inConditional = false;
  const flush = () => {
    const trimmed = current.trim().replace(/\s+/g, " ");
    if (trimmed !== "") commands.push(trimmed);
    current = "";
    inConditional = false;
  };
  /** The character at `at`, past any backslash-newlines there. */
  const peek = (at: number): string | undefined => {
    const joined = joinLines(script, at);
    if (joined !== script) {
      script = joined;
      opaque.add(SHELL_CONTINUATION_REASON);
    }
    return script[at];
  };
  for (let index = 0; index < script.length; index += 1) {
    const top = stack.at(-1);
    if (top === "'") {
      if (script[index] === "'") stack.pop();
      current += script[index];
      continue;
    }
    if (top === "$'") {
      // `\'` and `\\` are escapes here; a backslash-newline is kept, not joined.
      if (script[index] === "\\") {
        current += script.slice(index, index + 2);
        index += 1;
        continue;
      }
      if (script[index] === "'") stack.pop();
      current += script[index];
      continue;
    }
    const char = peek(index);
    if (char === undefined) break;
    if (char === "\\") {
      const next = script[index + 1];
      if (next !== undefined) current += char + next;
      index += 1;
      continue;
    }
    if (char === "`" || (char === "$" && peek(index + 1) === "(")) {
      // Lifted whether or not it sits in double quotes: the shell runs it either way.
      const close = char === "`" ? "`" : ")";
      const bodyStart = char === "`" ? index + 1 : index + 2;
      const end = depth >= MAX_PARSE_DEPTH ? -1 : substitutionEnd(script, bodyStart, close);
      if (end < 0) {
        unreadable = true;
        break;
      }
      const inner = readShellScriptAt(script.slice(bodyStart, end), depth + 1);
      nested.push(...inner.commands);
      for (const reason of inner.opaque) opaque.add(reason);
      current += "$SUB";
      index = end;
      continue;
    }
    if (char === "$" && script[index + 1] === "{") {
      stack.push("${");
      current += "${";
      braces.push(current.length);
      index += 1;
      continue;
    }
    if (char === "$" && (script[index + 1] === "'" || script[index + 1] === '"') && top !== '"') {
      opaque.add(SHELL_QUOTING_REASON);
      stack.push(script[index + 1] === "'" ? "$'" : '"');
      current += char + script[index + 1];
      index += 1;
      continue;
    }
    if (top === '"') {
      if (char === '"') stack.pop();
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      stack.push(char);
      current += char;
      continue;
    }
    if (top === "${") {
      if (char === "}") {
        stack.pop();
        const body = current.slice(braces.pop());
        if (!PLAIN_PARAMETER.test(body)) opaque.add(SHELL_BRACED_EXPANSION_REASON);
        if (AMBIGUOUS_PARAMETER.test(body)) unreadable = true;
      }
      current += char;
      continue;
    }
    // A comment runs to its line's end, quotes and backslashes and all, as `/bin/sh` reads it.
    // A bare `{` or `}` is a word character there, so `}#` is one word, not a comment.
    if (char === "#" && (current === "" || /\s$/.test(current)) && (index === 0 || !/[{}]/.test(script[index - 1]!))) {
      const end = script.indexOf("\n", index);
      if (end < 0) break;
      index = end - 1;
      continue;
    }
    // `[[` opens a test where a command starts (`[[ … ]]`, `! [[ … ]]`), as the grammar reads it.
    if (
      conditionals &&
      char === "[" &&
      peek(index + 1) === "[" &&
      /^!?$/.test(current.trim()) &&
      (current === "" || /\s$/.test(current)) &&
      /^[\s;&|()<>]?$/.test(peek(index + 2) ?? "")
    ) {
      inConditional = true;
      current += "[[";
      index += 1;
      continue;
    }
    if (inConditional) {
      if ((char === "<" || char === ">") && peek(index + 1) === "(") {
        // A process substitution in a test still runs: it is lifted as `$(…)` is.
        opaque.add(SHELL_PROCESS_SUBSTITUTION_REASON);
        const end = depth >= MAX_PARSE_DEPTH ? -1 : substitutionEnd(script, index + 2, ")");
        if (end < 0) {
          unreadable = true;
          break;
        }
        const inner = readShellScriptAt(script.slice(index + 2, end), depth + 1);
        nested.push(...inner.commands);
        for (const reason of inner.opaque) opaque.add(reason);
        current += `${char} $SUB`;
        index = end;
        continue;
      }
      if (char === "]" && peek(index + 1) === "]" && /[\s&|()<>]$/.test(current) && /^[\s;&|()<>]?$/.test(peek(index + 2) ?? "")) {
        inConditional = false;
        current += "]]";
        index += 1;
        continue;
      }
      const next = peek(index + 1);
      if ((char === "&" || char === "|") && next === char) {
        current += char + next;
        index += 1;
        continue;
      }
      if (char === "(" || char === ")" || char === "<" || char === ">") {
        current += char;
        continue;
      }
    }
    if ((char === "<" || char === ">") && peek(index + 1) === "(") opaque.add(SHELL_PROCESS_SUBSTITUTION_REASON);
    if (char === "(" || char === ")") {
      flush();
      continue;
    }
    // `{` and `}` group commands only as whole words where a command starts (`{ ls; }`, `! {`, `time -p {`);
    // elsewhere they are word characters, as in the brace expansion `mkdir -p src/{a,b}` or find's `{}`.
    if ((char === "{" || char === "}") && COMMAND_START.test(current.trim()) && /^[\s;&|()<>]?$/.test(peek(index + 1) ?? "")) {
      flush();
      continue;
    }
    const next = peek(index + 1);
    // A redirection (`2>&1`, `&>file`, `>|file`) is part of its command, not a separator.
    const redirect = (char === "&" || char === "|") && (/[<>]$/.test(current) || (char === "&" && next === ">"));
    if (!redirect && (char === ";" || char === "\n" || char === "&" || char === "|")) {
      flush();
      if ((char === "&" || char === "|") && next === char) index += 1;
      continue;
    }
    current += char;
  }
  if (inConditional) return readShellScriptAt(original, depth, false);
  if (stack.length > 0) unreadable = true;
  flush();
  return {
    commands: unreadable ? [...commands, ...nested, `${UNPARSED_SUBJECT_PREFIX}${original}`] : [...commands, ...nested],
    opaque: [...opaque],
  };
}

/** A shell script's simple commands (`readShellScript`), each a subject a rule must cover. */
export function splitShellCommands(script: string): readonly string[] {
  return readShellScript(script).commands;
}

/**
 * Why a line is asked about every time when the grammar below and the
 * splitter above disagree: one of them finds a command the other does not.
 */
export const SHELL_PARSE_DISAGREEMENT_REASON = "reads as different commands on a second parse";

/** A word as the grammar read it. */
export interface ShellWord {
  /** As written, backslash-newlines removed. */
  readonly raw: string;
  /** Quotes and escapes removed; an expansion kept as spelled, a command substitution as `$SUB`. */
  readonly text: string;
}

/** A redirection: its operator with any descriptor number (`2>`, `>>`, `&>`, `<>`) and its target word. */
export interface ShellRedirect {
  readonly operator: string;
  readonly target: ShellWord;
}

/** One simple command: its leading `NAME=value` assignments and its words (redirections are listed apart). */
export interface ShellSimpleCommand {
  readonly assignments: readonly ShellWord[];
  readonly words: readonly ShellWord[];
}

/**
 * A script read by the shell grammar (`parseShellScript`): every simple
 * command it runs — those in pipelines, `&&`/`||` lists, subshells, `{ …; }`
 * groups and command substitutions, in no promised order — and every
 * redirection, a group's included.
 */
export type ShellParse =
  | { readonly ok: true; readonly commands: readonly ShellSimpleCommand[]; readonly redirects: readonly ShellRedirect[] }
  | { readonly ok: false; readonly error: string };

class ShellSyntaxError extends Error {}

/** Operators, longest first, so `<<<` is not read as `<<` and `&&` is not two `&`s. */
const OPERATORS = [
  "<<<",
  "<<-",
  "&>>",
  "&&",
  "||",
  ";;",
  ";&",
  "|&",
  ">>",
  ">|",
  "<&",
  ">&",
  "<>",
  "<<",
  "&>",
  ";",
  "&",
  "|",
  "(",
  ")",
  "<",
  ">",
];
const REDIRECTIONS = new Set(["<<<", "&>>", ">>", ">|", "<&", ">&", "<>", "&>", "<", ">"]);
/** What ends an unquoted word. */
const WORD_END = new Set([" ", "\t", "\n", "<", ">", "&", "|", ";", "(", ")"]);
/** Keywords this grammar does not read; the splitter's callers treat each line holding one as opaque already. */
const UNSUPPORTED_KEYWORDS = [
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "until",
  "for",
  "function",
  "select",
  "coproc",
];
const ASSIGNMENT_WORD = /^[A-Za-z_]\w*=/;

/**
 * Read a script by the POSIX shell grammar: a tokenizer for words (quotes,
 * `$'…'`, `${…}`, `$(…)`, backquotes, backslash-newlines) and operators, and a
 * recursive-descent parser for lists, pipelines, subshells, `{ …; }` groups,
 * `[[ … ]]` and simple commands. It is written apart from `readShellScript`'s
 * character scanner, as a second reading to check that one against
 * (`shellParsesAgree`). Here-documents, control flow and function
 * definitions are not read: the result is `ok: false`, as it is for a syntax
 * error, and callers fall back to what fails closed.
 */
export function parseShellScript(script: string): ShellParse {
  const commands: ShellSimpleCommand[] = [];
  const redirects: ShellRedirect[] = [];
  try {
    parseInto(script, commands, redirects, 0);
    return { ok: true, commands, redirects };
  } catch (error) {
    if (error instanceof ShellSyntaxError) return { ok: false, error: error.message };
    throw error;
  }
}

function parseInto(source: string, commands: ShellSimpleCommand[], redirects: ShellRedirect[], depth: number): void {
  if (depth > MAX_PARSE_DEPTH) throw new ShellSyntaxError("nests too deeply");
  let script = source;
  let index = 0;
  const fail = (why: string): never => {
    throw new ShellSyntaxError(why);
  };
  /** `read` one level deeper, so a line of ten thousand `(` fails as a syntax error, never as a stack overflow. */
  const deeper = <T>(read: () => T): T => {
    if (depth >= MAX_PARSE_DEPTH) fail("nests too deeply");
    depth += 1;
    try {
      return read();
    } finally {
      depth -= 1;
    }
  };
  /** The character at `at` once any backslash-newlines there are removed; never called inside single quotes or `$'…'`. */
  const at = (position: number): string | undefined => {
    script = joinLines(script, position);
    return script[position];
  };
  const startsWith = (text: string, position = index): boolean => {
    for (let offset = 0; offset < text.length; offset += 1) if (at(position + offset) !== text[offset]) return false;
    return true;
  };
  /** Blanks (and newlines, when they do not end anything here) and a comment, at a token boundary. */
  const skipBlanks = (newlines: boolean): void => {
    for (;;) {
      const char = at(index);
      if (char === " " || char === "\t" || (newlines && char === "\n")) index += 1;
      else if (char === "#") while (index < script.length && script[index] !== "\n") index += 1;
      else return;
    }
  };
  const operator = (): string | undefined => {
    const char = at(index);
    if (char === undefined || !WORD_END.has(char) || char === " " || char === "\t") return undefined;
    return char === "\n" ? "\n" : OPERATORS.find((each) => startsWith(each));
  };
  /** Whether a reserved word stands here whole: unquoted, and ended by a blank, an operator or the end. */
  const reserved = (word: string): boolean => {
    if (!startsWith(word)) return false;
    const after = at(index + word.length);
    return after === undefined || WORD_END.has(after);
  };

  const singleQuoted = (): string => {
    const end = script.indexOf("'", index);
    if (end < 0) fail("an unterminated single quote");
    const text = script.slice(index, end);
    index = end + 1;
    return text;
  };
  const ansiQuoted = (): string => {
    let text = "";
    for (;;) {
      const char = script[index];
      if (char === undefined) fail("an unterminated $'…' quote");
      index += 1;
      if (char === "'") return text;
      text += char === "\\" ? char + (script[index++] ?? "") : char;
    }
  };
  const doubleQuoted = (): string =>
    deeper(() => {
      let text = "";
      for (;;) {
        const char = at(index);
        if (char === undefined) fail("an unterminated double quote");
        index += 1;
        if (char === '"') return text;
        if (char === "\\") {
          const next = script[index];
          if (next !== undefined && '$`"\\'.includes(next)) {
            text += next;
            index += 1;
          } else text += char;
        } else if (char === "`") text += backquoted();
        else if (char === "$") text += dollar(true);
        else text += char;
      }
    });
  /** A backquoted body, which ends at the next unescaped backquote and is read again as a script of its own. */
  const backquoted = (): string => {
    let body = "";
    for (;;) {
      const char = script[index];
      if (char === undefined) fail("an unterminated backquote");
      index += 1;
      if (char === "`") break;
      if (char === "\\" && script[index] !== undefined) {
        const next = script[index]!;
        body += "$`\\".includes(next) ? next : char + next;
        index += 1;
      } else body += char;
    }
    parseInto(body, commands, redirects, depth + 1);
    return "$SUB";
  };
  const braced = (): string =>
    deeper(() => {
      let text = "";
      for (;;) {
        const char = at(index);
        if (char === undefined) fail("an unterminated ${…} expansion");
        index += 1;
        if (char === "}") return text;
        if (char === "\\") text += char + (script[index++] ?? "");
        else if (char === "'") text += singleQuoted();
        else if (char === '"') text += doubleQuoted();
        else if (char === "`") text += backquoted();
        else if (char === "$") text += dollar(false);
        else text += char;
      }
    });
  const arithmetic = (): string => {
    let text = "";
    let open = 0;
    for (;;) {
      const char = at(index);
      if (char === undefined) fail("an unterminated $((…)) expansion");
      index += 1;
      if (char === ")" && open === 0) {
        if (at(index) !== ")") fail("an unterminated $((…)) expansion");
        index += 1;
        return text;
      }
      if (char === "(") open += 1;
      if (char === ")") open -= 1;
      text += char === "$" ? dollar(false) : char === "`" ? backquoted() : char;
    }
  };
  /** What follows a `$` already read: a quote form, `${…}`, `$((…))`, a substitution, or the `$` alone. */
  const dollar = (inDoubleQuotes: boolean): string => {
    const next = at(index);
    if (!inDoubleQuotes && next === "'") {
      index += 1;
      return ansiQuoted();
    }
    if (!inDoubleQuotes && next === '"') {
      index += 1;
      return doubleQuoted();
    }
    if (next === "{") {
      index += 1;
      return `\${${braced()}}`;
    }
    if (next !== "(") return "$";
    if (at(index + 1) === "(") {
      index += 2;
      return `$((${arithmetic()}))`;
    }
    index += 1;
    deeper(() => list(")"));
    index += 1;
    return "$SUB";
  };
  const word = (): ShellWord | undefined => {
    const start = index;
    let text = "";
    for (;;) {
      const char = at(index);
      if (char === undefined || WORD_END.has(char)) break;
      index += 1;
      if (char === "\\") text += script[index] === undefined ? char : script[index++];
      else if (char === "'") text += singleQuoted();
      else if (char === '"') text += doubleQuoted();
      else if (char === "`") text += backquoted();
      else if (char === "$") text += dollar(false);
      else text += char;
    }
    return index === start ? undefined : { raw: script.slice(start, index), text };
  };

  /** A redirection here, with any descriptor number before it, read into `redirects`; `false` (nothing read) when there is none. */
  const redirect = (): boolean => {
    const start = index;
    let descriptor = "";
    while (/^\d$/.test(at(index) ?? "")) descriptor += script[index++];
    const op = operator();
    if (op === "<<" || op === "<<-") fail("a here-document");
    if (op === undefined || !REDIRECTIONS.has(op)) {
      index = start;
      return false;
    }
    index += op.length;
    skipBlanks(false);
    const target = word();
    if (target === undefined) fail(`a "${op}" with no target`);
    redirects.push({ operator: descriptor + op, target: target! });
    return true;
  };
  const trailingRedirects = (): void => {
    for (skipBlanks(false); redirect(); skipBlanks(false));
  };
  const simple = (): void => {
    const assignments: ShellWord[] = [];
    const words: ShellWord[] = [];
    let empty = true;
    for (;;) {
      skipBlanks(false);
      if (redirect()) {
        empty = false;
        continue;
      }
      const op = operator();
      if (op === "(") fail(words.length === 1 ? "a function definition" : 'an unexpected "("');
      if (op !== undefined || at(index) === undefined) break;
      const next = word()!;
      empty = false;
      if (words.length === 0 && ASSIGNMENT_WORD.test(next.raw)) assignments.push(next);
      else words.push(next);
    }
    if (empty) fail(`a missing command${operator() === undefined ? "" : ` before "${operator()}"`}`);
    commands.push({ assignments, words });
  };
  /** `[[ … ]]`, one command whose `&&`, `||`, `<`, `>` and parentheses are its own operands. */
  const conditional = (): void => {
    const words: ShellWord[] = [{ raw: "[[", text: "[[" }];
    index += 2;
    for (;;) {
      skipBlanks(true);
      if (at(index) === undefined) fail("an unterminated [[ … ]]");
      if (reserved("]]")) {
        index += 2;
        words.push({ raw: "]]", text: "]]" });
        commands.push({ assignments: [], words });
        return;
      }
      const op = operator();
      if ((op === "<" || op === ">") && at(index + 1) === "(") {
        // A process substitution runs what it holds, test or not.
        words.push({ raw: op, text: op });
        const start = index + 1;
        index += 2;
        deeper(() => list(")"));
        index += 1;
        words.push({ raw: script.slice(start, index), text: "$SUB" });
      } else if (op !== undefined) {
        words.push({ raw: op, text: op });
        index += op.length;
      } else words.push(word()!);
    }
  };
  const command = (): void => {
    skipBlanks(false);
    if (operator() === "(") {
      index += 1;
      deeper(() => list(")"));
      index += 1;
      trailingRedirects();
      return;
    }
    if (reserved("{")) {
      index += 1;
      deeper(() => list("}"));
      index += 1;
      trailingRedirects();
      return;
    }
    if (reserved("[[")) {
      conditional();
      trailingRedirects();
      return;
    }
    const keyword = UNSUPPORTED_KEYWORDS.find(reserved);
    if (keyword !== undefined) fail(`the keyword "${keyword}"`);
    simple();
  };
  const pipeline = (): void => {
    skipBlanks(false);
    if (reserved("!")) index += 1;
    // `time [-p] { …; }` times a group (bash, the macOS `/bin/sh`); before anything else `time` is a program's name.
    const start = index;
    skipBlanks(false);
    if (reserved("time")) {
      index += 4;
      skipBlanks(false);
      if (reserved("-p")) index += 2;
      skipBlanks(false);
      if (reserved("!")) index += 1;
      skipBlanks(false);
      if (!reserved("{")) index = start;
    }
    command();
    for (;;) {
      skipBlanks(false);
      const op = operator();
      if (op !== "|" && op !== "|&") return;
      index += op.length;
      skipBlanks(true);
      command();
    }
  };
  const andOr = (): void => {
    pipeline();
    for (;;) {
      skipBlanks(false);
      const op = operator();
      if (op !== "&&" && op !== "||") return;
      index += 2;
      skipBlanks(true);
      pipeline();
    }
  };
  /** A list up to `end` (left for the caller to step over) or, with none, the script's end. */
  const list = (end?: ")" | "}"): void => {
    const atEnd = () => (end === ")" ? operator() === ")" : end === "}" ? reserved("}") : false);
    for (;;) {
      skipBlanks(true);
      if (at(index) === undefined) {
        if (end !== undefined) fail(end === ")" ? "an unterminated subshell or substitution" : "an unterminated { … } group");
        return;
      }
      if (atEnd()) return;
      andOr();
      skipBlanks(false);
      const op = operator();
      if (op === ";" || op === "&" || op === "\n") index += 1;
      else if (at(index) !== undefined && !atEnd()) fail(`an unexpected "${op ?? at(index)}"`);
    }
  };
  list();
}

/**
 * Whether the splitter's `commands` (`readShellScript`) hold every command
 * the grammar finds in `script` (`parseShellScript`): each command the
 * grammar reads must be matched, assignment by assignment and word by word
 * (quotes removed; runs of whitespace read as one space, as the splitter
 * prints a subject), by one the splitter read, each subject read as the one
 * simple command it should be. A splitter that reads more than the grammar
 * still agrees — each extra subject only needs a rule of its own — but one
 * that reads fewer, or reads a command with other words (the grammar's
 * `[[ a && b ]]` is neither of the splitter's halves), has lost a command,
 * and so does a script the grammar cannot read at all.
 */
export function shellParsesAgree(script: string, commands: readonly string[]): boolean {
  const parsed = parseShellScript(script);
  if (!parsed.ok) return false;
  const signature = (command: ShellSimpleCommand) =>
    JSON.stringify([
      command.assignments.length,
      ...[...command.assignments, ...command.words].map((word) => word.text.replace(/\s+/g, " ")),
    ]);
  const read = new Map<string, number>();
  for (const subject of commands) {
    // A subject counts only as the one simple command it should be: one that reads as more is itself a lost command.
    const again = parseShellScript(subject);
    if (!again.ok || again.commands.length !== 1) continue;
    const key = signature(again.commands[0]!);
    read.set(key, (read.get(key) ?? 0) + 1);
  }
  for (const each of parsed.commands) {
    if (each.words.length === 0) continue;
    const left = read.get(signature(each)) ?? 0;
    if (left === 0) return false;
    read.set(signature(each), left - 1);
  }
  return true;
}
