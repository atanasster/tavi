import type {
  ChannelDescriptor,
  ChannelsPairAnswer,
  ChannelsPairingAnswer,
  ChannelsSaveAnswer,
  MessagingSetup,
  WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { usePoll } from "../../hooks/use-poll.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { ask, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { Notice, StatusNote, Failure } from "../../ui/Parts.js";
import { ChannelNotRunning, notRunningChannel } from "../settings/ChannelNotRunning.js";
import { PairingLinkBox, claimedSenderLabel, shownPairingCode } from "../../ui/QrCode.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";
import { withParts } from "./WelcomeStepParts.js";

/**
 * Adding a channel set up with keys, and pairing its operator: the pieces Welcome's channels step and Connected
 * apps' channel sheet share, every word about the channel from its descriptor and its check.
 */

/**
 * A load whose answer is kept only while it is the latest: a slower, older
 * one (another workspace's, say) never overwrites a newer one, nor lands
 * after the step has gone.
 */
export function useLatest<T>(read: () => Promise<T>): { readonly value: T | undefined; readonly reload: () => Promise<void> } {
  const [value, setValue] = useState<T>();
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    const answer = await read();
    if (mine === generation.current) setValue(answer);
  }, [read]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  return { value, reload };
}

export function channels<T>(client: SettingsClient, payload: Record<string, unknown>): Promise<Outcome<T>> {
  return ask<T>(client, "channels", payload, { refused: translateNow("welcome.channel.refused") });
}

/** A descriptor added with its secrets alone: nothing else it requires lacks a default. */
export const simple = (descriptor: ChannelDescriptor): boolean =>
  descriptor.auth.kind === "secrets" && descriptor.settings.every((field) => field.required !== true || field.default !== undefined);

/** A URL's host, or nothing for one that does not parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Whether `host` is one of `patterns` (`*.example.com` takes any name under it). */
function hostDeclared(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern));
}

/** A channel's setup links on a host it declares: its own hosts, or its pairing link's; any other is left out. */
export function setupLinksOf(descriptor: ChannelDescriptor): readonly { readonly label: string; readonly url: string }[] {
  const pairingHost =
    descriptor.pairing === undefined ? undefined : hostOf(descriptor.pairing.deepLinkTemplate.replace(/\{[a-z]+\}/g, "x"));
  const declared = [...(descriptor.hosts ?? []), ...(pairingHost === undefined ? [] : [pairingHost])];
  return (descriptor.setupLinks ?? []).filter((link) => {
    const host = hostOf(link.url);
    return host !== undefined && hostDeclared(host, declared);
  });
}

/** A connection to pair on, with what its probe said setting it up still asks (a link only to a host its channel declares). */
export interface Added {
  readonly connectionId: string;
  readonly label: string;
  readonly setup?: MessagingSetup | undefined;
}

/**
 * The channel's secrets, saved, recorded as this flow's, and probed (the
 * terminal's `addTelegram`): a connection this form made that cannot be
 * recorded or does not answer is removed again, so a wrong token leaves
 * nothing behind, and a removal that fails is said. No secret is ever shown
 * back, nor kept once the form has answered.
 */
