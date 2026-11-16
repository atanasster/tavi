import type { RoutineEffectPort } from "../src/routines/grants.js";
import type { RoutineExecutionService } from "../src/routines/runs.js";
import { routineSkillContext } from "../src/routines/skills.js";
export function asyncRoutineEffects(runs: RoutineExecutionService): RoutineEffectPort {
  return {
    options: runs.options,
    skillContext: async (scope, pins) => routineSkillContext(runs.routines.store, scope, pins),
    append: async (...args) => runs.append(...args),
    assertFence: async (...args) => runs.assertFence(...args),
    beginStep: async (...args) => runs.beginStep(...args),
    heartbeat: async (...args) => runs.heartbeat(...args),
    knownRetired: async (...args) => runs.knownRetired(...args),
    recordEgressDenial: async (...args) => runs.recordEgressDenial(...args),
    recordRetirement: async (...args) => runs.recordRetirement(...args),
    remainingMs: async (...args) => runs.remainingMs(...args),
    reserveControlTool: async (...args) => runs.reserveControlTool(...args),
    reserveModel: async (...args) => runs.reserveModel(...args),
    reserveTool: async (...args) => runs.reserveTool(...args),
    settleModel: async (...args) => runs.settleModel(...args),
  };
}
