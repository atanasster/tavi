/**
 * A whole command line given as `sandbox.run`'s `command`. Models often pass `python3 -c "…"` as the program's name, which
 * failed with "command not found" (exit 127). Such a line is split into its
 * program and arguments — by this one function, which the call's approval
 * assessment reads too, so what is asked about is exactly what runs.
 *
 * Only a line a shell would run as one plain program is split: anything a
 * shell would expand or interpret — a pipe, a redirect, a sequence, a
 * substitution, a variable, a glob, `~`, braces, a comment, a leading
 * `NAME=value` — runs as `/bin/sh -c '<line>'` instead (`SHELL`), plain `sh`
 * that reads no startup files.
 */

/** The shell a command line that needs one runs in: by absolute path, so no folder on `PATH` can stand in for it. */
const SHELL = "/bin/sh";

/** Outside quotes, what only a shell reads. */
const SHELL_SYNTAX = /[|&;<>()$`\n*?[\]{}~#]/;
/** Inside double quotes, what a shell still expands. */
const DOUBLE_QUOTED_EXPANSION = /[$`]/;
/** Inside double quotes, the characters a backslash escapes (POSIX); before any other it stays a backslash. */
const DOUBLE_QUOTED_ESCAPES = new Set(['"', "\\", "$", "`"]);

/** `command` as a program and its arguments, or `undefined` when it is one word or needs a shell. */
export function splitCommandLine(command: string): readonly string[] | undefined {
  if (!/\s/.test(command.trim())) return undefined;
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      // A backslash-newline joins lines in a shell, quoted or not: the line is the shell's to read.
      else if (char === "\\" && command[index + 1] === "\n") return undefined;
      else if (char === "\\" && index + 1 < command.length && DOUBLE_QUOTED_ESCAPES.has(command[index + 1] as string)) {
        current += command[index + 1];
        index += 1;
      } else if (DOUBLE_QUOTED_EXPANSION.test(char)) return undefined;
      else current += char;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= command.length || command[index + 1] === "\n") return undefined;
      current += command[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (SHELL_SYNTAX.test(char)) return undefined;
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      // `NAME=value program` sets a variable for the program: a shell's reading, not a program's name.
      if (char === "=" && words.length === 0) return undefined;
      current += char;
      started = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(current);
  return words.length > 1 ? words : undefined;
}

/**
 * A program name holding spaces beside `args` would run as one long program
 * name, never as the line it reads as: refused, with how to pass it.
 */
export function spacedProgram(command: string, args: readonly string[] | undefined): string | undefined {
  if (args === undefined || args.length === 0 || !/\s/.test(command.trim())) return undefined;
  return "with args, command is the program alone: put the whole line in command (and no args), or its arguments in args";
}

/**
 * The program and arguments a `sandbox.run` call runs: `command` and `args` as
 * given, or — with no `args` — the split of a whole command line in `command`,
 * or that line run by `/bin/sh -c` when it needs a shell (`shell`).
 */
export function sandboxArgv(
  command: string,
  args: readonly string[] | undefined,
): { readonly command: string; readonly args: readonly string[]; readonly split: boolean; readonly shell: boolean } {
  if (args !== undefined && args.length > 0) return { command, args, split: false, shell: false };
  const split = splitCommandLine(command);
  if (split !== undefined) return { command: split[0] as string, args: split.slice(1), split: true, shell: false };
  if (/\s/.test(command.trim()) || SHELL_SYNTAX.test(command)) return { command: SHELL, args: ["-c", command], split: false, shell: true };
  return { command, args: [], split: false, shell: false };
}
