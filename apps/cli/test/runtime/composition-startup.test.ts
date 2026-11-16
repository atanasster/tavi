import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * What composing an owner logs on a fresh data directory: nothing it reads at
 * start fails for its own order. The site profiles' first read ran before the
 * external plugins were loaded, and failed on every start until it asked for
 * withdrawn plugins only once there were any to ask about.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

it("reads the site profiles at start without a warning", async () => {
  const directory = directories.create("tavi-startup-");
  const logged: string[] = [];
  runtimes.push(
    await composeTaviRuntime(
      fixtureRuntimeOptions(directory, { logger: { level: "warn", sink: (entry: unknown) => void logged.push(JSON.stringify(entry)) } }),
      { requireModelTransport: false },
    ),
  );
  expect(logged.filter((line) => line.includes("site profiles"))).toEqual([]);
});
