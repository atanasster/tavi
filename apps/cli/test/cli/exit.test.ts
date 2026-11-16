import { describe, expect, it } from "vitest";

import { EXIT, refusalExit } from "../../src/cli/exit.js";

function capture(): { readonly io: { readonly stderr: (chunk: string) => void }; readonly text: () => string } {
  let text = "";
  return { io: { stderr: (chunk) => void (text += chunk) }, text: () => text };
}

describe("an owner's refusal, printed", () => {
  it("prints its message as one line with the terminal's control characters taken out", () => {
    const out = capture();
    refusalExit(out.io, { message: "no such chat\u001b[31m here", code: "NOT_FOUND" });
    expect(out.text()).toBe("no such chat[31m here\n");
  });

  it("prints the fallback when it carries no message, and the default fallback when none is given", () => {
    const named = capture();
    refusalExit(named.io, undefined, "could not read the chat's instructions");
    expect(named.text()).toBe("could not read the chat's instructions\n");
    const plain = capture();
    refusalExit(plain.io, {});
    expect(plain.text()).toBe("the owner refused\n");
  });

  it.each([
    ["INVALID_INPUT", EXIT.usage],
    ["CONFLICT", EXIT.usage],
    ["UNSUPPORTED", EXIT.usage],
    ["INTERNAL", EXIT.internal],
    ["NOT_FOUND", EXIT.unavailable],
    [undefined, EXIT.unavailable],
  ])("exits as the same refusal offline does for %s", (code, exit) => {
    expect(refusalExit(capture().io, code === undefined ? undefined : { message: "refused", code })).toBe(exit);
  });
});
