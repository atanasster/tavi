import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLinePrompter, OnboardCancelled, wantsPlainPrompts } from "../../src/features/onboard/prompter.js";

/** The plain line renderer: one reader, a hidden answer kept apart, Ctrl-C cancelling. */

/** A stand-in terminal: input that says it is a TTY and records its raw mode. */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    modes: [] as boolean[],
    setRawMode(mode: boolean) {
      this.modes.push(mode);
      return this;
    },
  });
  let written = "";
  const prompter = createLinePrompter({ input, write: (text) => void (written += text) });
  return { input, prompter, written: () => written };
}

describe("the line prompter", () => {
  it("reads a hidden answer at a terminal in raw mode, echoes none of it, and hands the next question only its own line", async () => {
    const { input, prompter, written } = terminal();
    const key = prompter.text({ label: "Key (hidden)", secret: true });
    input.write("sk-hidden-1");
    input.write("2\r");
    expect(await key).toBe("sk-hidden-12");
    const model = prompter.text({ label: "Model id" });
    input.write("m1\n");
    expect(await model).toBe("m1");
    expect(input.modes).toEqual([true, false]);
    expect(written()).not.toContain("sk-hidden");
    prompter.close();
  });

  it("applies each erasure at a hidden prompt, DEL or BS, one character apiece", async () => {
    const { input, prompter } = terminal();
    const key = prompter.text({ label: "Key (hidden)", secret: true });
    // `ab`, two erasures, then `cd`: nothing of `ab` is left (a regex that erased in pairs left `a`).
    input.write("ab\u007f\u007fcd\r");
    expect(await key).toBe("cd");
    const again = prompter.text({ label: "Key (hidden)", secret: true });
    // Windows's console sends BS; an erasure with nothing before it erases nothing.
    input.write("\bxy\bz\r");
    expect(await again).toBe("xz");
    prompter.close();
  });

  it("cancels on Ctrl-C at a hidden prompt, and when the input ends", async () => {
    const { input, prompter } = terminal();
    const key = prompter.text({ label: "Key", secret: true });
    input.write("abc\u0003");
    await expect(key).rejects.toBeInstanceOf(OnboardCancelled);
    const ended = new PassThrough();
    const plain = createLinePrompter({ input: ended, write: () => {} });
    const answer = plain.confirm({ label: "Go?", default: true });
    ended.end();
    await expect(answer).rejects.toBeInstanceOf(OnboardCancelled);
  });

  it("numbers choices, takes a number, a value or Enter for the default, and asks again otherwise", async () => {
    const input = new PassThrough();
    let written = "";
    const prompter = createLinePrompter({ input, write: (text) => void (written += text) });
    input.write("9\nb\n");
    expect(
      await prompter.choose({
        label: "Pick",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B", hint: "second" },
        ],
        default: "a",
      }),
    ).toBe("b");
    expect(written).toContain("  2. B — second");
    expect(written).toContain("Type a number from 1 to 2.");
    // No ANSI sequence anywhere: a screen reader reads every byte.
    expect(written).not.toMatch(/\u001b\[/u);
  });

  it("is the renderer for TERM=dumb, a screen reader, --plain or no terminal", () => {
    expect(wantsPlainPrompts({ TERM: "dumb" }, { isTty: true })).toBe(true);
    expect(wantsPlainPrompts({ TAVI_SCREEN_READER: "1" }, { isTty: true })).toBe(true);
    expect(wantsPlainPrompts({}, { isTty: true, plain: true })).toBe(true);
    expect(wantsPlainPrompts({}, { isTty: false })).toBe(true);
    expect(wantsPlainPrompts({ TERM: "xterm-256color" }, { isTty: true })).toBe(false);
  });
});
