// turbo as Node runs it: `process.execPath` on turbo's JavaScript entry, which
// starts the platform's binary. `node_modules/.bin/turbo` is a shell script on
// macOS and Linux and a `.cmd` shim on Windows, which Node will not spawn
// without a shell.
import { createRequire } from "node:module";
import { join } from "node:path";

/** The command and leading arguments that run the workspace's turbo from `root`. */
export function turboCommand(root) {
  const entry = createRequire(join(root, "package.json")).resolve("turbo/bin/turbo");
  return [process.execPath, [entry]];
}
