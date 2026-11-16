import {
  SCHEDULE_EMAIL_MAX_TEXT_BYTES,
  SCHEDULE_WEBHOOK_MAX_PER_HOUR,
  scheduleWebhookPath,
  type ScheduleWebhookAnswer,
  type ScheduleWebhookMode,
  type ScheduleShowResult,
} from "@tavi/contracts";
import { useEffect, useRef, useState } from "react";

import { say } from "../../hooks/use-announce.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { copyText } from "../../lib/clipboard.js";
import { dayTime, todayIn } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Confirm.js";
import { Select } from "../../ui/Select.js";
import { Failure, LoadError, Pending, Summary } from "../../ui/Parts.js";
import { useWorkspace } from "../shell/Workspace.js";
import { emailTriggerConnections, setScheduleEmailTrigger, setScheduleWebhook } from "./schedules-api.js";
import { Command } from "../../ui/Command.js";

/**
 * The schedule's webhook: off by default; on, a call with its secret fires it now. A new secret is shown here once,
 * from the answer that made it, and is gone once dismissed or the page is left: the owner keeps only its hash, and its
 * signing key only encrypted.
 */
export function Webhook({
  schedule,
  zone,
  changed,
}: {
  readonly schedule: ScheduleShowResult;
  readonly zone: string | undefined;
  readonly changed: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [made, setMade] = useState<ScheduleWebhookAnswer>();
  const [confirming, setConfirming] = useState<Exclude<ScheduleWebhookMode, "on">>();
  const intro = useRef<HTMLParagraphElement>(null);
  const newSecret = useRef<HTMLButtonElement>(null);
  const shown = made?.secret !== undefined;
  // A new secret is not read out as it appears: focus goes to the words above it, and the person moves on to copy it.
  useEffect(() => {
    if (shown) requestAnimationFrame(() => intro.current?.focus());
  }, [shown, made]);
  const done = (): void => {
    setMade(undefined);
    requestAnimationFrame(() => newSecret.current?.focus());
  };
  const turn = async (mode: ScheduleWebhookMode): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const answer = await setScheduleWebhook(client, workspaceId, schedule.scheduleId, mode);
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    setMade(answer.value.secret === undefined ? undefined : answer.value);
    changed();
  };
  const on = schedule.webhook !== undefined;
  return (
    <div className="schedule-webhook">
      <p>
        {on ? (
          <>
            On since {dayTime(schedule.webhook.since, zone, todayIn(zone))}: a <code>POST</code> to{" "}
            <code>{schedule.webhookUrl ?? made?.url ?? `<public address>${scheduleWebhookPath(schedule.scheduleId)}`}</code> with its secret
            runs it now, at most once a minute and {SCHEDULE_WEBHOOK_MAX_PER_HOUR} times an hour. What the call carries reaches the run as
            quoted data, never as instructions, and the run starts as one that read untrusted content.
          </>
        ) : (
          "Off: nothing outside can start it. Turned on, a call with its secret to the webhook listener runs it now."
        )}
      </p>
      {made?.secret === undefined ? null : (
        <div className="schedule-webhook-secret" role="group" aria-label="New webhook secret">
          <p ref={intro} tabIndex={-1}>
            New secret below. Copy it now: it is shown once. The secret is stored only as its hash, the signing key only encrypted.
          </p>
          <Summary
            items={[
              ["Secret", <SecretField key="secret" label="Webhook secret" value={made.secret} />],
              ["Send it as", <code key="bearer">Authorization: Bearer &lt;secret&gt;</code>],
              made.signingKey !== undefined && [
                "Or sign with",
                <SecretField key="signing" label="Webhook signing key" value={made.signingKey} />,
              ],
              [
                "Signed calls",
                made.signingKey === undefined ? (
                  <>
                    Need an encrypted credential store (<Command>tavi credentials encrypt</Command>), then a new secret.
                  </>
                ) : (
                  <>
                    <code>X-Tavi-Timestamp</code> (Unix seconds) and{" "}
                    <code>X-Tavi-Signature: sha256=&lt;HMAC-SHA256 of "timestamp.body"&gt;</code>
                  </>
                ),
              ],
            ]}
          />
          <Button onClick={done}>Done</Button>
        </div>
      )}
      <Failure message={failure} />
      <div className="actions">
        {on ? (
          <>
            <Button ref={newSecret} disabled={busy} onClick={() => setConfirming("rotate")}>
              New secret
            </Button>
            <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirming("off")}>
              Turn off
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={() => void turn("on")} aria-label="Turn on webhook">
            Turn on
          </Button>
        )}
      </div>
      {confirming === undefined ? null : (
        <Confirm
          title={confirming === "off" ? "Turn the webhook off?" : "Make a new secret?"}
          message={
            confirming === "off"
              ? "Calls to its address will be refused, as if it never had one."
              : "Calls with the current secret or signing key will be refused from now on."
          }
          action={confirming === "off" ? "Turn off" : "New secret"}
          onConfirm={() => turn(confirming)}
          onClose={() => setConfirming(undefined)}
        />
      )}
    </div>
  );
}

/**
 * A secret shown once: in a read-only field, selected as it gets focus, with Copy beside it. When the browser will not
 * copy, the field is selected for copying by hand, and either outcome is said.
 */
