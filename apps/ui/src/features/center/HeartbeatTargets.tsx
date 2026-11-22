import { HEARTBEAT_LIMITS, type HeartbeatTarget } from "@tavi/contracts";
import { useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import { useT } from "../../lib/i18n.js";

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
  const t = useT();
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
      ? t("center.heartbeatTargets.unreadable", { error: unreadable })
      : channels.length === 0
        ? t("center.heartbeatTargets.noChannels")
        : full
          ? t("center.heartbeatTargets.full", { count: HEARTBEAT_LIMITS.targets })
          : undefined;
  return (
    <fieldset className="heartbeat-targets">
      <legend>{t("center.heartbeatTargets.where")}</legend>
      <ul>
        <li>{t("center.heartbeatTargets.home")}</li>
        {targets.map((target) => (
          <li key={`${target.connectionId}\u0000${target.to}`}>
            {nameOf(target.connectionId)} · {target.to}{" "}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("center.heartbeatTargets.stop", { to: target.to, channel: nameOf(target.connectionId) })}
              onClick={() => onChange((current) => current.filter((other) => !same(other, target)), t("center.heartbeatTargets.removed"))}
            >
              {t("center.heartbeatTargets.remove")}
            </Button>
          </li>
        ))}
      </ul>
      {confirming !== undefined ? (
        <p role="alert">
          {t("center.heartbeatTargets.confirmText", { to: confirming.to, channel: nameOf(confirming.connectionId) })}{" "}
          <Button
            size="sm"
            onClick={() => {
              onChange(
                (current) => (current.some((other) => same(other, confirming)) ? current : [...current, confirming]),
                t("center.heartbeatTargets.added"),
              );
              setConfirming(undefined);
              setTo("");
            }}
          >
            {t("center.heartbeatTargets.confirm")}
          </Button>{" "}
          <Button variant="ghost" size="sm" onClick={() => setConfirming(undefined)}>
            {t("ui.confirm.cancel")}
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
            {t("center.heartbeatTargets.channel")}{" "}
            <Select
              aria-label={t("center.heartbeatTargets.channel")}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {channels.map((channel) => (
                <option key={channel.connectionId} value={channel.connectionId}>
                  {channel.label}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {t("center.heartbeatTargets.to")} <input value={to} maxLength={256} onChange={(event) => setTo(event.target.value)} />
          </label>
          <Button type="submit" disabled={proposed.to === "" || known}>
            {t("center.heartbeatTargets.add")}
          </Button>
        </form>
      )}
    </fieldset>
  );
}
