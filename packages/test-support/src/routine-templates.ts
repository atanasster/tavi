import { readFileSync } from "node:fs";

import { RoutineTemplateSchema, type RoutineTemplate } from "@tavi/contracts";

/**
 * The trends plugin's `trends-v1` routine template (a copy of what its manifest declares, kept equal by
 * `tests/routine-templates.test.ts`): what an owner with the plugin running copies into a routine's revision, for
 * tests that save one without the plugin.
 */
export function trendsRoutineTemplate(): RoutineTemplate {
  return RoutineTemplateSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/trends-v1.json", import.meta.url), "utf8")));
}
