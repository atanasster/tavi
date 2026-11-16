import { useCallback, useEffect, useState } from "react";

import {
  triggerInWords,
  type ChannelConnectionView,
  type ChannelsIngressAnswer,
  type ChannelsListAnswer,
  type ChannelsPayload,
  type ChannelsGrantsAnswer,
  type ChannelsRoomsAnswer,
} from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { Empty } from "../../ui/Empty.js";
import { Modal } from "../../ui/Modal.js";
import { BusyFieldset, Failure, StatusBadge, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { request } from "./channels-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * A group channel's rooms and grants: whether each room reads its recent
 * messages beside one that addresses the agent, and the operator's grants of
 * tools in a room (deny only) or in one person's one-to-one chat. Rooms are
 * added from the platform's list where the channel can list them, from those
 * waiting, or with \`tavi channels rooms\`; a listed room is shown by the name
 * the operator gave it, the platform's names only in the picker.
 */
export function RoomsAndGrants({ connection, onClose }: { connection: ChannelConnectionView; onClose: () => void }) {
  const { client, workspaceId } = useWorkspace();
  const connectionId = connection.connectionId;
  const [rooms, setRooms] = useState<ChannelsRoomsAnswer>();
  const [grants, setGrants] = useState<ChannelsGrantsAnswer>();
  const [failure, setFailure] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [scopeKind, setScopeKind] = useState<"room" | "contact">("contact");
  const [scopeId, setScopeId] = useState("");
  const [toolId, setToolId] = useState("");
  const [mode, setMode] = useState<"allow" | "deny">("deny");
  const [picked, setPicked] = useState("");
  const load = useCallback(async () => {
    const [listed, granted] = await Promise.all([
      request<ChannelsRoomsAnswer>(client, { action: "rooms", workspaceId, connectionId, op: "list" }),
      request<ChannelsGrantsAnswer>(client, { action: "grants", workspaceId, connectionId, op: "list" }),
    ]);
    if (!listed.ok) {
      setFailure(listed.message);
      return;
    }
    if (!granted.ok) {
      setFailure(granted.message);
      return;
    }
    setRooms(listed.value);
    setGrants(granted.value);
  }, [client, workspaceId, connectionId]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (payload: ChannelsPayload, done: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    setNote(undefined);
    const answer = await request<{ readonly notApplied?: string }>(client, payload);
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    setNote(answer.value.notApplied === undefined ? done : `${done} ${answer.value.notApplied}`);
    await load();
  };
  // The platform's rooms not listed yet, for the picker: their names are the platform's, display only.
  const unlisted = rooms?.candidates?.filter((candidate) => !rooms.rooms.some((room) => room.conversationId === candidate.id)) ?? [];
  const dropped = Object.entries(rooms?.drops ?? {}).filter(([, count]) => count !== undefined && count > 0);
  return (
    <Modal title={`Rooms of ${connection.label}`} busy={busy} onClose={onClose}>
      <h3>Rooms</h3>
      {rooms === undefined ? (
        <Empty>Loading…</Empty>
      ) : !rooms.rooms.length ? (
        <Empty>
          No rooms yet
          {unlisted.length ? (
            ": pick one below"
          ) : (
            <>
              : add one with <Command>{`tavi channels rooms ${connectionId} add <id>`}</Command>
            </>
          )}
          .
        </Empty>
      ) : (
        <ul className="rows">
          {rooms.rooms.map((room) => {
            const refused = rooms.details?.[room.conversationId];
            return (
              <li className="row" key={room.conversationId}>
                <div>
                  <strong>{room.label}</strong>
                  {room.disabledAt === undefined ? null : (
                    <>
                      {" "}
                      <StatusBadge status="disabled" />
                    </>
                  )}
                  <p className="settings-description">
                    {room.conversationId} · {`answers when they ${triggerInWords(room.trigger)}`} ·{" "}
                    {room.members === "operator-only" ? "only you" : "people you allowed"} ·{" "}
                    {room.context === "recent"
                      ? "reads up to 20 messages before one that addresses Tavi"
                      : "reads only the message that addresses Tavi"}
                  </p>
                  {refused === undefined ? null : <p className="settings-description">Its last message was refused: {refused}</p>}
                  {room.introState === "pending" ? (
                    <p className="settings-description">
                      Its introduction was not sent: Tavi tries again the next time the room is listed with the connection open.
                    </p>
                  ) : room.introState === "uncertain" ? (
                    <p className="settings-description">Its introduction may not have been sent, so it is not sent again.</p>
                  ) : null}
                </div>
                <div className="actions">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${room.context === "recent" ? "Stop reading" : "Read"} recent messages in ${room.label}`}
                    onClick={() =>
                      void act(
                        {
                          action: "rooms",
                          workspaceId,
                          connectionId,
                          op: "set",
                          conversationId: room.conversationId,
                          context: room.context === "recent" ? "off" : "recent",
                        },
                        room.context === "recent"
                          ? `${room.label} reads only what addresses Tavi.`
                          : `${room.label} reads its recent messages.`,
                      )
                    }
                  >
                    {room.context === "recent" ? "Read only the message" : "Read recent messages"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={`Remove room ${room.label}`}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "remove", conversationId: room.conversationId },
                        `${room.label} is no longer listened to.`,
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {unlisted.length ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (picked !== "") {
              setPicked("");
              void act(
                { action: "rooms", workspaceId, connectionId, op: "add", conversationId: picked },
                "Room added; it is told whose agent this is.",
              );
            }
          }}
        >
          <BusyFieldset busy={busy} label="Adding the room…" className="settings-fields">
            <label>
              Add a room
              <Select aria-label="Room to add" value={picked} onChange={(event) => setPicked(event.target.value)}>
                <option value="">Choose a room…</option>
                {unlisted.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.place === undefined ? candidate.name : `${candidate.name} (${candidate.place})`}
                  </option>
                ))}
              </Select>
            </label>
            <div className="actions">
              <Button variant="primary" type="submit" disabled={picked === ""}>
                Add room
              </Button>
            </div>
          </BusyFieldset>
        </form>
      ) : null}
      {rooms?.waiting.length ? (
        <>
          <h3>Waiting for you</h3>
          <ul className="rows">
            {rooms.waiting.map((waiting) => (
              <li className="row" key={waiting.conversationId}>
                <div>
                  <strong>{waiting.roomName ?? waiting.conversationId}</strong>
                  <p className="settings-description">
                    {waiting.conversationId} · {waiting.how === "added" ? `the bot was added by ${waiting.by}` : "spoke while unlisted"}
                  </p>
                </div>
                <div className="actions">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Add ${waiting.roomName ?? waiting.conversationId} as a room`}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "add", conversationId: waiting.conversationId },
                        "Room added; it is told whose agent this is.",
                      )
                    }
                  >
                    Add as room
                  </Button>
                  {/* The bot leaves where its channel can; elsewhere the refusal says to remove it in the room itself. */}
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={`Leave ${waiting.roomName ?? waiting.conversationId}`}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "leave", conversationId: waiting.conversationId },
                        "The bot left that room.",
                      )
                    }
                  >
                    Leave
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {dropped.length ? (
        <p className="settings-description">
          Not taken in since Tavi started: {dropped.map(([reason, count]) => `${String(count)} ${reason}`).join(", ")}. Nothing of these is
          kept.
        </p>
      ) : null}
      <h3>Grants</h3>
      {grants === undefined ? null : !grants.grants.length ? (
        <Empty>No grants.</Empty>
      ) : (
        <ul className="rows">
          {grants.grants.map((grant) => (
            <li className="row" key={grant.grantId}>
              <div>
                <strong>
                  {grant.mode === "deny" ? "Deny" : "Allow"} {grant.toolId}
                </strong>
                <p className="settings-description">
                  {grant.scopeKind === "room" ? "room" : "one-to-one chat with"} {grant.scopeId}
                  {grant.inForce ? "" : grant.revokedAt !== undefined ? " · revoked" : " · expired"}
                </p>
              </div>
              {grant.inForce ? (
                <div className="actions">
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={`Revoke ${grant.grantId}`}
                    onClick={() =>
                      void act(
                        { action: "grants", workspaceId, connectionId, op: "revoke", grantId: grant.grantId },
                        "Revoked, from the chat's next turn.",
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(
            { action: "grants", workspaceId, connectionId, op: "add", scopeKind, scopeId: scopeId.trim(), toolId: toolId.trim(), mode },
            "Granted.",
          );
        }}
      >
        <BusyFieldset busy={busy} label="Saving the grant…" className="settings-fields">
          <label>
            Where
            <Select
              aria-label="Grant scope"
              value={scopeKind}
              onChange={(event) => {
                const next = event.target.value === "room" ? "room" : "contact";
                setScopeKind(next);
                if (next === "room") setMode("deny");
              }}
            >
              <option value="contact">One person's one-to-one chat</option>
              <option value="room">A room</option>
            </Select>
          </label>
          <label>
            {scopeKind === "room" ? "Room id" : "Their sender id"}
            <input
              aria-label="Grant scope id"
              required
              maxLength={256}
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            />
          </label>
          <label>
            Tool
            <input
              aria-label="Grant tool"
              required
              maxLength={200}
              value={toolId}
              placeholder="fs.write"
              onChange={(event) => setToolId(event.target.value)}
            />
          </label>
          <label>
            Grant
            <Select aria-label="Grant mode" value={mode} onChange={(event) => setMode(event.target.value === "allow" ? "allow" : "deny")}>
              <option value="deny">Deny</option>
              {scopeKind === "contact" ? <option value="allow">Allow (asked, as anywhere)</option> : null}
            </Select>
          </label>
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" type="submit">
              Save grant
            </Button>
          </div>
        </BusyFieldset>
      </form>
      <StatusNote note={note} />
      <Failure message={failure} />
    </Modal>
  );
}
export function Ingress({ data, reload }: { data: ChannelsListAnswer; reload: () => void }) {
  const { client } = useWorkspace();
  const [port, setPort] = useState(data.ingress.port);
  const [publicUrl, setPublicUrl] = useState(data.ingress.publicUrl ?? "");
  const { busy, note, run } = useAction(reload);
  const save = (): Promise<void> =>
    run("ingress", async () => {
      const answer = await request<ChannelsIngressAnswer>(client, { action: "ingress", port, publicUrl: publicUrl.trim() });
      if (!answer.ok) return answer;
      if (answer.value.notApplied !== undefined)
        return { ok: true, value: `Saved, but the listener could not move: ${answer.value.notApplied}` };
      return { ok: true, value: "Saved and applied." };
    });
  return (
    <form
      className="settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="settings-section-title">Webhooks</h2>
      <BusyFieldset busy={busy !== undefined} className="settings-fields">
        <p className="settings-description">
          Channels that receive webhooks share one listener on 127.0.0.1. Put it behind your HTTPS proxy and enter the proxy’s address; each
          connection’s webhook is under its <code>/hooks/</code> path.
        </p>
        <label>
          Local webhook port
          <input
            aria-label="Local webhook port"
            type="number"
            min={1024}
            max={65535}
            required
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <label>
          Public address (optional)
          <input
            aria-label="Public address"
            type="url"
            placeholder="https://hooks.example.com/tavi"
            maxLength={2048}
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
          />
        </label>
        <div className="actions">
          <Button variant="primary" type="submit">
            {busy === "ingress" ? "Saving…" : "Save webhooks"}
          </Button>
        </div>
      </BusyFieldset>
      <StatusNote note={note || undefined} />
    </form>
  );
}
