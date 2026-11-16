import { localTime } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { HEARTBEAT_POLL_MS, useSharedHeartbeat } from "./heartbeat-source.js";

/**
 * The rail's pill: on, off or paused, and the next check; read again whenever `revision` moves, and every `refreshMs`
 * while the page shows (its next check moves on its own), from the one read Recurring's heartbeat row shares.
 */
export function HeartbeatPill({
  revision = 0,
  refreshMs = HEARTBEAT_POLL_MS,
  onOpen,
}: {
  readonly revision?: number;
  readonly refreshMs?: number;
  readonly onOpen: () => void;
}) {
  const { data: answer } = useSharedHeartbeat({ refreshMs, revision });
  if (answer === undefined) return null;
  const { config } = answer;
  const status = !config.enabled
    ? "off"
    : config.paused !== undefined
      ? "paused"
      : `on · next ${answer.state?.nextTickAt === undefined ? "—" : localTime(answer.state.nextTickAt, answer.timezone)}`;
  return (
    <Button className="chip heartbeat-pill" onClick={onOpen}>
      Heartbeat {status}
    </Button>
  );
}
