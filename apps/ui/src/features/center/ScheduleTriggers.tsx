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
import { useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";
import type { UiKey } from "../../locales/en.js";

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
  const t = useT();
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
        {on
          ? withParts(
              t("center.triggers.webhookOn", {
                since: dayTime(schedule.webhook.since, zone, todayIn(zone)),
                count: SCHEDULE_WEBHOOK_MAX_PER_HOUR,
              }),
              {
                post: <code>POST</code>,
                url: (
                  <code>
                    {schedule.webhookUrl ??
                      made?.url ??
                      t("center.triggers.webhookAddress", { path: scheduleWebhookPath(schedule.scheduleId) })}
                  </code>
                ),
              },
            )
          : t("center.triggers.webhookOff")}
      </p>
      {made?.secret === undefined ? null : (
        <div className="schedule-webhook-secret" role="group" aria-label={t("center.triggers.newSecretLabel")}>
          <p ref={intro} tabIndex={-1}>
            {t("center.triggers.newSecretIntro")}
          </p>
          <Summary
            items={[
              [t("center.triggers.secret"), <SecretField key="secret" kind="secret" value={made.secret} />],
              [t("center.triggers.sendAs"), <code key="bearer">Authorization: Bearer &lt;secret&gt;</code>],
              made.signingKey !== undefined && [
                t("center.triggers.orSign"),
                <SecretField key="signing" kind="signing" value={made.signingKey} />,
              ],
              [
                t("center.triggers.signedCalls"),
                made.signingKey === undefined
                  ? withParts(t("center.triggers.needEncrypted"), { command: <Command>tavi credentials encrypt</Command> })
                  : withParts(t("center.triggers.signedHeaders"), {
                      timestamp: <code>X-Tavi-Timestamp</code>,
                      signature: <code>X-Tavi-Signature: sha256=&lt;HMAC-SHA256 of "timestamp.body"&gt;</code>,
                    }),
              ],
            ]}
          />
          <Button onClick={done}>{t("center.triggers.done")}</Button>
        </div>
      )}
      <Failure message={failure} />
      <div className="actions">
        {on ? (
          <>
            <Button ref={newSecret} disabled={busy} onClick={() => setConfirming("rotate")}>
              {t("center.triggers.newSecret")}
            </Button>
            <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirming("off")}>
              {t("center.triggers.turnOff")}
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={() => void turn("on")} aria-label={t("center.triggers.turnOnWebhook")}>
            {t("center.triggers.turnOn")}
          </Button>
        )}
      </div>
      {confirming === undefined ? null : (
        <Confirm
          title={confirming === "off" ? t("center.triggers.confirmOffTitle") : t("center.triggers.confirmRotateTitle")}
          message={confirming === "off" ? t("center.triggers.confirmOffMessage") : t("center.triggers.confirmRotateMessage")}
          action={confirming === "off" ? t("center.triggers.turnOff") : t("center.triggers.newSecret")}
          onConfirm={() => turn(confirming)}
          onClose={() => setConfirming(undefined)}
        />
      )}
    </div>
  );
}

