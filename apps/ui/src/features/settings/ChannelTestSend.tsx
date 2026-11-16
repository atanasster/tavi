import { useCallback, useEffect, useState } from "react";

import {
  channelIdentity,
  type ChannelConnectionView,
  type ChannelDescriptor,
  type ChannelsPeopleAnswer,
  type ChannelsTestAnswer,
} from "@tavi/contracts";

import { Modal } from "../../ui/Modal.js";
import { BusyFieldset, Failure, Pending, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { NO_PERSON, personPayload, PersonFields } from "./ChannelPeople.js";
import { request } from "./channels-api.js";
import { readStoredJson, writeStoredJson } from "../../lib/storage.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** The test recipient last used on a connection, kept in this browser only (a convenience; a missing one just starts blank). */
interface LastRecipient {
  readonly to: string;
  readonly direct: boolean;
}
const lastRecipientKey = (workspaceId: string, connectionId: string): string => `tavi.channels.test.${workspaceId}.${connectionId}`;
function readLastRecipient(workspaceId: string, connectionId: string): LastRecipient | undefined {
  const parsed = readStoredJson(lastRecipientKey(workspaceId, connectionId));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { to, direct } = parsed as { to?: unknown; direct?: unknown };
  return typeof to === "string" && to !== "" ? { to, direct: direct === true } : undefined;
}
const writeLastRecipient = (workspaceId: string, connectionId: string, recipient: LastRecipient): void =>
  writeStoredJson(lastRecipientKey(workspaceId, connectionId), recipient);
/** The "Send to" choice that means a target typed in, not one of the people allowed. */
const OTHER_RECIPIENT = "";
/**
 * A test send: to a person allowed on the connection, reached one-to-one
 * the way its channel reaches a sender, or to a target typed in. The last one
 * is offered again; a target that is also a sender id can be allowed from here.
 */
export function TestSend({
  connection,
  descriptor,
  onClose,
}: {
  connection: ChannelConnectionView;
  descriptor: ChannelDescriptor | undefined;
  onClose: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [people, setPeople] = useState<ChannelsPeopleAnswer["people"]>();
  const [operator, setOperator] = useState<string>();
  const [last] = useState(() => readLastRecipient(workspaceId, connection.connectionId));
  const [person, setPerson] = useState(OTHER_RECIPIENT);
  const [to, setTo] = useState(last?.direct === false ? last.to : "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const loadPeople = useCallback(async (): Promise<ChannelsPeopleAnswer["people"]> => {
    const answer = await request<ChannelsPeopleAnswer>(client, { action: "people", workspaceId });
    setPeopleLoaded(true);
    // Unknown people are not "nobody": no picker, and no offer to allow someone who may be allowed already.
    if (!answer.ok) {
      setFailure(answer.message);
      return [];
    }
    const own = answer.value.people.filter((candidate) => candidate.connectionId === connection.connectionId);
    setPeople(own);
    setOperator(answer.value.operator);
    return own;
  }, [client, workspaceId, connection.connectionId]);
  useEffect(() => {
    void loadPeople().then((own) => {
      // The last person tested is chosen again; with none, the first allowed — unless a target was typed last.
      if (last?.direct === false) return;
      const again = own.find((candidate) => candidate.externalSenderId === last?.to) ?? own[0];
      if (again !== undefined) setPerson(again.externalSenderId);
    });
  }, [loadPeople, last]);
  const direct = person !== OTHER_RECIPIENT;
  const send = async (): Promise<void> => {
    if (sending) return;
    const recipient = direct ? person : to.trim();
    setSending(true);
    setFailure(undefined);
    setResult(undefined);
    setSent(undefined);
    const answer = await request<ChannelsTestAnswer>(client, {
      action: "test",
      workspaceId,
      connectionId: connection.connectionId,
      to: recipient,
      ...(direct ? { direct: true } : {}),
    });
    setSending(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    writeLastRecipient(workspaceId, connection.connectionId, { to: recipient, direct });
    if (answer.value.status === "accepted") {
      setResult(`Sent through ${connection.label}.`);
      if (!direct) setSent(recipient);
    } else setFailure(`The test was ${answer.value.status}${answer.value.detail === undefined ? "." : `: ${answer.value.detail}`}`);
  };
  // A target that is also a sender id, and not allowed yet, can be allowed as a person from here.
  const allowable = sent === undefined || descriptor === undefined ? undefined : channelIdentity(sent, descriptor.sender);
  const offerAllow =
    allowable !== undefined && people !== undefined && !people.some((candidate) => candidate.externalSenderId === allowable);
  const targetLabel = descriptor?.target.label ?? "Send to";
  // The form is drawn once the people are known, so the recipient never changes under the operator.
  if (!peopleLoaded)
    return (
      <Modal title={`Test ${connection.label}`} busy={false} onClose={onClose}>
        <Pending label={`Loading the people allowed on ${connection.label}…`} className="notice settings-description" status />
      </Modal>
    );
  return (
    <Modal title={`Test ${connection.label}`} busy={sending} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <BusyFieldset busy={sending} label="Sending…" className="settings-fields">
          {people !== undefined && people.length > 0 ? (
            <label>
              Send to
              <Select aria-label="Test person" value={person} onChange={(event) => setPerson(event.target.value)}>
                {people.map((candidate) => (
                  <option key={candidate.externalSenderId} value={candidate.externalSenderId}>
                    {candidate.displayName ?? candidate.principalId} · {candidate.externalSenderId}
                  </option>
                ))}
                <option value={OTHER_RECIPIENT}>Another {targetLabel.toLowerCase()}…</option>
              </Select>
            </label>
          ) : null}
          {direct ? null : (
            <label>
              {targetLabel}
              <input
                aria-label="Test recipient"
                required
                maxLength={320}
                value={to}
                placeholder={descriptor?.target.placeholder}
                onChange={(event) => setTo(event.target.value)}
              />
              {descriptor?.target.help === undefined ? null : <span className="settings-description">{descriptor.target.help}</span>}
            </label>
          )}
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" type="submit">
              {sending ? "Sending…" : "Send test message"}
            </Button>
          </div>
        </BusyFieldset>
      </form>
      <StatusNote note={result} />
      <Failure message={failure} />
      {offerAllow && descriptor !== undefined ? (
        <AllowFromTest
          connectionId={connection.connectionId}
          sender={allowable}
          descriptor={descriptor}
          operator={operator}
          onAllowed={(note) => {
            setSent(undefined);
            setResult(note);
            void loadPeople();
          }}
        />
      ) : null}
    </Modal>
  );
}
/** Allowing the sender a test just reached, as Allowed people does, so they can chat with the agent too. */
function AllowFromTest({
  connectionId,
  sender,
  descriptor,
  operator,
  onAllowed,
}: {
  connectionId: string;
  sender: string;
  descriptor: ChannelDescriptor;
  operator: string | undefined;
  onAllowed: (note: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [person, setPerson] = useState(NO_PERSON);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const allow = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const answer = await request(client, { action: "allow", workspaceId, connectionId, sender, ...personPayload(person, descriptor) });
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    onAllowed(`${person.principal.trim()} is allowed: new messages from ${descriptor.sender.label} ${sender} can start a conversation.`);
  };
  return (
    <form
      className="settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void allow();
      }}
    >
      <BusyFieldset busy={busy} className="settings-fields">
        <p className="settings-description">
          {sender} is a {descriptor.sender.label} too. Allow this person to chat with the agent through this connection?
        </p>
        <PersonFields descriptor={descriptor} value={person} onChange={setPerson} operator={operator} />
        <div className="actions">
          <Button variant="primary" type="submit">
            {busy ? "Saving…" : "Allow person"}
          </Button>
        </div>
        <Failure message={failure} />
      </BusyFieldset>
    </form>
  );
}
