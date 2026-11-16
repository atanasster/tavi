import { Box, render, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { BLINK_CURSOR, GLYPHS, UI_TONES } from "../../tui/theme.js";
import { OnboardCancelled, type ChoiceOption, type Prompter } from "./prompter.js";

/**
 * The terminal renderer for `tavi onboard` and `tavi setup`: Ink, which `tavi chat`
 * already renders with. Each question is its own short-lived render that
 * leaves its answered line behind; a secret shows dots, never its value, and
 * Ctrl-C at any prompt cancels the run with its progress kept.
 */

interface Answered<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/**
 * How a question ends: `finish` marks it answered, and once that render is on screen Ink exits and `settle` runs — the
 * answer, or the cancel — so the answered line is what stays behind.
 */
function useQuestionEnd(): { readonly done: boolean; readonly finish: (settle: () => void) => void } {
  const { exit } = useApp();
  const [done, setDone] = useState(false);
  const outcome = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!done) return;
    exit();
    outcome.current?.();
  }, [done, exit]);
  const finish = (settle: () => void): void => {
    outcome.current = settle;
    setDone(true);
  };
  return { done, finish };
}

function TextQuestion(
  props: Answered<string> & {
    readonly label: string;
    readonly secret: boolean;
    readonly fallback?: string;
    readonly check?: (value: string) => string | undefined;
  },
) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const { done, finish } = useQuestionEnd();
  useInput((character, key) => {
    if (done) return;
    if (key.ctrl && character === "c") {
      finish(() => props.reject(new OnboardCancelled()));
      return;
    }
    if (key.return) {
      const value = typed.trim() === "" && props.fallback !== undefined ? props.fallback : props.secret ? typed : typed.trim();
      const wrong = props.check?.(value);
      if (wrong !== undefined) {
        setProblem(wrong);
        return;
      }
      finish(() => props.resolve(value));
      return;
    }
    if (key.backspace || key.delete) setTyped((before) => before.slice(0, -1));
    else if (!key.ctrl && !key.meta && character !== "") setTyped((before) => before + character);
  });
  const shown = props.secret ? GLYPHS.masked.repeat(Math.min(typed.length, 32)) : typed;
  return (
    <Box flexDirection="column">
      <Text>
        <Text {...UI_TONES.label}>{props.label}</Text>
        {props.fallback !== undefined && !props.secret && typed === "" ? <Text {...UI_TONES.hint}>{` [${props.fallback}]`}</Text> : null}
        <Text>{`: ${shown}${done ? "" : BLINK_CURSOR}`}</Text>
      </Text>
      {problem === undefined || done ? null : <Text {...UI_TONES.problem}>{problem}</Text>}
    </Box>
  );
}

function ChoiceQuestion(
  props: Answered<string> & { readonly label: string; readonly options: readonly ChoiceOption[]; readonly fallback?: string },
) {
  const { exit } = useApp();
  const start = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.fallback),
  );
  const [at, setAt] = useState(start);
  const [done, setDone] = useState(false);
  useInput((character, key) => {
    if (done) return;
    if (key.ctrl && character === "c") {
      props.reject(new OnboardCancelled());
      exit();
      return;
    }
    if (key.upArrow) setAt((index) => (index + props.options.length - 1) % props.options.length);
    else if (key.downArrow) setAt((index) => (index + 1) % props.options.length);
    else if (/^[1-9]$/u.test(character) && Number(character) <= props.options.length) setAt(Number(character) - 1);
    else if (key.return) {
      const option = props.options[at];
      if (option === undefined) return;
      setDone(true);
      props.resolve(option.value);
      exit();
    }
  });
  if (done) return <Text>{`${props.label}: ${props.options[at]?.label ?? ""}`}</Text>;
  return (
    <Box flexDirection="column">
      <Text {...UI_TONES.label}>{props.label}</Text>
      {props.options.map((option, index) => (
        <Text key={option.value} {...(index === at ? UI_TONES.selected : {})}>
          {`${index === at ? GLYPHS.prompt : " "} ${String(index + 1)}. ${option.label}`}
          {option.hint === undefined ? null : <Text {...UI_TONES.hint}>{` — ${option.hint}`}</Text>}
        </Text>
      ))}
    </Box>
  );
}

function ConfirmQuestion(props: Answered<boolean> & { readonly label: string; readonly fallback: boolean }) {
  const [answer, setAnswer] = useState<boolean | undefined>(undefined);
  const { done, finish } = useQuestionEnd();
  useInput((character, key) => {
    if (done) return;
    if (key.ctrl && character === "c") {
      finish(() => props.reject(new OnboardCancelled()));
      return;
    }
    const lowered = character.toLowerCase();
    const value = key.return ? props.fallback : lowered === "y" ? true : lowered === "n" ? false : undefined;
    if (value === undefined) return;
    setAnswer(value);
    finish(() => props.resolve(value));
  });
  return (
    <Text>{`${props.label} ${props.fallback ? "[Y/n]" : "[y/N]"}${answer !== undefined ? ` ${answer ? "yes" : "no"}` : done ? "" : ` ${BLINK_CURSOR}`}`}</Text>
  );
}

export interface InkPrompterStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

export function createInkPrompter(streams: InkPrompterStreams): Prompter {
  const ask = async <T,>(element: (answered: Answered<T>) => React.ReactElement, signal?: AbortSignal): Promise<T> => {
    let settle: Answered<T> | undefined;
    const answer = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const instance = render(element(settle as Answered<T>), {
      stdin: streams.stdin,
      stdout: streams.stdout,
      // Chosen for a terminal alone: drawn live even where `CI` is set, which
      // Ink otherwise takes to mean "print only the last frame".
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    // Subscribed before `exit()` or `unmount()` can run: Ink removes its `beforeExit` listener only during `unmount()`.
    const exited = instance.waitUntilExit().catch(() => undefined);
    // Withdrawn (another way answered it): the question leaves the screen.
    const withdraw = () => {
      settle?.reject(signal?.reason instanceof Error ? signal.reason : new Error("withdrawn"));
      instance.unmount();
    };
    if (signal?.aborted === true) withdraw();
    else signal?.addEventListener("abort", withdraw, { once: true });
    try {
      return await answer;
    } finally {
      signal?.removeEventListener("abort", withdraw);
      instance.cleanup();
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await exited;
    }
  };
  return {
    say: (text) => streams.stdout.write(`${text}\n`),
    text: async (question) =>
      await ask<string>(
        (answered) => (
          <TextQuestion
            {...answered}
            label={question.label}
            secret={question.secret === true}
            {...(question.default === undefined ? {} : { fallback: question.default })}
            {...(question.check === undefined ? {} : { check: question.check })}
          />
        ),
        question.signal,
      ),
    choose: async (question) =>
      await ask<string>((answered) => (
        <ChoiceQuestion
          {...answered}
          label={question.label}
          options={question.options}
          {...(question.default === undefined ? {} : { fallback: question.default })}
        />
      )),
    confirm: async (question) =>
      await ask<boolean>((answered) => <ConfirmQuestion {...answered} label={question.label} fallback={question.default} />),
    close: () => undefined,
  };
}
