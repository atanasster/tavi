import { createInterface } from "node:readline";

import { readOwner } from "@tavi/client/node";
import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { openerShowsUrl, openUrl, privacyProblem } from "@tavi/node-kit";

import { builtCanvasDirectory } from "../../canvas-directory.js";
import { startUiBridge, type UiBridge } from "../../server/ui-bridge.js";
import { onInterrupt } from "../../shared/interrupt.js";

/** `tavi ui`'s options, the data directory resolved. */
export interface UiCommandOptions {
  readonly dataDirectory: string;
  /** Print the link instead of opening a browser. */
  readonly printUrl: boolean;
  /** `0`, any free port, by default. */
  readonly port?: number;
}

export interface UiCommandIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  /** Lines typed at the terminal, when it is one: each asks for a new link. */
  readonly input?: NodeJS.ReadableStream;
}

export interface UiCommandHooks {
  /**
   * Open `url` in the operator's browser; resolves false when it could not.
   * Taken to put the link on a command line, so the shared-host note follows.
   */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** Resolves when the command should stop; SIGINT or SIGTERM otherwise. */
  readonly stopped?: Promise<void>;
  /** Called once the bridge listens: for a test to drive it. */
  readonly onListening?: (bridge: UiBridge) => void;
  readonly staticDirectory?: string;
}

/**
 * `tavi ui`: serve the web canvas on a loopback port and bridge it
 * to the running owner, until interrupted. Refused (exit `unavailable`) when
 * no owner serves the data directory — the bridge is a client, not an owner.
 */
export async function runUi(
  options: UiCommandOptions,
  io: UiCommandIo,
  exit: { readonly ok: number; readonly unavailable: number },
  hooks: UiCommandHooks = {},
): Promise<number> {
  let owner;
  try {
    owner = readOwner(options.dataDirectory, { privacyProblem });
  } catch (error) {
    io.stderr(`tavi ui: ${errorMessage(error)}\n`);
    return exit.unavailable;
  }
  if (owner === undefined) {
    io.stderr(`tavi ui: no tavi owner is serving ${options.dataDirectory}; start \`tavi serve\` first\n`);
    return exit.unavailable;
  }
  // A bridge that could never reach this owner serves no page at all.
  if (owner.protocolVersion !== IPC_PROTOCOL_VERSION) {
    io.stderr(
      `tavi ui: the running \`tavi serve\` speaks IPC protocol ${owner.protocolVersion}; this CLI speaks ${IPC_PROTOCOL_VERSION} — restart the service\n`,
    );
    return exit.unavailable;
  }

  const staticDirectory = hooks.staticDirectory ?? builtCanvasDirectory();
  const port = options.port;
  let bridge: UiBridge;
  try {
    bridge = await startUiBridge({
      dataDirectory: options.dataDirectory,
      ...(staticDirectory === undefined ? {} : { staticDirectory }),
      ...(port === undefined ? {} : { port }),
      log: (line) => io.stderr(`${line}\n`),
    });
  } catch (error) {
    io.stderr(`tavi ui: ${errorMessage(error)}\n`);
    return exit.unavailable;
  }
  hooks.onListening?.(bridge);

  const offer = async (): Promise<void> => {
    const link = bridge.mintLink();
    if (options.printUrl) {
      io.stdout(`${link}\n`);
      return;
    }
    const opened = await (hooks.openBrowser ?? openUrl)(link);
    // A browser that would not open still gets the link, by hand.
    if (!opened) io.stdout(`${link}\n`);
    // The opener's command line held the link, where other users of this computer can read it (not macOS's, which reads it on stdin).
    else if (hooks.openBrowser !== undefined || openerShowsUrl()) io.stderr(SHARED_HOST_NOTE);
  };
  await offer();
  io.stderr(
    `tavi ui is serving ${bridge.origin} for ${options.dataDirectory}. Each link opens one tab, once, within a minute; ` +
      `${io.input === undefined ? "" : "press Enter for another, "}Ctrl-C to stop.\n`,
  );

  const lines = io.input === undefined ? undefined : createInterface({ input: io.input });
  lines?.on("line", () => void offer());
  try {
    await (hooks.stopped ?? interrupted());
  } finally {
    lines?.close();
    await bridge.close();
  }
  return exit.ok;
}

export { builtCanvasDirectory };

/** Said after a link is opened by an opener whose command line held it, which other users can list. */
export const SHARED_HOST_NOTE =
  "If other people have accounts on this computer, use `tavi ui --print-url` instead: it keeps the sign-in link out of the process list, where they could copy it.\n";

function interrupted(): Promise<void> {
  return new Promise((resolve) => {
    const stopListening = onInterrupt(() => {
      stopListening();
      resolve();
    });
  });
}
