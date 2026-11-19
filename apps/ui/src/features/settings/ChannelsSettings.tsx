import { plural } from "@tavi/contracts/util";
import { useCallback, useEffect, useState } from "react";

import type { ChannelConnectionView, ChannelDescriptor, ChannelField, ChannelsRemovePreviewAnswer } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { usePoll } from "../../hooks/use-poll.js";
import { when } from "../../lib/time.js";
import { Confirm } from "../../ui/Confirm.js";
import { Empty } from "../../ui/Empty.js";
import { Modal } from "../../ui/Modal.js";
import { Failure, LoadState, Notice, PageHead, PageNote, StatusBadge, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { AppLink } from "../shell/AppLink.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { appsPath } from "../shell/route.js";
import { ConnectionForm } from "./ChannelConnectionForm.js";
import { People, PeopleEditor } from "./ChannelPeople.js";
import { RoomsAndGrants, Ingress } from "./ChannelRooms.js";
import { request, type Loaded, load, labelOf } from "./channels-api.js";
import { TestSend } from "./ChannelTestSend.js";
import { Button } from "../../ui/Button.js";
import { RowAction, ROW_LINK_CLASS } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * Settings → Channels and Allowed people:
 * every form here is drawn from a channel's descriptor, so a channel a plugin
 * adds is configured the same way as the builtin ones, with no page of its own.
 */

/** How often Channels and Allowed people read the connections again while open. */
const CHANNELS_REFRESH_MS = 15_000;

export function ChannelsSettings({ people = false }: { people?: boolean }) {
  const { client, workspaceId } = useWorkspace();
  const loaded = useLoaded(() => load(client, workspaceId, people));
  // A connection's state and its last message in or out change while the page is open: read again quietly
  // (Mac mini tests: the page showed the pairing message as the last one long after a conversation).
  usePoll(loaded.reload, CHANNELS_REFRESH_MS, { enabled: loaded.data !== undefined }, [loaded.reload]);
  return (
    <section className="settings">
      <PageHead
        className="settings-head"
        title={people ? "Allowed people" : "Channels"}
        description={
          people
            ? "Choose who can chat with the agent through its channels."
            : "Connect the channels the agent can be reached on and send through."
        }
      />
      <LoadState error={loaded.error || undefined} reload={loaded.reload} loading={loaded.loading && loaded.data === undefined} />
      {loaded.data ? (
        people ? (
          <People data={loaded.data} reload={loaded.reload} />
        ) : (
          <Channels data={loaded.data} reload={loaded.reload} />
        )
      ) : null}
    </section>
  );
}

function Channels({ data, reload: reloadPage }: { data: Loaded; reload: () => void }) {
  const { client, workspaceId } = useWorkspace();
  // A connection added or removed is named across the page from now on.
  const { refresh } = useChannelNames();
  const reload = useCallback(() => {
    reloadPage();
    refresh();
  }, [reloadPage, refresh]);
  const [adding, setAdding] = useState(data.catalog[0]?.providerId ?? "");
  const [editing, setEditing] = useState<{ readonly descriptor: ChannelDescriptor; readonly connection?: ChannelConnectionView }>();
  const [testing, setTesting] = useState<ChannelConnectionView>();
  const [rooms, setRooms] = useState<ChannelConnectionView>();
  const [remove, setRemove] = useState<ChannelConnectionView>();
  const [peopleOf, setPeopleOf] = useState<string>();
  const { note, tone, run, say } = useAction(reload);
  const descriptorOf = (providerId: string): ChannelDescriptor | undefined =>
    data.catalog.find((descriptor) => descriptor.providerId === providerId);
  return (
    <>
      <Notice>
        Saving a connection applies at once. Secrets are kept in the credential store and never returned to this page; leave a saved one
        blank to keep it.
      </Notice>
      <section className="settings-panel">
        <h2 className="settings-section-title">Connections</h2>
        {!data.list.connections.length ? (
          <Empty>No channels are connected in this workspace yet.</Empty>
        ) : (
          <ul className="rows">
            {data.list.connections.map((connection) => {
              const descriptor = descriptorOf(connection.providerId);
              const line = distinctParts(connection.label, [
                labelOf(data.catalog, connection.providerId),
                connection.accountIdentity,
                connection.status.detail,
              ]);
              return (
                <li className="row" key={connection.connectionId}>
                  <div>
                    <strong>{connection.label}</strong> <StatusBadge status={connection.enabled ? connection.status.state : "disabled"} />
                    {line === "" ? null : <p className="settings-description">{line}</p>}
                    <ActivityLine status={connection.status} />
                    {data.peopleKnown ? (
                      <AllowedLine people={data.people.filter((person) => person.connectionId === connection.connectionId)} />
                    ) : null}
                  </div>
                  <div className="actions">
                    {/* Its app's page in Connected apps: signing in, who may use it, and what it did. A channel's app is named by its provider. */}
                    <AppLink href={appsPath({ appId: connection.providerId })} className={ROW_LINK_CLASS} onFollow={undefined}>
                      Open app
                    </AppLink>
                    <RowAction aria-label={`People on ${connection.label}`} onClick={() => setPeopleOf(connection.connectionId)}>
                      People
                    </RowAction>
                    <RowAction
                      aria-label={`Test ${connection.label}`}
                      disabled={connection.status.state !== "running"}
                      onClick={() => setTesting(connection)}
                    >
                      Test
                    </RowAction>
                    {/* A group channel's rooms: whether each reads its recent messages, and the room and contact grants. */}
                    {descriptor?.groups !== undefined ? (
                      <RowAction aria-label={`Rooms of ${connection.label}`} onClick={() => setRooms(connection)}>
                        Rooms
                      </RowAction>
                    ) : null}
                    {descriptor !== undefined ? (
                      <RowAction aria-label={`Edit ${connection.label}`} onClick={() => setEditing({ descriptor, connection })}>
                        Edit
                      </RowAction>
                    ) : null}
                    {/* Removable with its channel gone too (an uninstalled plugin's): removing needs nothing of the channel. */}
                    <RowAction tone="danger" aria-label={`Remove ${connection.label}`} onClick={() => setRemove(connection)}>
                      Remove
                    </RowAction>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {data.catalog.length ? (
          <div className="actions">
            <label>
              Channel
              <Select aria-label="New connection channel" value={adding} onChange={(event) => setAdding(event.target.value)}>
                {data.catalog.map((descriptor) => (
                  <option key={descriptor.providerId} value={descriptor.providerId}>
                    {descriptor.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="primary"
              onClick={() => {
                const descriptor = descriptorOf(adding);
                if (descriptor !== undefined) setEditing({ descriptor });
              }}
            >
              Add connection
            </Button>
          </div>
        ) : (
          <Empty>No channel is installed.</Empty>
        )}
      </section>
      <PageNote tone={tone} note={note || undefined} />
      <Ingress data={data.list} reload={reload} />
      {editing ? (
        <ConnectionForm
          descriptor={editing.descriptor}
          connection={editing.connection}
          oauthClient={data.list.oauthClients[editing.descriptor.providerId]}
          encrypted={data.list.credentialsEncrypted}
          onOAuthClientChanged={reload}
          onClose={() => setEditing(undefined)}
          onSaved={(saved, connectionId) => {
            // A new connection answers no one until someone is allowed on it: who, is asked next.
            if (editing.connection === undefined) setPeopleOf(connectionId);
            setEditing(undefined);
            say(saved);
            reload();
          }}
        />
      ) : null}
      {peopleOf === undefined ? null : (
        <ConnectionPeople
          data={data}
          connectionId={peopleOf}
          reload={reload}
          onClose={() => setPeopleOf(undefined)}
          onAllowed={(allowed) => {
            setPeopleOf(undefined);
            say(allowed);
          }}
        />
      )}
      {testing ? (
        <TestSend connection={testing} descriptor={descriptorOf(testing.providerId)} onClose={() => setTesting(undefined)} />
      ) : null}
      {rooms ? <RoomsAndGrants connection={rooms} onClose={() => setRooms(undefined)} /> : null}
      {remove ? (
        <RemoveConnection
          connection={remove}
          onClose={() => setRemove(undefined)}
          onConfirm={(purging) =>
            run("remove", async () => {
              const answer = await request(client, { action: "delete", workspaceId, connectionId: remove.connectionId });
              if (!answer.ok) return answer;
              return {
                ok: true,
                value: purging
                  ? `${remove.label} removed. What it brought in is erased in 24 hours; adding the same account back before then cancels it.`
                  : `${remove.label} removed.`,
              };
            })
          }
        />
      ) : null}
    </>
  );
}

/**
 * Removing a connection: on a channel that purges, what goes 24 hours
 * later, how to keep a copy of each conversation first, and the delivery
 * targets that go with it; on any other, that its history stays.
 */
function RemoveConnection({
  connection,
  onClose,
  onConfirm,
}: {
  connection: ChannelConnectionView;
  onClose: () => void;
  onConfirm: (purging: boolean) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const [preview, setPreview] = useState<ChannelsRemovePreviewAnswer>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    void request<ChannelsRemovePreviewAnswer>(client, {
      action: "remove-preview",
      workspaceId,
      connectionId: connection.connectionId,
    }).then((answer) => {
      if (answer.ok) setPreview(answer.value);
      else setFailure(answer.message);
    });
  }, [client, workspaceId, connection.connectionId]);
  if (preview === undefined)
    return (
      <Modal title="Remove connection?" onClose={onClose}>
        {failure === undefined ? <Empty>Loading what it would erase…</Empty> : <Failure message={failure} />}
      </Modal>
    );
  if (preview.retention !== "purge-on-remove")
    return (
      <Confirm
        title="Remove connection?"
        message={`Close ${connection.label} and delete its saved secrets. Its conversations stay in history; people allowed on it can no longer reach the agent through it.`}
        action="Remove connection"
        onClose={onClose}
        onConfirm={() => onConfirm(false)}
      />
    );
  const notes = preview.notes === undefined ? "the chat notes its chats taught" : `${plural(preview.notes, "chat note")} its chats taught`;
  return (
    <Confirm
      title="Remove and erase?"
      message={`Close ${connection.label}, delete its saved secrets and stop the people allowed on it. In 24 hours Tavi erases what it brought in, as its channel's terms require: ${plural(preview.conversations, "conversation")}, ${plural(preview.messages, "message")}, ${plural(preview.files, "file")} and ${notes}. Adding the same account back before then cancels it; to keep everything, disable it instead.`}
      action="Remove and erase"
      onClose={onClose}
      onConfirm={() => onConfirm(true)}
    >
      {preview.tasks.length ? (
        <>
          <p className="settings-description">To keep a copy, export each conversation first:</p>
          <ul>
            {preview.tasks.map((taskId) => (
              <li key={taskId}>
                <Command>{`tavi tasks history ${taskId} export`}</Command>
              </li>
            ))}
          </ul>
          {preview.moreTasks > 0 ? (
            <p className="settings-description">
              …and {preview.moreTasks} more: <Command>tavi tasks</Command> lists them.
            </p>
          ) : null}
        </>
      ) : null}
      {preview.routineTargets.length || preview.heartbeats ? (
        <p className="settings-description">
          Delivery targets on it go too:
          {preview.routineTargets.length
            ? ` ${preview.routineTargets.length === 1 ? "routine target" : "routine targets"} ${preview.routineTargets.join(", ")}`
            : ""}
          {preview.routineTargets.length && preview.heartbeats ? " and" : ""}
          {preview.heartbeats ? ` ${plural(preview.heartbeats, "heartbeat target")}` : ""}.
        </p>
      ) : null}
    </Confirm>
  );
}

/** Who may start a conversation on a connection; until someone is allowed, it answers no one. */
function AllowedLine({ people }: { people: Loaded["people"] }) {
  if (people.length === 0)
    return (
      <p className="settings-description">
        <span className="badge badge-warning">No one allowed</span> It answers no one until you allow a person on it.
      </p>
    );
  return (
    <p className="settings-description">
      Allowed: {people.map((person) => `${person.displayName ?? person.principalId} (${person.externalSenderId})`).join(", ")}
    </p>
  );
}

/** Allowed people for one connection, from its row on Channels: the same form as Allowed people, without picking the connection. */
function ConnectionPeople({
  data,
  connectionId,
  reload,
  onClose,
  onAllowed,
}: {
  data: Loaded;
  connectionId: string;
  reload: () => void;
  onClose: () => void;
  /** Someone was allowed: the dialog's job is done, and its note goes to the page. */
  onAllowed: (note: string) => void;
}) {
  const connection = data.list.connections.find((candidate) => candidate.connectionId === connectionId);
  return (
    <Modal title={`People on ${connection?.label ?? connectionId}`} onClose={onClose}>
      {connection === undefined ? (
        <Empty>Loading the connection…</Empty>
      ) : (
        <PeopleEditor data={data} reload={reload} only={connection} onAllowed={onAllowed} />
      )}
    </Modal>
  );
}

/**
 * A connection's line under its name: the channel, the account and any
 * detail, each said once, and none that only repeats the name ("Telegram ·
 * Telegram" under a connection called Telegram).
 */
export function distinctParts(name: string, parts: readonly (string | undefined)[]): string {
  const seen = new Set([name.trim().toLowerCase()]);
  return parts
    .flatMap((part) => {
      const key = part?.trim().toLowerCase();
      if (key === undefined || key === "" || seen.has(key)) return [];
      seen.add(key);
      return [part as string];
    })
    .join(" · ");
}

/** "last message received 14:02 · last sent 14:05", and why the last send failed. */
function ActivityLine({ status }: { status: ChannelConnectionView["status"] }) {
  const parts = [
    status.lastInboundAt === undefined ? undefined : `last message received ${when(status.lastInboundAt, undefined)}`,
    status.lastSendAt === undefined ? undefined : `last sent ${when(status.lastSendAt, undefined)}`,
    status.lastError === undefined ? undefined : `last send failed: ${status.lastError}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : <p className="settings-description">{parts.join(" · ")}</p>;
}

/** A setting's value as the connection keeps it, in words. */
function settingWords(field: ChannelField, value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (field.type === "boolean") return value === true ? "on" : "off";
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * A channel's connections on its app's page (Connected apps → the channel):
 * each one's name, account, settings, which secrets are saved, and who may
 * reach the agent through it — edited here or in Settings → Channels, with the
 * same forms.
 */
export function ChannelAppConnections({ providerId }: { providerId: string }) {
  const { client, workspaceId } = useWorkspace();
  const loaded = useLoaded(() => load(client, workspaceId, false));
  const { refresh } = useChannelNames();
  const reload = useCallback(() => {
    loaded.reload();
    refresh();
  }, [loaded.reload, refresh]);
  const [peopleOf, setPeopleOf] = useState<string>();
  const [editing, setEditing] = useState<ChannelConnectionView>();
  const { note, say } = useAction(reload);
  const data = loaded.data;
  const descriptor = data?.catalog.find((candidate) => candidate.providerId === providerId);
  const connections = data?.list.connections.filter((connection) => connection.providerId === providerId) ?? [];
  return (
    <>
      <LoadState error={loaded.error || undefined} reload={loaded.reload} loading={loaded.loading} />
      {data === undefined ? null : !connections.length ? (
        <Empty>No connection of {descriptor?.label ?? providerId} in this workspace yet: add one in Channels.</Empty>
      ) : (
        <ul className="rows">
          {connections.map((connection) => {
            const settings = (descriptor?.settings ?? []).flatMap((field) => {
              const words = settingWords(field, connection.settings[field.key]);
              return words === undefined ? [] : [`${field.label}: ${words}`];
            });
            const secrets =
              descriptor === undefined || descriptor.auth.kind === "none"
                ? []
                : (descriptor.auth.fields ?? []).map(
                    (field) => `${field.label}: ${connection.secretsStored[field.key] ? "saved" : "not set"}`,
                  );
            return (
              <li className="row" key={connection.connectionId}>
                <div>
                  <strong>{connection.label}</strong> <StatusBadge status={connection.enabled ? connection.status.state : "disabled"} />
                  <p className="settings-description">
                    {connection.accountIdentity}
                    {connection.status.detail === undefined ? "" : ` · ${connection.status.detail}`}
                  </p>
                  {settings.length || secrets.length ? (
                    <p className="settings-description">{[...settings, ...secrets].join(" · ")}</p>
                  ) : null}
                  <ActivityLine status={connection.status} />
                  {data.peopleKnown ? (
                    <AllowedLine people={data.people.filter((person) => person.connectionId === connection.connectionId)} />
                  ) : null}
                </div>
                <div className="actions">
                  <RowAction aria-label={`People on ${connection.label}`} onClick={() => setPeopleOf(connection.connectionId)}>
                    People
                  </RowAction>
                  {descriptor !== undefined ? (
                    <RowAction aria-label={`Edit ${connection.label}`} onClick={() => setEditing(connection)}>
                      Edit
                    </RowAction>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <StatusNote note={note || undefined} />
      {data === undefined || peopleOf === undefined ? null : (
        <ConnectionPeople
          data={data}
          connectionId={peopleOf}
          reload={reload}
          onClose={() => setPeopleOf(undefined)}
          onAllowed={(allowed) => {
            setPeopleOf(undefined);
            say(allowed);
          }}
        />
      )}
      {data === undefined || editing === undefined || descriptor === undefined ? null : (
        <ConnectionForm
          descriptor={descriptor}
          connection={editing}
          oauthClient={data.list.oauthClients[descriptor.providerId]}
          encrypted={data.list.credentialsEncrypted}
          onOAuthClientChanged={reload}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            say(saved);
            reload();
          }}
        />
      )}
    </>
  );
}