function SecretField({ label, value }: { readonly label: string; readonly value: string }) {
  const field = useRef<HTMLInputElement>(null);
  const copy = (): void =>
    void copyText(value).then((copied) => {
      if (copied) return say(`${label} copied.`);
      field.current?.focus();
      field.current?.select();
      say(`Could not copy: the ${label.toLowerCase()} is selected, copy it by hand.`);
    });
  return (
    <span className="schedule-secret-field">
      <input ref={field} aria-label={label} readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
      <Button size="sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>
        Copy
      </Button>
    </span>
  );
}

/**
 * The schedule's email trigger: off by default; on, an email on an email connection from a listed sender the channel
 * authenticated runs it now, read-only. Turning it on names the connection and the senders; the page says plainly
 * what an email can and cannot make the run do.
 */
export function EmailTrigger({
  schedule,
  zone,
  changed,
}: {
  readonly schedule: ScheduleShowResult;
  readonly zone: string | undefined;
  readonly changed: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const trigger = schedule.emailTrigger;
  // Read only once a person sets one up: a page that is only looked at asks for no connections.
  const [settingUp, setSettingUp] = useState(false);
  const connections = useLoaded(
    () =>
      trigger === undefined && settingUp ? emailTriggerConnections(client, workspaceId) : Promise.resolve({ ok: true as const, value: [] }),
    [client, workspaceId, trigger === undefined && settingUp],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [picked, setPicked] = useState("");
  const [senders, setSenders] = useState("");
  const [subject, setSubject] = useState("");
  const offered = connections.data ?? [];
  const connectionId = picked !== "" ? picked : offered.length === 1 ? (offered[0]?.connectionId ?? "") : "";
  const listed = senders
    .split(",")
    .map((sender) => sender.trim())
    .filter((sender) => sender !== "");
  const turn = async (setting: Parameters<typeof setScheduleEmailTrigger>[3]): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const answer = await setScheduleEmailTrigger(client, workspaceId, schedule.scheduleId, setting);
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    changed();
  };
  const warning =
    "Email is where injected instructions come from most. List only senders you trust: a run an email starts may only read — no tool that changes or sends anything runs, whatever its tool list allows, besides delivering its result as this schedule is set to — and the email reaches it as quoted data, never as instructions.";
  if (trigger !== undefined)
    return (
      <div className="schedule-email-trigger">
        <p>
          On since {dayTime(trigger.since, zone, todayIn(zone))}: an email on <code>{trigger.connectionId}</code> from{" "}
          {trigger.senders.map((sender, index) => (
            <span key={sender}>
              {index === 0 ? "" : ", "}
              <code>{sender}</code>
            </span>
          ))}
          {trigger.subject === undefined ? null : <> with “{trigger.subject}” in its subject</>}, whose domain the channel verified, runs it
          now, at most once a minute and {SCHEDULE_WEBHOOK_MAX_PER_HOUR} times an hour. Such an email is this trigger's, never also a chat
          message.
        </p>
        <p className="muted">{warning}</p>
        <Failure message={failure} />
        <div className="actions">
          <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirming(true)}>
            Turn off
          </Button>
        </div>
        {confirming ? (
          <Confirm
            title="Turn the email trigger off?"
            message="Email from its senders will be handled as any other message again."
            action="Turn off"
            onConfirm={() => turn("off")}
            onClose={() => setConfirming(false)}
          />
        ) : null}
      </div>
    );
  return (
    <div className="schedule-email-trigger">
      <p>Off: no email starts it. Turned on, an email from a sender you list runs it now, read-only.</p>
      {!settingUp ? (
        <div className="actions">
          <Button onClick={() => setSettingUp(true)}>Set up</Button>
        </div>
      ) : (
        <>
          <p className="muted">{warning}</p>
          {connections.loading ? (
            <Pending label="Loading the email connections…" className="notice" status />
          ) : connections.error !== undefined ? (
            <LoadError error={connections.error} reload={connections.reload} />
          ) : offered.length === 0 ? (
            <p className="muted">No email connection that checks its senders is set up in this workspace.</p>
          ) : (
            <>
              <label>
                Email connection
                <Select aria-label="Email connection" value={connectionId} onChange={(event) => setPicked(event.target.value)}>
                  <option value="">Choose a connection</option>
                  {offered.map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.label} ({connection.accountIdentity || connection.connectionId})
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                From
                <input
                  aria-label="From"
                  placeholder="ann@example.com, @example.org"
                  value={senders}
                  onChange={(event) => setSenders(event.target.value)}
                />
              </label>
              <label>
                Subject holds (optional)
                <input aria-label="Subject holds (optional)" value={subject} onChange={(event) => setSubject(event.target.value)} />
              </label>
              <p className="muted">
                Its subject and text, at most {SCHEDULE_EMAIL_MAX_TEXT_BYTES / 1024} KiB, reach the run as quoted, untrusted data.
              </p>
              <Failure message={failure} />
              <div className="actions">
                <Button
                  aria-label="Turn on email trigger"
                  disabled={busy || connectionId === "" || listed.length === 0}
                  onClick={() =>
                    void turn({ connectionId, senders: listed, ...(subject.trim() === "" ? {} : { subject: subject.trim() }) })
                  }
                >
                  Turn on
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
