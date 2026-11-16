import { HEARTBEAT_LIMITS, type HeartbeatTarget } from "@tavi/contracts";
import { useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";

import { heartbeatChannels, type HeartbeatChannel } from "./heartbeat-api.js";
import { Select } from "../../ui/Select.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * *Where* in Center → Heartbeat: Home always, and the channel targets its
 * urgent items and summary also go to. A target is added by choosing one of
 * the workspace's enabled channels and who on it, then confirming that the
 * heartbeat may message them; each is removed alone.
 */
export function HeartbeatTargets({
  targets,
  onChange,
}: {
  readonly targets: readonly HeartbeatTarget[];
  /** Applied, when its turn comes, to the targets as the owner last answered them. */
  readonly onChange: (update: (current: readonly HeartbeatTarget[]) => readonly HeartbeatTarget[], said: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const { data, error: unreadable } = useLoaded(() => heartbeatChannels(client, workspaceId), [client, workspaceId]);
  const channels: readonly HeartbeatChannel[] = data ?? [];
  const [chosen, setConnectionId] = useState("");
  // The first channel until one is chosen.
  const connectionId = chosen || channels[0]?.connectionId || "";
  const [to, setTo] = useState("");
  const [confirming, setConfirming] = useState<HeartbeatTarget | undefined>();
  const nameOf = (id: string): string => channels.find((channel) => channel.connectionId === id)?.label ?? id;
  const full = targets.length >= HEARTBEAT_LIMITS.targets;
  const proposed: HeartbeatTarget = { connectionId, to: to.trim() };
  const same = (a: HeartbeatTarget, b: HeartbeatTarget): boolean => a.connectionId === b.connectionId && a.to === b.to;
  const known = targets.some((target) => same(target, proposed));
  /** Why a target cannot be added now, when it cannot. */
  const blocked =
    unreadable !== undefined
      ? `The channels could not be read: ${unreadable}`
      : channels.length === 0
        ? "Connect a channel in Settings → Channels to be messaged there too."
        : full
          ? `At most ${HEARTBEAT_LIMITS.targets} channel targets: remove one to add another.`
          : undefined;
  return (
    <fieldset className="heartbeat-targets">
      <legend>Where</legend>
      <ul>
        <li>Home (always, when it is on)</li>
        {targets.map((target) => (
          <li key={`${target.connectionId}\u0000${target.to}`}>
            {nameOf(target.connectionId)} · {target.to}{" "}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop messaging ${target.to} on ${nameOf(target.connectionId)}`}
              onClick={() => onChange((current) => current.filter((other) => !same(other, target)), "Removed.")}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {confirming !== undefined ? (
        <p role="alert">
          The heartbeat will also message {confirming.to} on {nameOf(confirming.connectionId)}: urgent items as they come, and the summary.{" "}
          <Button
            size="sm"
            onClick={() => {
              onChange((current) => (current.some((other) => same(other, confirming)) ? current : [...current, confirming]), "Added.");
              setConfirming(undefined);
              setTo("");
            }}
          >
            Confirm
          </Button>{" "}
          <Button variant="ghost" size="sm" onClick={() => setConfirming(undefined)}>
            Cancel
          </Button>
        </p>
      ) : blocked !== undefined ? (
        <p className="meta-sm">{blocked}</p>
      ) : (
        <form
          className="heartbeat-target-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (proposed.to !== "" && proposed.connectionId !== "" && !known) setConfirming(proposed);
          }}
        >
          <label>
            Channel{" "}
            <Select aria-label="Channel" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {channels.map((channel) => (
                <option key={channel.connectionId} value={channel.connectionId}>
                  {channel.label}
                </option>
              ))}
            </Select>
          </label>
          <label>
            To <input value={to} maxLength={256} onChange={(event) => setTo(event.target.value)} />
          </label>
          <Button variant="ghost" size="sm" type="submit" disabled={proposed.to === "" || known}>
            Add
          </Button>
        </form>
      )}
    </fieldset>
  );
}
