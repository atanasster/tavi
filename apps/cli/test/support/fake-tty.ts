import { PassThrough, Writable } from "node:stream";

/**
 * A terminal for the chat TUI's tests: an output stream Ink treats as a TTY of
 * a fixed size, recording everything written, and an input stream it can put
 * in raw mode, to type into.
 */
export interface FakeTty {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  /** Everything written so far. */
  output(): string;
  /** Type `text`: a return is a carriage return, Ctrl-C is `CTRL_C`, backspace `BACKSPACE`. */
  type(text: string): void;
  /** Paste `text` as a terminal in bracketed-paste mode sends it. */
  paste(text: string): void;
  /** Resize the terminal, as a window resize does: new dimensions, then a `resize` event. */
  resize(size: { readonly rows: number; readonly columns: number }): void;
}

/** What a terminal sends for Ctrl-C in raw mode. */
export const CTRL_C = String.fromCharCode(3);

/** What a terminal sends for Backspace. */
export const BACKSPACE = String.fromCharCode(127);

const ESC = String.fromCharCode(27);

/** Ink's full-terminal clear, scrollback included (issue #990). */
export const CLEAR_SCROLLBACK = `${ESC}[3J`;

export function fakeTty(size: { readonly rows: number; readonly columns: number }): FakeTty {
  let written = "";
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      written += chunk.toString();
      callback();
    },
  });
  Object.assign(stdout, { isTTY: true, rows: size.rows, columns: size.columns });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    output: () => written,
    type: (text) => {
      stdin.write(text);
    },
    paste: (text) => {
      stdin.write(`${ESC}[200~${text}${ESC}[201~`);
    },
    resize: (next) => {
      Object.assign(stdout, { rows: next.rows, columns: next.columns });
      stdout.emit("resize");
    },
  };
}