/** Each secret's words: its field's name, its Copy button's, and what copying it says. */
const SECRET_WORDS = {
  secret: {
    label: "center.triggers.secretField.secret.label",
    copy: "center.triggers.secretField.secret.copy",
    copied: "center.triggers.secretField.secret.copied",
    notCopied: "center.triggers.secretField.secret.notCopied",
  },
  signing: {
    label: "center.triggers.secretField.signing.label",
    copy: "center.triggers.secretField.signing.copy",
    copied: "center.triggers.secretField.signing.copied",
    notCopied: "center.triggers.secretField.signing.notCopied",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<"label" | "copy" | "copied" | "notCopied", UiKey>>>>;

/**
 * A secret shown once: in a read-only field, selected as it gets focus, with Copy beside it. When the browser will not
 * copy, the field is selected for copying by hand, and either outcome is said.
 */
function SecretField({ kind, value }: { readonly kind: keyof typeof SECRET_WORDS; readonly value: string }) {
  const t = useT();
  const words = SECRET_WORDS[kind];
  const field = useRef<HTMLInputElement>(null);
  const copy = (): void =>
    void copyText(value).then((copied) => {
      if (copied) return say(t(words.copied));
      field.current?.focus();
      field.current?.select();
      say(t(words.notCopied));
    });
  return (
    <span className="schedule-secret-field">
      <input ref={field} aria-label={t(words.label)} readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
      <Button size="sm" variant="ghost" aria-label={t(words.copy)} onClick={copy}>
        {t("center.triggers.copy")}
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
  const t = useT();
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
  const warning = t("center.triggers.emailWarning");
  if (trigger !== undefined)
    return (
      <div className="schedule-email-trigger">
        <p>
          {withParts(
            t(trigger.subject === undefined ? "center.triggers.emailOn" : "center.triggers.emailOnSubject", {
              since: dayTime(trigger.since, zone, todayIn(zone)),
              count: SCHEDULE_WEBHOOK_MAX_PER_HOUR,
            }),
            {
              subject: trigger.subject,
              connection: <code>{trigger.connectionId}</code>,
              senders: trigger.senders.map((sender, index) => (
                <span key={sender}>
                  {index === 0 ? "" : ", "}
                  <code>{sender}</code>
                </span>
              )),
            },
          )}
        </p>
        <p className="muted">{warning}</p>
        <Failure message={failure} />
        <div className="actions">
          <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirming(true)}>
            {t("center.triggers.turnOff")}
          </Button>
        </div>
        {confirming ? (
          <Confirm
            title={t("center.triggers.confirmEmailOffTitle")}
            message={t("center.triggers.confirmEmailOffMessage")}
            action={t("center.triggers.turnOff")}
            onConfirm={() => turn("off")}
            onClose={() => setConfirming(false)}
          />
        ) : null}
      </div>
    );
  return (
    <div className="schedule-email-trigger">
      <p>{t("center.triggers.emailOff")}</p>
      {!settingUp ? (
        <div className="actions">
          <Button onClick={() => setSettingUp(true)}>{t("center.triggers.setUp")}</Button>
        </div>
      ) : (
        <>
          <p className="muted">{warning}</p>
          {connections.loading ? (
            <Pending label={t("center.triggers.loadingConnections")} className="notice" status />
          ) : connections.error !== undefined ? (
            <LoadError error={connections.error} reload={connections.reload} />
          ) : offered.length === 0 ? (
            <p className="muted">{t("center.triggers.noConnections")}</p>
          ) : (
            <>
              <label>
                {t("center.triggers.emailConnection")}
                <Select
                  aria-label={t("center.triggers.emailConnection")}
                  value={connectionId}
                  onChange={(event) => setPicked(event.target.value)}
                >
                  <option value="">{t("center.triggers.chooseConnection")}</option>
                  {offered.map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.label} ({connection.accountIdentity || connection.connectionId})
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {t("center.triggers.from")}
                <input
                  aria-label={t("center.triggers.from")}
                  placeholder="ann@example.com, @example.org"
                  value={senders}
                  onChange={(event) => setSenders(event.target.value)}
                />
              </label>
              <label>
                {t("center.triggers.subject")}
                <input aria-label={t("center.triggers.subject")} value={subject} onChange={(event) => setSubject(event.target.value)} />
              </label>
              <p className="muted">{t("center.triggers.emailSize", { size: String(SCHEDULE_EMAIL_MAX_TEXT_BYTES / 1024) })}</p>
              <Failure message={failure} />
              <div className="actions">
                <Button
                  aria-label={t("center.triggers.turnOnEmail")}
                  disabled={busy || connectionId === "" || listed.length === 0}
                  onClick={() =>
                    void turn({ connectionId, senders: listed, ...(subject.trim() === "" ? {} : { subject: subject.trim() }) })
                  }
                >
                  {t("center.triggers.turnOn")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
