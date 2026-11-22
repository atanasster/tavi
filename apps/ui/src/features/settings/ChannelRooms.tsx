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
import { ActionNote, BusyFieldset, Failure, StatusBadge, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { request } from "./channels-api.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/**
 * A group channel's rooms and grants: whether each room reads its recent
 * messages beside one that addresses the agent, and the operator's grants of
 * tools in a room (deny only) or in one person's one-to-one chat. Rooms are
 * added from the platform's list where the channel can list them, from those
 * waiting, or with \`tavi channels rooms\`; a listed room is shown by the name
 * the operator gave it, the platform's names only in the picker.
 */
export function RoomsAndGrants({ connection, onClose }: { connection: ChannelConnectionView; onClose: () => void }) {
  const t = useT();
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
    <Modal title={t("settings.rooms.title", { label: connection.label })} busy={busy} onClose={onClose}>
      <h3>{t("settings.rooms.rooms")}</h3>
      {rooms === undefined ? (
        <Empty>{t("settings.rooms.loading")}</Empty>
      ) : !rooms.rooms.length ? (
        <Empty>
          {unlisted.length
            ? t("settings.rooms.emptyPick")
            : withParts(t("settings.rooms.emptyAdd"), {
                command: <Command>{`tavi channels rooms ${connectionId} add <id>`}</Command>,
              })}
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
                    {room.conversationId} · {t("settings.rooms.answersWhen", { trigger: triggerInWords(room.trigger) })} ·{" "}
                    {room.members === "operator-only" ? t("settings.rooms.onlyYou") : t("settings.rooms.allowedPeople")} ·{" "}
                    {room.context === "recent" ? t("settings.rooms.readsRecent", { count: 20 }) : t("settings.rooms.readsOnly")}
                  </p>
                  {refused === undefined ? null : (
                    <p className="settings-description">{t("settings.rooms.refused", { reason: refused })}</p>
                  )}
                  {room.introState === "pending" ? (
                    <p className="settings-description">{t("settings.rooms.introPending")}</p>
                  ) : room.introState === "uncertain" ? (
                    <p className="settings-description">{t("settings.rooms.introUncertain")}</p>
                  ) : null}
                </div>
                <div className="actions">
                  <RowAction
                    disabled={busy}
                    aria-label={t(room.context === "recent" ? "settings.rooms.stopReadingLabel" : "settings.rooms.readLabel", {
                      label: room.label,
                    })}
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
                          ? t("settings.rooms.nowReadsOnly", { label: room.label })
                          : t("settings.rooms.nowReadsRecent", { label: room.label }),
                      )
                    }
                  >
                    {room.context === "recent" ? t("settings.rooms.readOnlyAction") : t("settings.rooms.readRecentAction")}
                  </RowAction>
                  <RowAction
                    tone="danger"
                    disabled={busy}
                    aria-label={t("settings.rooms.removeLabel", { label: room.label })}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "remove", conversationId: room.conversationId },
                        t("settings.rooms.removed", { label: room.label }),
                      )
                    }
                  >
                    {t("settings.action.remove")}
                  </RowAction>
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
              void act({ action: "rooms", workspaceId, connectionId, op: "add", conversationId: picked }, t("settings.rooms.added"));
            }
          }}
        >
          <BusyFieldset busy={busy} label={t("settings.rooms.adding")} className="settings-fields">
            <label>
              {t("settings.rooms.addTitle")}
              <Select aria-label={t("settings.rooms.addLabel")} value={picked} onChange={(event) => setPicked(event.target.value)}>
                <option value="">{t("settings.rooms.choose")}</option>
                {unlisted.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.place === undefined ? candidate.name : `${candidate.name} (${candidate.place})`}
                  </option>
                ))}
              </Select>
            </label>
            <div className="actions">
              <Button variant="primary" type="submit" disabled={picked === ""}>
                {t("settings.rooms.add")}
              </Button>
            </div>
          </BusyFieldset>
        </form>
      ) : null}
      {rooms?.waiting.length ? (
        <>
          <h3>{t("settings.rooms.waiting")}</h3>
          <ul className="rows">
            {rooms.waiting.map((waiting) => (
              <li className="row" key={waiting.conversationId}>
                <div>
                  <strong>{waiting.roomName ?? waiting.conversationId}</strong>
                  <p className="settings-description">
                    {waiting.conversationId} ·{" "}
                    {waiting.how === "added" ? t("settings.rooms.addedBy", { by: waiting.by }) : t("settings.rooms.spoke")}
                  </p>
                </div>
                <div className="actions">
                  <RowAction
                    disabled={busy}
                    aria-label={t("settings.rooms.addAsLabel", { name: waiting.roomName ?? waiting.conversationId })}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "add", conversationId: waiting.conversationId },
                        t("settings.rooms.added"),
                      )
                    }
                  >
                    {t("settings.rooms.addAs")}
                  </RowAction>
                  {/* The bot leaves where its channel can; elsewhere the refusal says to remove it in the room itself. */}
                  <RowAction
                    tone="danger"
                    disabled={busy}
                    aria-label={t("settings.rooms.leaveLabel", { name: waiting.roomName ?? waiting.conversationId })}
                    onClick={() =>
                      void act(
                        { action: "rooms", workspaceId, connectionId, op: "leave", conversationId: waiting.conversationId },
                        t("settings.rooms.left"),
                      )
                    }
                  >
                    {t("settings.rooms.leave")}
                  </RowAction>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {dropped.length ? (
        <p className="settings-description">
          {t("settings.rooms.dropped", { list: dropped.map(([reason, count]) => `${String(count)} ${reason}`).join(", ") })}
        </p>
      ) : null}
      <h3>{t("settings.rooms.grants")}</h3>
      {grants === undefined ? null : !grants.grants.length ? (
        <Empty>{t("settings.rooms.noGrants")}</Empty>
      ) : (
        <ul className="rows">
          {grants.grants.map((grant) => (
            <li className="row" key={grant.grantId}>
              <div>
                <strong>{t(grant.mode === "deny" ? "settings.rooms.denyTool" : "settings.rooms.allowTool", { tool: grant.toolId })}</strong>
                <p className="settings-description">
                  {t(grant.scopeKind === "room" ? "settings.rooms.scopeRoom" : "settings.rooms.scopeContact", { id: grant.scopeId })}
                  {grant.inForce ? "" : ` · ${grant.revokedAt !== undefined ? t("settings.rooms.revoked") : t("settings.rooms.expired")}`}
                </p>
              </div>
              {grant.inForce ? (
                <div className="actions">
                  <RowAction
                    tone="danger"
                    disabled={busy}
                    aria-label={t("settings.rooms.revokeLabel", { id: grant.grantId })}
                    onClick={() =>
                      void act(
                        { action: "grants", workspaceId, connectionId, op: "revoke", grantId: grant.grantId },
                        t("settings.rooms.revokedNote"),
                      )
                    }
                  >
                    {t("settings.rooms.revoke")}
                  </RowAction>
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
            t("settings.rooms.granted"),
          );
        }}
      >
        <BusyFieldset busy={busy} label={t("settings.rooms.savingGrant")} className="settings-fields">
          <label>
            {t("settings.rooms.where")}
            <Select
              aria-label={t("settings.rooms.scopeLabel")}
              value={scopeKind}
              onChange={(event) => {
                const next = event.target.value === "room" ? "room" : "contact";
                setScopeKind(next);
                if (next === "room") setMode("deny");
              }}
            >
              <option value="contact">{t("settings.rooms.scopeContactOption")}</option>
              <option value="room">{t("settings.rooms.scopeRoomOption")}</option>
            </Select>
          </label>
          <label>
            {scopeKind === "room" ? t("settings.rooms.roomId") : t("settings.rooms.senderId")}
            <input
              aria-label={t("settings.rooms.scopeIdLabel")}
              required
              maxLength={256}
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            />
          </label>
          <label>
            {t("settings.mcp.review.tool")}
            <input
              aria-label={t("settings.rooms.toolLabel")}
              required
              maxLength={200}
              value={toolId}
              placeholder="fs.write"
              onChange={(event) => setToolId(event.target.value)}
            />
          </label>
          <label>
            {t("settings.rooms.grant")}
            <Select
              aria-label={t("settings.rooms.modeLabel")}
              value={mode}
              onChange={(event) => setMode(event.target.value === "allow" ? "allow" : "deny")}
            >
              <option value="deny">{t("settings.rooms.deny")}</option>
              {scopeKind === "contact" ? <option value="allow">{t("settings.rooms.allowAsked")}</option> : null}
            </Select>
          </label>
          {/* What the last grant or revoke said, over the footer it answers rather than under it. */}
          <StatusNote note={note} />
          <Failure message={failure} />
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              {t("settings.action.close")}
            </Button>
            <Button variant="primary" type="submit">
              {t("settings.rooms.saveGrant")}
            </Button>
          </div>
        </BusyFieldset>
      </form>
    </Modal>
  );
}
export function Ingress({ data, reload }: { data: ChannelsListAnswer; reload: () => void }) {
  const t = useT();
  const { client } = useWorkspace();
  const [port, setPort] = useState(data.ingress.port);
  const [publicUrl, setPublicUrl] = useState(data.ingress.publicUrl ?? "");
  const { busy, note, tone, run } = useAction(reload);
  const save = (): Promise<void> =>
    run("ingress", async () => {
      const answer = await request<ChannelsIngressAnswer>(client, { action: "ingress", port, publicUrl: publicUrl.trim() });
      if (!answer.ok) return answer;
      if (answer.value.notApplied !== undefined)
        return { ok: true, value: t("settings.ingress.notApplied", { reason: answer.value.notApplied }) };
      return { ok: true, value: t("settings.ingress.saved") };
    });
  return (
    <form
      className="settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="settings-section-title">{t("settings.ingress.title")}</h2>
      <BusyFieldset busy={busy !== undefined} className="settings-fields">
        <p className="settings-description">{withParts(t("settings.ingress.help"), { path: <code>/hooks/</code> })}</p>
        <label>
          {t("settings.ingress.port")}
          <input
            aria-label={t("settings.ingress.port")}
            type="number"
            min={1024}
            max={65535}
            required
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <label>
          {t("settings.ingress.publicOptional")}
          <input
            aria-label={t("settings.ingress.public")}
            type="url"
            placeholder="https://hooks.example.com/tavi"
            maxLength={2048}
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
          />
        </label>
        <div className="actions">
          {/* Off until something is changed, as every Save on these pages (Mac mini tests). */}
          <Button
            variant="primary"
            type="submit"
            disabled={port === data.ingress.port && publicUrl.trim() === (data.ingress.publicUrl ?? "")}
          >
            {busy === "ingress" ? t("ui.parts.saving") : t("settings.ingress.save")}
          </Button>
        </div>
      </BusyFieldset>
      <ActionNote tone={tone} note={note || undefined} />
    </form>
  );
}
