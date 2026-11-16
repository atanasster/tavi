import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PdfLaunch, PdfWrapped } from "@tavi/contracts";
import { nodeReadRoot, srtArgs, srtEnvironment, srtSettingsOf } from "@tavi/plugin-sandbox/srt-cli";

/**
 * The wrapper the owner builds for a PDF child: srt's CLI with Node and the
 * launch's read roots readable, the home denied, nothing writable and no
 * network. Its settings are written to `settingsFile` at each launch.
 */
export function srtWrapper(settingsFile: string): (launch: PdfLaunch) => PdfWrapped {
  mkdirSync(dirname(settingsFile), { recursive: true });
  const denied = [homedir(), join(homedir(), ".tavi")];
  return (launch) => {
    writeFileSync(
      settingsFile,
      JSON.stringify(
        srtSettingsOf({
          allowedDomains: [],
          denyRead: denied,
          allowRead: [nodeReadRoot(denied), ...launch.readRoots],
          allowWrite: [],
          nested: false,
        }),
      ),
    );
    return { command: process.execPath, args: srtArgs(settingsFile, launch.env, launch.argv), env: srtEnvironment(launch.env) };
  };
}
