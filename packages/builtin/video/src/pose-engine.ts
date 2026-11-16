import type { VideoPoseEnginePort } from "@tavi/contracts";

import { drawOverlay } from "./overlay.js";
import { evaluatePose } from "./template-engine.js";

/** The built-in pose arithmetic and overlays: what `video.pose` measures and draws with. */
export function createVideoPoseEngine(): VideoPoseEnginePort {
  return { evaluate: evaluatePose, overlay: drawOverlay };
}
