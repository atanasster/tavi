/**
 * The CLI's output, captured. `CapturedIo` is `CliIo`'s shape
 * (`apps/cli/src/main.ts`), so a capture's `io` is passed wherever the CLI
 * takes one.
 */

export interface CapturedIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly isTty: boolean;
}

export interface Capture {
  readonly io: CapturedIo;
  /** Everything written to stdout so far. */
  readonly stdout: () => string;
  /** Everything written to stderr so far. */
  readonly stderr: () => string;
  /** `stdout`, by the shorter name some suites use. */
  readonly out: () => string;
  /** `stderr`, by the shorter name some suites use. */
  readonly err: () => string;
}

/** An io that records what the CLI writes. */
export function capture(isTty = false): Capture {
  let out = "";
  let err = "";
  const stdout = (): string => out;
  const stderr = (): string => err;
  return {
    io: {
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: (chunk) => {
        err += chunk;
      },
      isTty,
    },
    stdout,
    stderr,
    out: stdout,
    err: stderr,
  };
}

/** An io that drops what the CLI writes. */
export const quietIo: CapturedIo = { stdout: () => {}, stderr: () => {}, isTty: false };
