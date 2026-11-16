import type { DatabaseTime } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

export function workerClock(time: DatabaseTime): () => string {
  return "fixed" in time ? () => time.fixed : nowTimestamp;
}
