import { useEffect, useId, useState } from "react";

import {
  type MemoryAutoApproveKind,
  type MemoryConfigKey,
  type MemoryLimitName,
  MEMORY_AUTO_APPROVE_KINDS,
  MEMORY_LIMIT_BOUNDS,
  effectiveMemorySettings,
} from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { formatCount } from "../../lib/format.js";
import { Failure, InlineConfirm, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { LoadError } from "../settings/FormParts.js";
import { AppLink } from "../shell/AppLink.js";
import { settingsPath } from "../shell/route.js";
import { loadMemorySettings, saveMemorySettings } from "./memory-api.js";
import { MEMORY_LIMIT_FIELDS } from "./memory-model.js";
import { MemoryProviderSettings } from "./MemoryProviderSettings.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/** *Keep without asking*'s ticks, one per kind, in the order the Center lists them. */
const KEEP_WITHOUT_ASKING: readonly { readonly kind: MemoryAutoApproveKind; readonly label: string }[] = [
  { kind: "preference", label: "Preferences" },
  { kind: "fact", label: "Facts" },
  { kind: "lesson", label: "Lessons" },
];
/** A disclosure the owner refused a change with, and the connection it named: a yes accepts that one alone. */
interface Disclosure {
  readonly message: string;
  readonly connectionId: string | undefined;
}
/**
 * The Settings card: memory on
 * or paused, whether the agent learns from chats, and the limits under *More*.
 * Each change writes the whole `memory` section against the revision read, so
 * one made meanwhile (from the CLI, say) is a conflict said here, never
 * silently replaced.
 */
/** Whether memory is on and proposes, as the card last read or saved it: what the pane's empty text says. */
export interface MemoryMode {
  readonly enabled: boolean;
  readonly capture: string;
}

export function MemorySettingsCard({
  onModels,
  onMode,
}: {
  /** Settings → Models in place (the capture model is the `extraction` role); absent, the link's address is followed. */
  readonly onModels?: (() => void) | undefined;
  /** Told whether memory is on and proposes, each time that changes. */
  readonly onMode?: ((mode: MemoryMode) => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  /** `loadError`: why the settings could not be read; a refused change is `error`, which a re-read keeps. */
  const {
    data: answer,
    error: loadError,
    reload,
    replace: setAnswer,
  } = useLoaded(() => loadMemorySettings(client, workspaceId), [client, workspaceId]);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<MemoryLimitName, string>>>({});
  /** Hybrid recall's disclosure, waiting for the person's yes: what the owner said is sent where, and the connection it named. */
  const [disclosure, setDisclosure] = useState<Disclosure>();
  /** Personal memory's own embedding disclosure, waiting for the person's yes. */
  const [personalDisclosure, setPersonalDisclosure] = useState<Disclosure>();
  const id = useId();
  const read = answer === undefined ? undefined : (answer.effective.memory ?? effectiveMemorySettings(answer.settings.memory));
  const enabledNow = read?.enabled;
  const captureNow = read?.capture;
  useEffect(() => {
    if (enabledNow !== undefined && captureNow !== undefined) onMode?.({ enabled: enabledNow, capture: captureNow });
  }, [enabledNow, captureNow, onMode]);

  if (answer === undefined) {
    return loadError === undefined ? null : (
      <div className="memory-status">
        <LoadError error={loadError} reload={reload} />
      </div>
    );
  }
  const effective = read ?? effectiveMemorySettings(answer.settings.memory);
  const save = async (
    changes: readonly (readonly [MemoryConfigKey, string])[],
    done: string,
    confirmedConnection?: string,
    retrievalPersonal?: boolean,
  ): Promise<void> => {
    setBusy(true);
    setNote(undefined);
    const outcome = await saveMemorySettings(client, workspaceId, answer, changes, confirmedConnection, retrievalPersonal);
    setBusy(false);
    if (outcome.ok) {
      setAnswer(outcome.value);
      setError(undefined);
      setDrafts({});
      setDisclosure(undefined);
      setPersonalDisclosure(undefined);
      setNote(done);
    } else if (outcome.code === "APPROVAL_REQUIRED") {
      // Hybrid recall on a remote connection, or personal memory through it: the owner's disclosure, shown for a yes before anything is sent.
      // The yes is for the connection this disclosure names: one bound since is refused with its own.
      setError(undefined);
      const connectionId = outcome.details?.["connectionId"];
      const shown = {
        message: outcome.message,
        connectionId: typeof connectionId === "string" && connectionId !== "" ? connectionId : undefined,
      };
      if (retrievalPersonal === true) setPersonalDisclosure(shown);
      else setDisclosure(shown);
    } else {
      // A conflict means the settings moved: read them again so the next change starts from them.
      setError(outcome.message);
      if (outcome.code === "CONFLICT") reload();
    }
  };
  const limitChanges = MEMORY_LIMIT_FIELDS.flatMap((field): (readonly [MemoryConfigKey, string])[] => {
    // An empty draft is no change: a cleared field, or a number input's report of what it could not read.
    const draft = drafts[field.name]?.trim();
    return draft === undefined || draft === "" || draft === String(effective.limits[field.name]) ? [] : [[`limits.${field.name}`, draft]];
  });

  return (
    <section className="memory-settings" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="eyebrow">
        Settings
      </h3>
      <ul className="list-reset memory-settings-list">
        <li>
          <label>
            <input
              type="checkbox"
              role="switch"
              aria-describedby={`${id}-enabled`}
              checked={effective.enabled}
              disabled={busy}
              onChange={(event) =>
                void save(
                  [["enabled", event.target.checked ? "on" : "off"]],
                  event.target.checked
                    ? "Memory is on."
                    : "Memory is paused: nothing is recalled or captured anywhere. What is kept stays.",
                )
              }
            />{" "}
            Memory
          </label>{" "}
          <span id={`${id}-enabled`} className="meta-sm">
            {effective.enabled ? "On" : "Paused: nothing is recalled or captured; what is kept stays"}
          </span>
        </li>
        <li>
          <label>
            <input
              type="checkbox"
              role="switch"
              aria-describedby={`${id}-capture`}
              checked={effective.capture === "suggest"}
              disabled={busy}
              onChange={(event) =>
                void save(
                  [["capture", event.target.checked ? "suggest" : "off"]],
                  event.target.checked
                    ? "The agent may suggest things to remember again."
                    : "The agent no longer suggests things to remember; what you write yourself is still kept.",
                )
              }
            />{" "}
            Learn from chats
          </label>{" "}
          <span id={`${id}-capture`} className="meta-sm">
            {effective.capture === "suggest"
              ? "On: the agent suggests things to remember, and you decide."
              : "Off: only what you write yourself."}
          </span>{" "}
          <span className="meta-sm">
            Suggested by the capture model, the extraction role in{" "}
            <AppLink href={settingsPath("models")} onFollow={onModels}>
              Settings → Models
            </AppLink>
            .
          </span>
        </li>
        <li>
          {/* Auto-approve: opt-in per kind, all unticked; only the operator's own words, still shown with Undo. */}
          <fieldset className="memory-settings-keep" aria-describedby={`${id}-keep`}>
            <legend>Keep without asking</legend>
            {/* What may be kept, under the group's name and before its ticks: under the last one it read as that one's. */}
            <span id={`${id}-keep`} className="meta-sm memory-settings-keep-help">
              Only what you typed yourself in your own chats; never sensitive topics, updates, what came from tools, pages or messages, or
              anything in a chat once it has read one
            </span>
            <ul className="list-reset">
              {KEEP_WITHOUT_ASKING.map(({ kind, label }) => {
                const ticked = effective.autoApprove?.includes(kind) === true;
                return (
                  <li key={kind}>
                    <label>
                      <input
                        type="checkbox"
                        checked={ticked}
                        disabled={busy}
                        aria-describedby={ticked ? `${id}-keep-${kind}` : undefined}
                        onChange={(event) => {
                          const next = MEMORY_AUTO_APPROVE_KINDS.filter((each) =>
                            each === kind ? event.target.checked : effective.autoApprove?.includes(each) === true,
                          );
                          void save(
                            [["auto-approve", next.length === 0 ? "none" : next.join(",")]],
                            event.target.checked
                              ? `${label} you write are now kept without asking; each still shows with Undo.`
                              : `${label} wait for you again.`,
                          );
                        }}
                      />{" "}
                      {label}
                    </label>
                    {ticked ? (
                      <>
                        {" "}
                        <span id={`${id}-keep-${kind}`} className="meta-sm">
                          You'll still see each one, with Undo
                        </span>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </li>
        <li>
          <Field
            id={`${id}-sensitive-mode`}
            label="Sensitive topics"
            inline
            hintAs="span"
            hintClassName="meta-sm"
            hint={
              effective.sensitive === "suggest"
                ? "Health, beliefs, money and similar are suggested, masked until you reveal them, and never recalled automatically"
                : "Health, beliefs, money and similar are not saved from chats, unless you ask"
            }
          >
            <Select
              value={effective.sensitive}
              disabled={busy}
              onChange={(event) => {
                const mode = event.target.value === "suggest" ? "suggest" : "skip";
                void save(
                  [["sensitive", mode]],
                  mode === "suggest"
                    ? "Sensitive topics are suggested, masked until you reveal them."
                    : "Sensitive topics are no longer saved from chats.",
                );
              }}
            >
              <option value="skip">Don't save</option>
              <option value="suggest">Suggest, masked</option>
            </Select>
          </Field>
        </li>
      </ul>
      <details className="memory-settings-more">
        <summary className="disclosure">More</summary>
        <p>
          <Field
            id={`${id}-retrieval`}
            label="Search quality"
            inline
            hintAs="span"
            hintClassName="meta-sm"
            hint={
              effective.retrieval === "hybrid"
                ? "Recall also finds memories worded differently, through the embedding model in Settings → Models; words alone when it cannot answer"
                : "Recall matches words; meaning search needs an embedding model in Settings → Models"
            }
          >
            <Select
              value={effective.retrieval}
              disabled={busy || disclosure !== undefined || personalDisclosure !== undefined}
              onChange={(event) => {
                const mode = event.target.value === "hybrid" ? "hybrid" : "lexical";
                void save(
                  [["retrieval", mode]],
                  mode === "hybrid" ? "Memory is now searched by meaning too." : "Memory is searched by its words again.",
                );
              }}
            >
              <option value="lexical">Words</option>
              <option value="hybrid">Words and meaning</option>
            </Select>
          </Field>
        </p>
        {disclosure === undefined ? null : (
          <InlineConfirm
            className="memory-confirm"
            label="Turn on meaning search"
            message={disclosure.message}
            confirmLabel={busy ? "Turning on…" : "Turn on"}
            cancelLabel="Cancel"
            busy={busy}
            onConfirm={() => void save([["retrieval", "hybrid"]], "Memory is now searched by meaning too.", disclosure.connectionId)}
            onCancel={() => setDisclosure(undefined)}
          />
        )}
        {/* Personal memory through a remote embedding connection: its own opt-in, after its own disclosure. A local one embeds it anyway. */}
        {effective.retrieval !== "hybrid" || effective.retrievalConnection === undefined ? null : (
          <p>
            <label>
              <input
                type="checkbox"
                aria-describedby={`${id}-retrieval-personal`}
                checked={effective.retrievalPersonal !== undefined && effective.retrievalPersonal === effective.retrievalConnection}
                disabled={busy || personalDisclosure !== undefined}
                onChange={(event) =>
                  event.target.checked
                    ? void save([["retrieval", "hybrid"]], "Personal memory is now searched by meaning too.", undefined, true)
                    : void save(
                        [["retrieval", "hybrid"]],
                        "Personal memory is searched by its words again; its embeddings are removed.",
                        undefined,
                        false,
                      )
                }
              />{" "}
              Personal memory too
            </label>{" "}
            <span id={`${id}-retrieval-personal`} className="meta-sm">
              {effective.retrievalPersonal !== undefined && effective.retrievalPersonal === effective.retrievalConnection
                ? `Your personal memory is searched by meaning too, through ${effective.retrievalConnection}`
                : `Your personal memory, shared by all your workspaces, is matched by its words; on, it is sent to ${effective.retrievalConnection} too`}
            </span>
          </p>
        )}
        {personalDisclosure === undefined ? null : (
          <InlineConfirm
            className="memory-confirm"
            label="Search personal memory by meaning too"
            message={personalDisclosure.message}
            confirmLabel={busy ? "Turning on…" : "Turn on for personal memory"}
            cancelLabel="Cancel"
            busy={busy}
            onConfirm={() =>
              void save([["retrieval", "hybrid"]], "Personal memory is now searched by meaning too.", personalDisclosure.connectionId, true)
            }
            onCancel={() => setPersonalDisclosure(undefined)}
          />
        )}
        <p>
          <label>
            <input
              type="checkbox"
              role="switch"
              aria-describedby={`${id}-digest`}
              checked={effective.digest === "weekly"}
              disabled={busy}
              onChange={(event) =>
                void save(
                  [["digest", event.target.checked ? "weekly" : "off"]],
                  event.target.checked ? "The weekly digest is on." : "No more digests: proposals still wait here until they expire.",
                )
              }
            />{" "}
            Weekly digest
          </label>{" "}
          <span id={`${id}-digest`} className="meta-sm">
            {effective.digest === "weekly"
              ? "On: what waits for you is gathered weekly, and before anything expires"
              : "Off: no digest; proposals still wait here until they expire"}
          </span>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              role="switch"
              aria-describedby={`${id}-consolidation`}
              checked={effective.consolidation === "weekly"}
              disabled={busy}
              onChange={(event) =>
                void save(
                  [["consolidation", event.target.checked ? "weekly" : "off"]],
                  event.target.checked
                    ? "Weekly tidy-up suggestions are on: each one waits for you here."
                    : "No more tidy-up suggestions; the ones waiting stay until you decide them.",
                )
              }
            />{" "}
            Tidy-up suggestions
          </label>{" "}
          <span id={`${id}-consolidation`} className="meta-sm">
            {effective.consolidation === "weekly"
              ? "Weekly: suggestions to merge, replace or end what is kept, each shown before and after; nothing changes until you keep one"
              : "Off: what is kept is never tidied"}
          </span>
        </p>
        <form
          className="memory-settings-limits"
          aria-label="Memory limits"
          // The owner's bounds are said in words, naming what was typed, rather than by the browser's bubble.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (limitChanges.length > 0) void save(limitChanges, "Memory limits saved.");
          }}
        >
          {MEMORY_LIMIT_FIELDS.map((field) => {
            const bounds = MEMORY_LIMIT_BOUNDS[field.name];
            return (
              <p key={field.name}>
                <Field
                  id={`${id}-${field.name}`}
                  label={field.label}
                  inline
                  hintAs="span"
                  hintClassName="meta-sm"
                  hint={
                    <>
                      {field.hint} {formatCount(bounds.min)}–{formatCount(bounds.max)}; default {formatCount(bounds.default)}.
                    </>
                  }
                >
                  <input
                    type="number"
                    inputMode="numeric"
                    min={bounds.min}
                    max={bounds.max}
                    step={1}
                    value={drafts[field.name] ?? String(effective.limits[field.name])}
                    disabled={busy}
                    onChange={(event) => setDrafts((held) => ({ ...held, [field.name]: event.target.value }))}
                  />
                </Field>
              </p>
            );
          })}
          <Button size="sm" type="submit" disabled={busy || limitChanges.length === 0}>
            Save limits
          </Button>
        </form>
        {/* A provider change moves the settings' revision: read them again, so the next save here starts from it. */}
        <MemoryProviderSettings onChanged={reload} />
      </details>
      <StatusNote note={note} />
      {error === undefined ? null : <Failure>{error}</Failure>}
    </section>
  );
}
