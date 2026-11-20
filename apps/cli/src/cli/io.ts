export interface CliIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly isTty: boolean;
  /** Whether standard output alone is a terminal (`isTty` asks of both ends); absent, `isTty` answers. */
  readonly stdoutTty?: boolean;
  /** The terminal's width; absent in a pipe. */
  readonly columns?: number | undefined;
}

export const DEFAULT_IO: CliIo = {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
  stdoutTty: process.stdout.isTTY === true,
  get columns() {
    return process.stdout.columns;
  },
};

/** One line typed at the terminal (`tavi mcp login --paste`); the stream is let go once it is read, or `signal` ends the wait. */
export async function readStdinLine(signal: AbortSignal): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const lines = createInterface({ input: process.stdin });
  try {
    return await lines.question("", { signal });
  } finally {
    lines.close();
  }
}

/**
 * One warning shape for every registry listing.
 *
 * The two lists name different repairs, but the *shape* — count, ids, "fix them
 * with..." — must not drift between them: an operator who saw one should
 * recognize the other.
 */
export function printUnreadableWarning(io: CliIo, noun: string, ids: readonly string[], repair: string): void {
  if (ids.length === 0) return;
  io.stderr(`warning: ${ids.length} ${noun} could not be read: ${ids.join(", ")}. ${repair}\n`);
}

/** A yes from the person at this terminal; anything else is no. */
export async function confirmOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await lines.question(question)).trim());
  } finally {
    lines.close();
  }
}