export function ChannelForm(props: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly descriptor: ChannelDescriptor;
  /** Recorded as setup's own (Welcome's channels step), so setup knows the connection it made; absent elsewhere. */
  readonly onboardingStep?: string;
  readonly onBack: () => void;
  /** What Back says where another Back shares the screen (Welcome's own step Back): "Back to channels". */
  readonly backLabel?: string;
  readonly onAdded: (added: Added) => void;
}) {
  const t = useT();
  const fieldId = useId();
  const fields = props.descriptor.auth.kind === "none" ? [] : (props.descriptor.auth.fields ?? []);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { client, workspaceId, descriptor } = props;
  /** Undo a connection this form made; what is left when that fails is said. */
  const undo = async (connectionId: string, why: string): Promise<string> => {
    const removed = await channels(client, { action: "delete", workspaceId, connectionId });
    return removed.ok ? why : t("welcome.channel.notRemoved", { reason: why, message: removed.message });
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const secrets = Object.fromEntries(fields.map((field) => [field.key, (values[field.key] ?? "").trim()]));
    setValues({});
    const failed = (message: string): void => {
      setBusy(false);
      setProblem(message);
    };
    const saved = await channels<ChannelsSaveAnswer>(client, {
      action: "save",
      workspaceId,
      providerId: descriptor.providerId,
      enabled: true,
      settings: {},
      secrets,
    });
    if (!saved.ok) return failed(saved.message);
    const connectionId = saved.value.connectionId;
    if (props.onboardingStep !== undefined) {
      const created = await ask(client, "onboarding", { action: "created", workspaceId, step: props.onboardingStep, ref: connectionId });
      if (!created.ok)
        return failed(await undo(connectionId, t("welcome.channel.notSetUp", { channel: descriptor.label, message: created.message })));
    }
    const probed =
      saved.value.notApplied !== undefined
        ? { ok: true as const, value: { ok: false, detail: saved.value.notApplied } }
        : await channels<{ readonly ok: boolean; readonly detail?: string; readonly setup?: MessagingSetup }>(client, {
            action: "probe",
            workspaceId,
            connectionId,
          });
    if (!probed.ok || !probed.value.ok) {
      return failed(
        await undo(
          connectionId,
          t("welcome.channel.checkFailed", {
            channel: descriptor.label,
            detail: probed.ok ? (probed.value.detail ?? t("welcome.channel.noReason")) : probed.message,
          }),
        ),
      );
    }
    setBusy(false);
    props.onAdded({ connectionId, label: descriptor.label, setup: probed.value.setup });
  };
  const ready = fields.every((field) => (values[field.key] ?? "").trim() !== "");
  const links = setupLinksOf(descriptor);
  return (
    <form className="welcome-key" onSubmit={(event) => void submit(event)}>
      {descriptor.setupHelp === undefined ? null : <p className="settings-description welcome-help">{descriptor.setupHelp}</p>}
      {links.length === 0 ? null : (
        <p className="actions">
          {links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          ))}
        </p>
      )}
      {fields.map((field, index) => (
        <p key={field.key}>
          <Field id={`${fieldId}-${String(index)}`} label={field.label}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={values[field.key] ?? ""}
              onChange={(event) => setValues((before) => ({ ...before, [field.key]: event.target.value }))}
            />
          </Field>
        </p>
      ))}
      <div className="actions">
        {/* Its words, not only its accessible name, say where it goes: Welcome's own Back is on the same card. */}
        <Button variant="ghost" disabled={busy} onClick={props.onBack}>
          {props.backLabel ?? t("welcome.action.back")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          {busy ? t("welcome.channel.testing") : t("welcome.channel.testAndAdd")}
        </Button>
      </div>
      <StatusNote note={busy ? t("welcome.channel.saving", { channel: descriptor.label }) : undefined} className="" />
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </form>
  );
}

/** How long pairing waits between asking whether the code was sent. */
export const PAIRING_POLL_MS = 2_000;

const mmss = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The operator pairs themself: a one-time `XXXX-XXXX` code with its
 * countdown and the channel's own link, then who sent it, confirmed as them
 * before the binding is made. A code that expired or the owner forgot gets a
 * new one on request. Only the current code's answers count, one poll at a
 * time, and each action runs once.
 */
