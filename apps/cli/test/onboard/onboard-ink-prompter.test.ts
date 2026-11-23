import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { coreIn } from "@tavi/contracts/locales/core-server";

import { createInkPrompter } from "../../src/features/onboard/ink-prompter.js";
import { OnboardCancelled } from "../../src/features/onboard/prompter.js";
import { fakeTty } from "../support/fake-tty.js";
import { delay } from "@tavi/test-support";

/** The TTY renderer of `tavi onboard`: each question answered by keys on a fake terminal. */

const tick = async (): Promise<void> => await delay(60);

function terminal() {
  const tty = fakeTty({ rows: 20, columns: 80 });
  const prompter = createInkPrompter({ stdin: tty.stdin, stdout: tty.stdout });
  const keys = async (...sequence: readonly string[]) => {
    for (const key of sequence) {
      await tick();
      tty.type(key);
    }
  };
  return { prompter, keys, output: () => stripVTControlCharacters(tty.output()) };
}

describe("the Ink prompter", () => {
  it("shows a secret as dots, never its value, and answers what was typed", async () => {
    const { prompter, keys, output } = terminal();
    const answer = prompter.text({ label: "API key", secret: true });
    await keys("sk-planted");
    await tick();
    expect(output()).toContain("█");
    const beforeEnter = output().length;
    await keys("\r");
    expect(await answer).toBe("sk-planted");
    expect(output()).not.toContain("sk-planted");
    expect(output()).toContain("•");
    expect(output().slice(beforeEnter)).toContain("API key");
    expect(output().slice(beforeEnter)).not.toContain("█");
  });

  it("says why a value does not do and keeps asking, and takes the default on an empty line", async () => {
    const { prompter, keys, output } = terminal();
    const checked = prompter.text({ label: "Name", check: (value) => (value === "x" ? "Too short" : undefined) });
    await keys("x", "\r");
    await tick();
    expect(output()).toContain("Too short");
    await keys("\u007F", "Robin", "\r");
    expect(await checked).toBe("Robin");
    const fallback = prompter.text({ label: "Time zone", default: "UTC" });
    await keys("\r");
    expect(await fallback).toBe("UTC");
  });

  it("chooses by arrows or by number, starting at the default", async () => {
    const { prompter, keys } = terminal();
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ];
    const arrowed = prompter.choose({ label: "Which?", options, default: "b" });
    await keys("\u001B[B", "\r");
    expect(await arrowed).toBe("c");
    const numbered = prompter.choose({ label: "Which?", options });
    await keys("2", "\r");
    expect(await numbered).toBe("b");
  });

  it("confirms with y or n, and Enter takes the default", async () => {
    const { prompter, keys } = terminal();
    const yes = prompter.confirm({ label: "Start it now?", default: false });
    await keys("y");
    expect(await yes).toBe(true);
    const fallback = prompter.confirm({ label: "Start it now?", default: true });
    await keys("\r");
    expect(await fallback).toBe(true);
  });

  it("confirms in Bulgarian with д or н, still takes y and n, and shows [Д/н] and its answer in Bulgarian", async () => {
    const { prompter, keys, output } = terminal();
    prompter.useWords?.(coreIn("bg"));
    const yes = prompter.confirm({ label: "Да започна ли?", default: true });
    await keys("x", "д");
    expect(await yes).toBe(true);
    expect(output()).toContain("Да започна ли? [Д/н] да");
    const no = prompter.confirm({ label: "Да спра ли?", default: true });
    await keys("Н");
    expect(await no).toBe(false);
    expect(output()).toContain("Да спра ли? [Д/н] не");
    const english = prompter.confirm({ label: "Още?", default: false });
    await keys("y");
    expect(await english).toBe(true);
  });

  it("cancels the run on Ctrl-C at any question", async () => {
    for (const ask of [
      (prompter: ReturnType<typeof createInkPrompter>) => prompter.text({ label: "Name" }),
      (prompter: ReturnType<typeof createInkPrompter>) => prompter.choose({ label: "Which?", options: [{ value: "a", label: "Alpha" }] }),
      (prompter: ReturnType<typeof createInkPrompter>) => prompter.confirm({ label: "Sure?", default: true }),
    ]) {
      const { prompter, keys, output } = terminal();
      const asked = ask(prompter);
      await tick();
      const beforeCancel = output().length;
      await keys("\u0003");
      await expect(asked).rejects.toBeInstanceOf(OnboardCancelled);
      expect(output().slice(beforeCancel)).not.toContain("█");
    }
  });

  it("withdraws a question when its signal aborts", async () => {
    const { prompter } = terminal();
    const controller = new AbortController();
    const asked = prompter.text({ label: "Paste the key", signal: controller.signal });
    await tick();
    controller.abort(new Error("signed in elsewhere"));
    await expect(asked).rejects.toThrow("signed in elsewhere");
  });

  it("cleans up process beforeExit listeners after each question", async () => {
    const { prompter, keys } = terminal();
    const before = process.listenerCount("beforeExit");
    const asked = prompter.confirm({ label: "Proceed?", default: true });
    await keys("\r");
    expect(await asked).toBe(true);
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});
