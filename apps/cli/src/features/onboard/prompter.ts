import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import { yesNoHint, yesNoOf } from "../../shared/terminal-words.js";

/**
 * The prompts `tavi onboard` and `tavi setup` ask: pure questions answered by a renderer. The steps never touch a
 * terminal themselves, so the same step drives the Ink renderer at a TTY, the
 * plain line renderer for dumb terminals and screen readers, and the tests'
 * scripted streams.
 */

/** Ctrl-C, or the input ending, at any prompt: progress is kept and the run exits 130. */
export class OnboardCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "OnboardCancelled";
  }
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  /** One line after the label: what it costs, what it needs. */
  readonly hint?: string;
}

export interface Prompter {
  /** A line of the flow's own output. */
  say(text: string): void;
  /** One line typed: `secret` is never echoed. `check` answers why a value does not do, and the question is asked again. */
  /** `signal`: the question withdrawn (another way answered it); the promise then rejects and the next question gets the next line. */
  text(question: {
    readonly label: string;
    readonly default?: string;
    readonly secret?: boolean;
    readonly check?: (value: string) => string | undefined;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  choose(question: { readonly label: string; readonly options: readonly ChoiceOption[]; readonly default?: string }): Promise<string>;
  confirm(question: { readonly label: string; readonly default: boolean }): Promise<boolean>;
  /**
   * The prompter's own words from now on — the `[Y/n]` hint, "Answer y or n." — in the workspace's language
   * (English until told). A yes or no is read in either language whatever these are.
   */
  useWords?(t: CoreT): void;
  /** The words `useWords` last gave (English before it was called): the flow says its own lines in them. */
  words?(): CoreT;
  close(): void;
}

export interface LinePrompterStreams {
  readonly input: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
}

type TtyInput = NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

/** A line typed in raw mode with its erasures applied: DEL (most terminals) or BS (Windows's console) removes the character before it. */
function erased(typed: string): string {
  const kept: string[] = [];
  for (const char of typed) {
    if (char === "\u007f" || char === "\b") kept.pop();
    else kept.push(char);
  }
  return kept.join("");
}

/**
 * The plain renderer: one line per prompt, no live region, no colour,
 * numbered choices. Used under `TERM=dumb`, `TAVI_SCREEN_READER=1` or
 * `--plain`, and by the scripted tests. One reader takes every byte, so a
 * hidden answer can never reach the next question: at a TTY a secret is read
 * in raw mode, echoing nothing, with Ctrl-C cancelling; elsewhere it is read
 * as the line it is, and never written back.
 */
export function createLinePrompter(streams: LinePrompterStreams): Prompter {
  const input = streams.input as TtyInput;
  let t: CoreT = coreEnglish;
  let buffered = "";
  let ended = false;
  let waiting: { readonly hidden: boolean; readonly resolve: (line: string) => void; readonly reject: (error: Error) => void } | undefined;
  /** Hand a complete line, or a hidden answer, to the question waiting for it. */
  const drain = () => {
    if (waiting === undefined) return;
    const asked = waiting;
    if (asked.hidden && input.isTTY === true) {
      for (let index = 0; index < buffered.length; index += 1) {
        const char = buffered[index] as string;
        if (char === "\u0003") {
          buffered = "";
          waiting = undefined;
          asked.reject(new OnboardCancelled());
          return;
        }
        if (char === "\r" || char === "\n") {
          const line = erased(buffered.slice(0, index));
          buffered = buffered.slice(index + (buffered[index + 1] === "\n" && char === "\r" ? 2 : 1));
          waiting = undefined;
          streams.write("\n");
          asked.resolve(line);
          return;
        }
      }
      return;
    }
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      waiting = undefined;
      asked.resolve(line);
    } else if (ended) {
      waiting = undefined;
      if (buffered !== "") {
        const line = buffered;
        buffered = "";
        asked.resolve(line);
      } else asked.reject(new OnboardCancelled());
    }
  };
  const onData = (chunk: Buffer | string) => {
    buffered += chunk.toString();
    drain();
  };
  const onEnd = () => {
    ended = true;
    drain();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  const line = async (hidden = false, signal?: AbortSignal): Promise<string> => {
    const raw = hidden && input.isTTY === true && input.setRawMode !== undefined;
    if (raw) input.setRawMode?.(true);
    let withdraw: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        const asked = { hidden: raw, resolve, reject };
        waiting = asked;
        if (signal !== undefined) {
          withdraw = () => {
            if (waiting === asked) waiting = undefined;
            streams.write("\n");
            reject(signal.reason instanceof Error ? signal.reason : new Error("withdrawn"));
          };
          if (signal.aborted) withdraw();
          else signal.addEventListener("abort", withdraw, { once: true });
        }
        drain();
      });
    } finally {
      if (withdraw !== undefined) signal?.removeEventListener("abort", withdraw);
      if (raw) input.setRawMode?.(false);
    }
  };
  return {
    say: (text) => streams.write(`${text}\n`),
    async text(question) {
      for (;;) {
        streams.write(`${question.label}${question.default === undefined || question.secret === true ? "" : ` [${question.default}]`}: `);
        const typed = (await line(question.secret === true, question.signal)).trim();
        const value = typed === "" && question.default !== undefined ? question.default : typed;
        const wrong = question.check?.(value);
        if (wrong === undefined) return value;
        streams.write(`${wrong}\n`);
      }
    },
    async choose(question) {
      question.options.forEach((option, index) =>
        streams.write(`  ${String(index + 1)}. ${option.label}${option.hint === undefined ? "" : ` — ${option.hint}`}\n`),
      );
      const fallback =
        question.default === undefined ? undefined : question.options.findIndex((option) => option.value === question.default) + 1;
      for (;;) {
        streams.write(`${question.label}${fallback === undefined || fallback === 0 ? "" : ` [${String(fallback)}]`}: `);
        const typed = (await line()).trim();
        const picked = typed === "" ? fallback : Number(typed);
        const option = picked === undefined || !Number.isInteger(picked) ? undefined : question.options[picked - 1];
        if (option !== undefined) return option.value;
        // A choice's own value, typed: as good as its number.
        const named = question.options.find((candidate) => candidate.value === typed);
        if (named !== undefined) return named.value;
        streams.write(`${t("prompt.choose.retry", { n: String(question.options.length) })}\n`);
      }
    },
    async confirm(question) {
      for (;;) {
        streams.write(`${question.label} ${yesNoHint(question.default, t)} `);
        const typed = (await line()).trim();
        if (typed === "") return question.default;
        const answer = yesNoOf(typed);
        if (answer !== undefined) return answer;
        streams.write(`${t("prompt.confirm.retry")}\n`);
      }
    },
    useWords: (words) => {
      t = words;
    },
    words: () => t,
    close: () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      // A terminal's stdin is let go, so the command that follows (or the process) is not held open.
      if (input.isTTY === true) (input as NodeJS.ReadableStream & { pause?: () => void }).pause?.();
    },
  };
}

/** Whether the plain renderer is wanted: a dumb terminal, a screen reader, `--plain`, or no TTY at all. */
export function wantsPlainPrompts(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly plain?: boolean; readonly isTty: boolean },
): boolean {
  return options.plain === true || !options.isTty || env["TERM"] === "dumb" || env["TAVI_SCREEN_READER"] === "1";
}
