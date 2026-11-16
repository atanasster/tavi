/** The argument parsing every command shares: the flag loop (`parseFlags`), a whole-number flag (`integerFlag`), `--data-dir`, and the usage error they throw. */

/** The names every removal action answers to: a command's help names its own, and lists the others as aliases. */
export const REMOVAL_ALIASES = ["rm", "remove", "delete"] as const;

/** `typed`, with any removal name read as the command's own (`own`): `rm`, `remove` and `delete` all work everywhere. */
export function removalAlias(typed: string | undefined, own: (typeof REMOVAL_ALIASES)[number]): string | undefined {
  return typed !== undefined && (REMOVAL_ALIASES as readonly string[]).includes(typed) ? own : typed;
}

export class UsageError extends Error {
  readonly usage: string;

  constructor(message: string, usage: string) {
    super(message);
    this.name = "UsageError";
    this.usage = usage;
  }
}

/**
 * A whole-number flag value: digits only, so `50abc`, `1e3`, `-1`, `2.0` and the empty
 * string are refused (`parseInt` and `Number` take some of them), within `min` and, when
 * given, `max`. `refusal` is the usage error's message, in the command's own words.
 */
export function integerFlag(raw: string, bounds: { readonly min: number; readonly max?: number }, refusal: string, usage: string): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < bounds.min || (bounds.max !== undefined && value > bounds.max))
    throw new UsageError(refusal, usage);
  return value;
}

/**
 * Spread a `--data-dir` only when the operator actually passed one.
 *
 * The default is deliberately absent here: `data-directory.ts` owns the single resolution
 * order (flag, then `TAVI_DATA_DIR`, then the per-user default) so no command can pick a
 * different directory and write to the wrong database.
 */
export function dataDirectoryFlag(flags: ReadonlyMap<string, string>): { readonly dataDirectory?: string } {
  const value = flags.get("--data-dir");
  return value === undefined ? {} : { dataDirectory: value };
}

/**
 * Resolve a flag's value, rejecting a missing value and a following flag.
 *
 * `tavi serve --data-dir --model x` must not silently read `--model` as the data
 * directory, so every parser applies the same rule: reject ambiguous
 * input rather than guess.
 */
function flagValue(name: string, inlineValue: string | undefined, next: string | undefined, usage: string): string {
  if (inlineValue !== undefined) {
    if (inlineValue === "") throw new UsageError(`Option ${name} requires a value`, usage);
    return inlineValue;
  }
  if (next === undefined || next.startsWith("--")) {
    throw new UsageError(`Option ${name} requires a value`, usage);
  }
  return next;
}

function splitFlag(token: string): readonly [string, string | undefined] {
  const separator = token.indexOf("=");
  if (separator === -1) return [token, undefined];
  return [token.slice(0, separator), token.slice(separator + 1)];
}

/** A repeated single-valued flag, refused: the wording every command shares unless it names its own. */
function onlyOnce(name: string): string {
  return `${name} may be given only once`;
}

export interface FlagRules {
  readonly usage: string;
  /** The flags that take a value; left out, any `--name` does. */
  readonly valued?: readonly string[];
  /** Bare switches this invocation accepts, matched as the whole token. */
  readonly switches?: readonly string[];
  /** Valued flags that may repeat; their values are kept in order under `lists`. */
  readonly lists?: readonly string[];
  /**
   * Valued flags whose value is the next token whatever it looks like, a
   * flag-shaped one included: an argument passed through to another command
   * line (`service install --serve-arg --model`).
   */
  readonly verbatim?: readonly string[];
  /** The refusal of a flag outside `valued`. */
  readonly unknown?: (name: string) => string;
  /** The refusal of `--switch=value`; left out, such a token is judged as a valued flag. */
  readonly switchValue?: (name: string) => string;
  /** A single-valued flag given twice is refused, with this wording (by default {@link onlyOnce}). */
  readonly repeated?: (name: string) => string;
  /** Refuse a repeated flag before its value is read, so `--x a --x` says it is repeated rather than missing a value. */
  readonly repeatedFirst?: boolean;
  /**
   * Keep a bare switch in `flags` as `"true"` (never refused as repeated)
   * rather than in `switches`, where a later `--switch=value` is then judged
   * as a repeat of it.
   */
  readonly switchesInFlags?: boolean;
  /** The refusal of a positional argument, given those already taken; left out, every one is taken. */
  readonly positional?: (token: string, taken: readonly string[]) => string | undefined;
}

export interface ParsedFlags {
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

/**
 * The flag loop every command family shares: `-h`/`--help` anywhere asks for
 * the page (answered as `"help"`), `--name value` and `--name=value` read the
 * same way, and a flag the invocation does not take is refused, never ignored.
 */
export function parseFlags(argv: readonly string[], rules: FlagRules): ParsedFlags | "help" {
  const { usage } = rules;
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const lists = new Map<string, string[]>();
  const positionals: string[] = [];
  const unknown = rules.unknown ?? ((name: string) => `${name} is not an option here`);
  const repeated = rules.repeated ?? onlyOnce;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "-h" || token === "--help") return "help";
    if (rules.switches?.includes(token) === true) {
      if (rules.switchesInFlags === true) flags.set(token, "true");
      else switches.add(token);
      continue;
    }
    if (!token.startsWith("--")) {
      const refusal = rules.positional?.(token, positionals);
      if (refusal !== undefined) throw new UsageError(refusal, usage);
      positionals.push(token);
      continue;
    }
    const [name, inlineValue] = splitFlag(token);
    if (rules.switchValue !== undefined && rules.switches?.includes(name) === true) throw new UsageError(rules.switchValue(name), usage);
    if (rules.valued !== undefined && !rules.valued.includes(name)) throw new UsageError(unknown(name), usage);
    const single = rules.lists?.includes(name) !== true;
    if (single && rules.repeatedFirst === true && flags.has(name)) throw new UsageError(repeated(name), usage);
    const next = argv[index + 1];
    const value =
      rules.verbatim?.includes(name) === true && inlineValue === undefined && next !== undefined
        ? next
        : flagValue(name, inlineValue, next, usage);
    if (inlineValue === undefined) index += 1;
    if (rules.lists?.includes(name) === true) {
      lists.set(name, [...(lists.get(name) ?? []), value]);
      continue;
    }
    if (single && flags.has(name)) throw new UsageError(repeated(name), usage);
    flags.set(name, value);
  }
  return { flags, switches, lists, positionals };
}
