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
import { translateNow, useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

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
  const t = useT();
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
    const allowed = pairing.me ? translateNow("settings.people.pairedMe") : translateNow("settings.people.paired", { who });
    onDone(action === "confirm-pair" ? allowed : undefined);
  };
  const code = shownPairingCode(pairing.code);
  let body: ReactNode;
  if (status.state === "claimed") {
    const sender = claimedSenderLabel(status);
    body = (
      <>
        <p ref={question} tabIndex={-1}>
          {withParts(t(pairing.me ? "settings.people.claimedMe" : "settings.people.claimed", { channel, who }), {
            sender: <strong>{sender}</strong>,
          })}
        </p>
        {/* Pairing yourself is asked as Welcome asks it (QA 1832). */}
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            {pairing.me ? t("settings.people.notMe") : t("settings.people.notThem")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void finish("confirm-pair")}>
            {pairing.me ? t("settings.people.yesMe") : t("settings.people.allowThem")}
          </Button>
        </div>
      </>
    );
  } else if (status.state === "waiting") {
    body = (
      <>
        <p>
          {withParts(
            t(pairing.me ? "settings.people.sendCodeMe" : "settings.people.sendCode", {
              who,
              channel,
              until: when(pairing.expiresAt, undefined),
            }),
            { code: <code data-pairing-code="">{code}</code> },
          )}
        </p>
        <PairingLinkBox pairing={pairing} channelLabel={channel} />
        {/* Only what changes is announced: the check's time is shown beside it, outside the live region. */}
        <p className="settings-description" role="status">
          {checkedAt === undefined ? t("settings.people.checking") : t("settings.people.noCodeYet")}
        </p>
        <p className="settings-description">
          {checkedAt === undefined ? null : t("settings.people.lastChecked", { at: checkedAt })}
          {linked ? ` ${t("settings.people.linked", { channel })}` : null}
        </p>
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            {t("ui.confirm.cancel")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void check()}>
            {t("settings.people.checkNow")}
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p>{status.state === "expired" ? t("settings.people.codeExpired") : t("settings.people.codeGone")}</p>
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={() => void finish("cancel-pair")}>
            {t("settings.action.close")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onRetry}>
            {t("settings.people.newCode")}
          </Button>
        </div>
      </>
    );
  }
  return (
    <section className="settings-panel" aria-label={t("settings.people.pairing")} ref={panel}>
      <h2 className="settings-section-title">
        {pairing.me
          ? pairing.name === undefined
            ? t("settings.people.pairYourself")
            : t("settings.people.pairYourselfAs", { name: pairing.name })
          : t("settings.people.pairWho", { who })}
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
  const t = useT();
  // Your own sender is you, under this workspace's principal: its chats are yours in Tavi and its approvals are decided where it asks.
  const me = operator !== undefined && value.me === true;
  return (
    <>
      {operator === undefined ? null : (
        <label>
          <input
            type="checkbox"
            aria-label={t("settings.people.thisIsMe")}
            checked={me}
            onChange={(event) => onChange({ ...value, me: event.target.checked, principal: event.target.checked ? operator : "" })}
          />{" "}
          {t("settings.people.thisIsMe")}
          <span className="settings-description">{t("settings.people.thisIsMeHelp")}</span>
        </label>
      )}
      {me ? null : (
        <label>
          {t("settings.people.personId")}
          <input
            aria-label={t("settings.people.personId")}
            required
            maxLength={128}
            value={value.principal}
            placeholder={t("settings.people.personIdPlaceholder")}
            onChange={(event) => onChange({ ...value, principal: event.target.value })}
          />
          <span className="settings-description">{t("settings.people.personIdHelp")}</span>
        </label>
      )}
      <label>
        {t("settings.people.displayNameOptional")}
        <input
          aria-label={t("settings.people.displayName")}
          maxLength={MESSAGING_DISPLAY_NAME_MAX}
          value={value.name}
          placeholder={t("settings.people.displayNamePlaceholder")}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
        {/* Said under the field, as the fields above say theirs: a phone's field cut this short as a placeholder. */}
        <span className="settings-description">{t("settings.people.displayNameHelp")}</span>
      </label>
      {descriptor?.sender.authentication === "per-message" ? (
        <label>
          <input
            type="checkbox"
            aria-label={t("settings.people.trust")}
            checked={value.trustUnverified}
            onChange={(event) => onChange({ ...value, trustUnverified: event.target.checked })}
          />{" "}
          {t("settings.people.trust")}
          <span className="settings-description">{t("settings.people.trustHelp")}</span>
        </label>
      ) : null}
    </>
  );
}
export function People({ data, reload }: { data: Loaded; reload: () => void }) {
  const t = useT();
  return (
    <>
      <Notice>{t("settings.people.intro")}</Notice>
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
  const t = useT();
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
      const allowed = t("settings.people.allowed");
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
        <Empty>{only === undefined ? t("settings.people.empty") : t("settings.people.emptyOn", { label: only.label })}</Empty>
      ) : (
        <ul className="rows">
          {shown.map((person) => (
            <li className="row" key={`${person.connectionId}:${person.externalSenderId}`}>
              <div>
                <strong>{person.displayName ?? person.principalId}</strong>
                {person.principalId === data.operator ? (
                  <>
                    {" "}
                    <span className="badge">{t("settings.people.you")}</span>
                  </>
                ) : null}
                <p className="settings-description">
                  {person.externalSenderId} · {connectionLabel(person.connectionId)}
                  {person.trustUnverified === undefined ? "" : ` · ${t("settings.people.trusts", { setBy: person.trustUnverified.setBy })}`}
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
                        return mapOutcome(answer, () => t("settings.people.untrusted"));
                      })
                    }
                  >
                    {t("settings.people.stopTrusting")}
                  </RowAction>
                )}
                <RowAction tone="danger" onClick={() => setRemove(person)}>
                  {t("settings.people.revoke")}
                </RowAction>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!connections.length ? (
        <Empty>{t("settings.people.noConnections")}</Empty>
      ) : (
        <form
          className="settings-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void allow();
          }}
        >
          <h2 className="settings-section-title">{t("settings.people.allowTitle")}</h2>
          <BusyFieldset busy={busy !== undefined} className="settings-fields">
            {only !== undefined ? null : (
              <label>
                {t("settings.people.connection")}
                <Select
                  aria-label={t("settings.people.connectionLabel")}
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
              {descriptor?.sender.label ?? t("settings.people.sender")}
              <input
                aria-label={descriptor?.sender.label ?? t("settings.people.sender")}
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
                {t("settings.people.pairWithCode")}
              </Button>
              <Button variant="primary" type="submit">
                {busy === "allow" ? t("ui.parts.saving") : t("settings.testSend.allow")}
              </Button>
            </div>
            {notRunning === undefined ? null : (
              <Failure>
                <ChannelNotRunning label={notRunning} />
              </Failure>
            )}
            <span className="settings-description">
              {t("settings.people.pairHint", { sender: descriptor?.sender.label ?? t("settings.people.sender") })}
              {/* The button waits on whom the code is for (Mac mini tests): say so rather than leave it grey. */}
              {person.principal.trim() === "" ? ` ${t("settings.people.pairNeedsWho")}` : null}
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
          title={t("settings.people.revokeTitle")}
          message={t("settings.people.revokeMessage", {
            name: remove.displayName ?? remove.principalId,
            sender: remove.externalSenderId,
            connection: connectionLabel(remove.connectionId),
          })}
          action={t("settings.people.revoke")}
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
              return { ok: true, value: t("settings.people.revoked") };
            })
          }
        />
      ) : null}
    </>
  );
}