export function PairOperator(props: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly channel: Added;
  readonly principalId: string;
  readonly onPaired: () => void;
}) {
  const { client, workspaceId } = props;
  const t = useT();
  const [pairing, setPairing] = useState<ChannelsPairAnswer>();
  const [state, setState] = useState<ChannelsPairingAnswer>({ state: "waiting" });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReactNode>();
  const question = useRef<HTMLParagraphElement>(null);
  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const settings = await ask<WorkspaceSettingsAnswer>(client, "workspace-settings", { action: "get", workspaceId });
    const name = settings.ok ? settings.value.settings.operatorName : undefined;
    const answer = await channels<ChannelsPairAnswer>(client, {
      action: "pair",
      workspaceId,
      connectionId: props.channel.connectionId,
      principalId: props.principalId,
      ...(name === undefined ? {} : { name }),
    });
    setBusy(false);
    if (!answer.ok) {
      const stopped = notRunningChannel(answer);
      return setProblem(stopped === undefined ? answer.message : <ChannelNotRunning label={stopped} />);
    }
    setState({ state: "waiting" });
    setNow(Date.now());
    setPairing(answer.value);
  };
  const waiting = pairing !== undefined && state.state === "waiting";
  usePoll(() => setNow(Date.now()), 1_000, { enabled: waiting }, [pairing, state.state, client, workspaceId]);
  /** The check on its way, by the run that sent it: one at a time while that run stands. */
  const asking = useRef<() => boolean>(undefined);
  usePoll(
    (alive) => {
      if (pairing === undefined || asking.current?.() === true) return;
      asking.current = alive;
      void channels<ChannelsPairingAnswer>(client, { action: "pairing", workspaceId, pairingId: pairing.pairingId }).then((answer) => {
        if (asking.current === alive) asking.current = undefined;
        // Another code, or the panel gone: this answer is for neither.
        if (!alive()) return;
        if (!answer.ok) return setProblem(t("welcome.pairing.checkFailed", { message: answer.message }));
        setProblem(undefined);
        setState(answer.value);
      });
    },
    PAIRING_POLL_MS,
    { enabled: waiting },
    [pairing, state.state, client, workspaceId],
  );
  // Someone sent the code: the question takes focus, so it is heard as well as seen.
  useEffect(() => {
    if (state.state === "claimed") question.current?.focus();
  }, [state.state]);
  const finish = async (confirm: boolean): Promise<void> => {
    if (pairing === undefined || busy) return;
    setBusy(true);
    const answer = await channels(client, { action: confirm ? "confirm-pair" : "cancel-pair", workspaceId, pairingId: pairing.pairingId });
    setBusy(false);
    if (!answer.ok) return setProblem(answer.message);
    if (confirm) props.onPaired();
    else {
      setPairing(undefined);
      setProblem(t("welcome.pairing.notPaired"));
    }
  };
  const link = props.channel.setup?.link;
  const code = pairing === undefined ? "" : shownPairingCode(pairing.code);
  const claimedWho = claimedSenderLabel(state);
  return (
    <section className="welcome-pairing" aria-label={t("welcome.pairing.label")}>
      <h2>{t("welcome.pairing.title", { channel: props.channel.label })}</h2>
      {props.channel.setup?.lines.map((line) => (
        <p key={line} className="settings-description">
          {line}
        </p>
      ))}
      {pairing === undefined ? (
        <div className="actions">
          <Button variant="primary" disabled={busy} onClick={() => void start()}>
            {t("welcome.pairing.getCode")}
          </Button>
        </div>
      ) : state.state === "claimed" ? (
        <>
          <p ref={question} tabIndex={-1}>
            {withParts(t("welcome.pairing.claimed"), { who: <strong>{claimedWho}</strong> })}
          </p>
          <div className="actions">
            <Button variant="ghost" disabled={busy} onClick={() => void finish(false)}>
              {t("welcome.pairing.notMe")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void finish(true)}>
              {t("welcome.pairing.itsMe")}
            </Button>
          </div>
        </>
      ) : state.state === "waiting" ? (
        <>
          <p>
            {withParts(t("welcome.pairing.send", { time: mmss(Date.parse(pairing.expiresAt) - now) }), {
              code: <code data-pairing-code="">{code}</code>,
              target:
                link === undefined ? (
                  t("welcome.pairing.theBot")
                ) : (
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                ),
            })}
          </p>
          <PairingLinkBox pairing={pairing} channelLabel={props.channel.label} />
          <StatusNote note={t("welcome.pairing.waiting")} className="" />
          <div className="actions">
            <Button variant="ghost" disabled={busy} onClick={() => void finish(false)}>
              {t("welcome.pairing.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <StatusNote note={t("welcome.pairing.expired")} className="" />
          <div className="actions">
            <Button variant="primary" disabled={busy} onClick={() => void start()}>
              {t("welcome.pairing.newCode")}
            </Button>
          </div>
        </>
      )}
      {problem === undefined ? null : <Notice role="alert">{problem}</Notice>}
    </section>
  );
}
