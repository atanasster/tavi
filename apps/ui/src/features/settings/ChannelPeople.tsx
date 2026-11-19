import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  MESSAGING_DISPLAY_NAME_MAX,
  type ChannelConnectionView,
  type ChannelDescriptor,
  type ChannelsPairAnswer,
  type ChannelsPairingAnswer,
} from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { usePoll } from "../../hooks/use-poll.js";
import { mapOutcome } from "../../lib/ipc.js";
import { when } from "../../lib/time.js";
import { Confirm } from "../../ui/Confirm.js";
import { Empty } from "../../ui/Empty.js";
import { ActionNote, BusyFieldset, Failure, Notice, PageNote } from "../../ui/Parts.js";
import { PairingLinkBox, claimedSenderLabel, shownPairingCode } from "../../ui/QrCode.js";
import { Select } from "../../ui/Select.js";
import { request, type Loaded, labelOf } from "./channels-api.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { ChannelNotRunning, notRunningChannel } from "./ChannelNotRunning.js";

/** How long the pairing panel waits between asking whether the code has been sent. */
const PAIRING_POLL_MS = 2000;
/**
 * A pairing in progress: the code to send, then who sent
 * it, to allow as the person — or not.
 */
function PairingPanel({
  pairing,
  channel,
  linked,
  onDone,
  onRetry,
}: {
  pairing: ChannelsPairAnswer & { readonly principalId: string; readonly name?: string; readonly me: boolean };
  channel: string;
  /** Someone is already allowed on this connection: their own messages are never read as a code. */
  linked: boolean;
  onDone: (note: string | undefined) => void;
  onRetry: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [status, setStatus] = useState<ChannelsPairingAnswer>({ state: "waiting" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<string>();
  const generation = useRef(0);
  const question = useRef<HTMLParagraphElement>(null);
  const panel = useRef<HTMLElement>(null);
  // The panel opens below the form, often past the dialog's fold: bring the code into view (Mac mini tests).
  // In braces: a browser whose scrollIntoView returns a promise must not hand React that promise as the cleanup.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);
  const who = pairing.name ?? pairing.principalId;
  const check = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    const answer = await request<ChannelsPairingAnswer>(client, { action: "pairing", workspaceId, pairingId: pairing.pairingId });
    if (mine !== generation.current) return;
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    setFailure(undefined);
    // On the 24-hour clock the code's expiry is shown on, with seconds as the check runs every two.
    setCheckedAt(new Date().toLocaleTimeString("en-GB", { hourCycle: "h23" }));
    setStatus(answer.value);
  }, [client, workspaceId, pairing.pairingId]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (status.state === "claimed") question.current?.focus();
  }, [status.state]);
  usePoll(
    (alive) => {
      if (alive()) void check();
    },
    PAIRING_POLL_MS,
    { enabled: status.state === "waiting" },
    [check],
  );
  const finish = async (action: "confirm-pair" | "cancel-pair"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const answer = await request(client, { action, workspaceId, pairingId: pairing.pairingId });
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    const allowed = pairing.me
      ? "You're paired: your messages on this channel now reach Tavi."
      : `${who} is paired: their messages on this channel now reach Tavi.`;
    onDone(action === "confirm-pair" ? allowed : undefined);
  };
  const code = shownPairingCode(pairing.code);
  let body: ReactNode;
  if (status.state === "claimed") {
    const sender = claimedSenderLabel(status);
    body = (
      <>
        <p ref={question} tabIndex={-1}>
          A message from <strong>{sender}</strong> on {channel} carried the code. {pairing.me ? "Is this you?" : `Allow them as ${who}?`}
        </p>
        {/* Pairing yourself is asked as Welcome asks it (QA 1832). */}
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            {pairing.me ? "Not me" : "Not them"}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void finish("confirm-pair")}>
            {pairing.me ? "Yes, it's me" : "Allow them"}
          </Button>
        </div>
      </>
    );
  } else if (status.state === "waiting") {
    body = (
      <>
        <p>
          {pairing.me ? "Send this code to the agent on " : `Ask ${who} to send this code to the agent on `}
          {channel}
          {pairing.me ? " from your own account" : ""}: <code data-pairing-code="">{code}</code> — valid until{" "}
          {when(pairing.expiresAt, undefined)}, once.
        </p>
        <PairingLinkBox pairing={pairing} channelLabel={channel} />
        {/* Only what changes is announced: the check's time is shown beside it, outside the live region. */}
        <p className="settings-description" role="status">
          {checkedAt === undefined ? "Checking for the code…" : "No message with the code yet."}
        </p>
        <p className="settings-description">
          {checkedAt === undefined ? null : `Last checked ${checkedAt}.`}
          {linked
            ? ` Someone already allowed on ${channel} is already linked, so their message is not read as a code: pair a different account.`
            : null}
        </p>
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            Cancel
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void check()}>
            Check now
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p>The code {status.state === "expired" ? "expired before anyone sent it" : "is no longer waiting"}. Pair again for a new one.</p>
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            Close
          </Button>
          <Button variant="primary" disabled={busy} onClick={onRetry}>
            Get a new code
          </Button>
        </div>
      </>
    );
  }
  return (
    <section className="settings-panel" aria-label="Pairing" ref={panel}>
      <h2 className="settings-section-title">
        {pairing.me ? `Pair yourself${pairing.name === undefined ? "" : ` (${pairing.name})`}` : `Pair ${who}`}
      </h2>
      {body}
      <Failure message={failure} />
    </section>
  );
}
/** What allowing a person asks besides their sender. */
interface PersonInput {
  readonly principal: string;
  readonly name: string;
  readonly trustUnverified: boolean;
  readonly me?: boolean;
}
export const NO_PERSON: PersonInput = { principal: "", name: "", trustUnverified: false };
/** A person's part of an `allow` or a `pair`: trust in unverified messages only where the channel checks them one by one. */
export function personPayload(
  person: PersonInput,
  descriptor: ChannelDescriptor | undefined,
): { principalId: string; name?: string; trustUnverified?: true } {
  const perMessage = descriptor?.sender.authentication === "per-message";
  return {
    principalId: person.principal.trim(),
    ...(person.name.trim() === "" ? {} : { name: person.name.trim() }),
    ...(perMessage && person.trustUnverified ? { trustUnverified: true } : {}),
  };
}
/** The person fields of Allowed people, also asked when a test's target is allowed from the Test dialog. */
export function PersonFields({
  descriptor,
  value,
  onChange,
  operator,
}: {
  descriptor: ChannelDescriptor | undefined;
  value: PersonInput;
  onChange: (value: PersonInput) => void;
  operator?: string | undefined;
}) {
  // Your own sender is you, under this workspace's principal: its chats are yours in Tavi and its approvals are decided where it asks.
  const me = operator !== undefined && value.me === true;
  return (
    <>
      {operator === undefined ? null : (
        <label>
          <input
            type="checkbox"
            aria-label="This is me"
            checked={me}
            onChange={(event) => onChange({ ...value, me: event.target.checked, principal: event.target.checked ? operator : "" })}
          />{" "}
          This is me
          <span className="settings-description">
            Your own account on this channel: its chats join yours in Tavi, and you approve its actions right in the chat.
          </span>
        </label>
      )}
      {me ? null : (
        <label>
          Person ID
          <input
            aria-label="Person ID"
            required
            maxLength={128}
            value={value.principal}
            placeholder="e.g. sam"
            onChange={(event) => onChange({ ...value, principal: event.target.value })}
          />
          <span className="settings-description">
            Someone else gets an ID of their own: they use this workspace's tools and models and keep their own memory, and only you decide
            their approvals.
          </span>
        </label>
      )}
      <label>
        Display name (optional)
        <input
          aria-label="Display name"
          maxLength={MESSAGING_DISPLAY_NAME_MAX}
          value={value.name}
          placeholder="e.g. Sam"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
        {/* Said under the field, as the fields above say theirs: a phone's field cut this short as a placeholder. */}
        <span className="settings-description">Shown in Center; the person ID otherwise.</span>
      </label>
      {descriptor?.sender.authentication === "per-message" ? (
        <label>
          <input
            type="checkbox"
            aria-label="Trust this person's unverified messages"
            checked={value.trustUnverified}
            onChange={(event) => onChange({ ...value, trustUnverified: event.target.checked })}
          />{" "}
          Trust this person's unverified messages
          <span className="settings-description">
            Only for a sender whose messages fail the channel's authenticity checks (for email, SPF/DKIM). Anyone can then send a message
            that claims to be from this sender and start a conversation as this person. An unverified message never decides an approval.
          </span>
        </label>
      ) : null}
    </>
  );
}
export function People({ data, reload }: { data: Loaded; reload: () => void }) {
  return (
    <>
      <Notice>
        Only explicitly allowed identities can start conversations. Give the same person the same person ID across channels to share their
        identity and private memory. Different people need different IDs. This does not grant settings access.
      </Notice>
      <PeopleEditor data={data} reload={reload} />
    </>
  );
}
/** Allowing, pairing and revoking people: across the workspace's connections, or on `only` one (its row's People on Channels). */
export function PeopleEditor({
  data,
  reload,
  only,
  onAllowed,
}: {
  data: Loaded;
  reload: () => void;
  only?: ChannelConnectionView;
  /** A dialog's way out: called with the note once a person is allowed or paired, so it can close and leave the note on its page. */
  onAllowed?: (note: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const connections = data.list.connections;
  const [picked, setConnectionId] = useState(connections[0]?.connectionId ?? "");
  const connectionId = only?.connectionId ?? picked;
  const shown = only === undefined ? data.people : data.people.filter((person) => person.connectionId === only.connectionId);
  const [sender, setSender] = useState("");
  const [person, setPerson] = useState(NO_PERSON);
  const [remove, setRemove] = useState<Loaded["people"][number]>();
  // Each action ends in its note and a fresh list.
  const { busy, note, tone, run, say } = useAction(reload);
  const connection = connections.find((candidate) => candidate.connectionId === connectionId);
  const descriptor =
    connection === undefined ? undefined : data.catalog.find((candidate) => candidate.providerId === connection.providerId);
  const connectionLabel = (id: string): string => {
    const found = connections.find((candidate) => candidate.connectionId === id);
    if (found === undefined) return id;
    // A connection named after its channel (Parrot on Parrot) says it once.
    const channel = labelOf(data.catalog, found.providerId);
    return found.label === channel ? channel : `${found.label} · ${channel}`;
  };
  const [pairing, setPairing] = useState<
    ChannelsPairAnswer & { readonly connectionId: string; readonly principalId: string; readonly name?: string; readonly me: boolean }
  >();
  const [pairingBusy, setPairingBusy] = useState(false);
  /** The channel a code was refused for because it isn't running. */
  const [notRunning, setNotRunning] = useState<string>();
  const pair = async (): Promise<void> => {
    if (connection === undefined || pairingBusy) return;
    setPairingBusy(true);
    const answer = await request<ChannelsPairAnswer>(client, {
      action: "pair",
      workspaceId,
      connectionId: connection.connectionId,
      ...personPayload(person, descriptor),
    });
    setPairingBusy(false);
    if (!answer.ok) {
      const stopped = notRunningChannel(answer);
      setNotRunning(stopped);
      say(stopped === undefined ? answer.message : undefined);
      return;
    }
    setNotRunning(undefined);
    say(undefined);
    const name = person.name.trim();
    setPairing({
      ...answer.value,
      connectionId: connection.connectionId,
      principalId: person.principal.trim(),
      ...(name === "" ? {} : { name }),
      me: data.operator !== undefined && person.me === true,
    });
  };
  const allow = async () => {
    if (busy !== undefined || connection === undefined) return;
    await run("allow", async () => {
      const answer = await request(client, {
        action: "allow",
        workspaceId,
        connectionId: connection.connectionId,
        sender: sender.trim(),
        ...personPayload(person, descriptor),
      });
      if (!answer.ok) return answer;
      setSender("");
      setPerson(NO_PERSON);
      const allowed = "Person allowed: their messages on this channel now reach Tavi.";
      onAllowed?.(allowed);
      return { ok: true, value: allowed };
    });
  };
  return (
    <>
      {/* Who is allowed comes first; the form to allow someone else follows it. */}
      {/* On Allowed people the page's own note, boxed and held in view; in a channel's People dialog a plain line. */}
      {only === undefined ? (
        <PageNote tone={tone} note={note || undefined} />
      ) : (
        <ActionNote tone={tone} note={note || undefined} className="" />
      )}
      {!shown.length ? (
        <Empty>
          {only === undefined
            ? "No people are allowed in this workspace yet."
            : `No one is allowed on ${only.label} yet: it answers no one until you allow a person.`}
        </Empty>
      ) : (
        <ul className="rows">
          {shown.map((person) => (
            <li className="row" key={`${person.connectionId}:${person.externalSenderId}`}>
              <div>
                <strong>{person.displayName ?? person.principalId}</strong>
                {person.principalId === data.operator ? (
                  <>
                    {" "}
                    <span className="badge">you</span>
                  </>
                ) : null}
                <p className="settings-description">
                  {person.externalSenderId} · {connectionLabel(person.connectionId)}
                  {person.trustUnverified === undefined ? "" : ` · trusts unverified messages (set by ${person.trustUnverified.setBy})`}
                </p>
              </div>
              <div className="actions">
                {person.trustUnverified === undefined ? null : (
                  <RowAction
                    onClick={() =>
                      void run("untrust", async () => {
                        const answer = await request(client, {
                          action: "allow",
                          workspaceId,
                          connectionId: person.connectionId,
                          sender: person.externalSenderId,
                          principalId: person.principalId,
                          trustUnverified: false,
                        });
                        return mapOutcome(answer, () => "Their unverified messages are held again.");
                      })
                    }
                  >
                    Stop trusting unverified
                  </RowAction>
                )}
                <RowAction tone="danger" onClick={() => setRemove(person)}>
                  Revoke access
                </RowAction>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!connections.length ? (
        <Empty>Connect a channel in Channels before allowing people on it.</Empty>
      ) : (
        <form
          className="settings-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void allow();
          }}
        >
          <h2 className="settings-section-title">Allow a person</h2>
          <BusyFieldset busy={busy !== undefined} className="settings-fields">
            {only !== undefined ? null : (
              <label>
                Connection
                <Select
                  aria-label="Person connection"
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value);
                    setSender("");
                    setPerson({ ...person, trustUnverified: false });
                  }}
                >
                  {connections.map((candidate) => (
                    <option key={candidate.connectionId} value={candidate.connectionId}>
                      {connectionLabel(candidate.connectionId)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label>
              {descriptor?.sender.label ?? "Sender"}
              <input
                aria-label={descriptor?.sender.label ?? "Sender"}
                required
                maxLength={320}
                value={sender}
                onChange={(event) => setSender(event.target.value)}
                placeholder={descriptor?.sender.placeholder}
              />
            </label>
            <PersonFields descriptor={descriptor} value={person} onChange={setPerson} operator={data.operator} />
            <div className="actions">
              <Button
                variant="ghost"
                disabled={person.principal.trim() === "" || pairing !== undefined || pairingBusy}
                onClick={() => void pair()}
              >
                Pair with a code
              </Button>
              <Button variant="primary" type="submit">
                {busy === "allow" ? "Saving…" : "Allow person"}
              </Button>
            </div>
            {notRunning === undefined ? null : (
              <Failure>
                <ChannelNotRunning label={notRunning} />
              </Failure>
            )}
            <span className="settings-description">
              Don't know what to enter as {descriptor?.sender.label ?? "Sender"}? Pair with a code: they send it to the agent on this
              channel, and you confirm it was them.
              {/* The button waits on whom the code is for (Mac mini tests): say so rather than leave it grey. */}
              {person.principal.trim() === "" ? " Tick This is me, or fill in Person ID, to get a code." : null}
            </span>
          </BusyFieldset>
        </form>
      )}
      {pairing === undefined || connection === undefined ? null : (
        <PairingPanel
          key={pairing.pairingId}
          pairing={pairing}
          channel={connectionLabel(pairing.connectionId)}
          linked={data.people.some((allowed) => allowed.connectionId === pairing.connectionId)}
          onRetry={() => void pair()}
          onDone={(done) => {
            setPairing(undefined);
            if (done !== undefined) {
              setSender("");
              setPerson(NO_PERSON);
            }
            say(done);
            reload();
            if (done !== undefined) onAllowed?.(done);
          }}
        />
      )}
      {remove ? (
        <Confirm
          title="Revoke access?"
          message={`Block new incoming messages from ${remove.displayName ?? remove.principalId} (${remove.externalSenderId}) on ${connectionLabel(remove.connectionId)}. Turns already running are not cancelled.`}
          action="Revoke access"
          onClose={() => setRemove(undefined)}
          onConfirm={() =>
            run("revoke", async () => {
              const answer = await request(client, {
                action: "revoke",
                workspaceId,
                connectionId: remove.connectionId,
                sender: remove.externalSenderId,
              });
              if (!answer.ok) return answer;
              setRemove(undefined);
              return { ok: true, value: "Access revoked for new incoming messages." };
            })
          }
        />
      ) : null}
    </>
  );
}
