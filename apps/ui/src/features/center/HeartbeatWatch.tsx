import type { HeartbeatGetAnswer } from "@tavi/contracts";

import { localDate, localTime } from "../../lib/time.js";
import { heartbeatHistory, setHeartbeatInstructions } from "./heartbeat-api.js";
import { HEARTBEAT_SUGGESTIONS } from "./heartbeat-options.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

import type { HeartbeatPage } from "./use-heartbeat-page.js";

/**
 * What the heartbeat keeps an eye on: its instructions' lines, edited in
 * place over the revision the editor opened at, with their history and
 * one-tap suggestions added to the instructions as the owner last answered them.
 */
export function HeartbeatWatch({
  ids,
  config,
  revision,
  timezone,
  lines,
  editing,
  setEditing,
  history,
  setHistory,
  apply,
  configRef,
  revisionRef,
  setFailure,
}: {
  /** The page's id prefix. */
  readonly ids: string;
  readonly config: HeartbeatGetAnswer["config"];
  readonly revision: number;
  readonly timezone: string;
  /** The instructions' lines, without blanks and comments. */
  readonly lines: readonly string[];
  readonly editing: HeartbeatPage["editing"];
  readonly setEditing: HeartbeatPage["setEditing"];
  readonly history: HeartbeatPage["history"];
  readonly setHistory: HeartbeatPage["setHistory"];
  readonly apply: HeartbeatPage["apply"];
  readonly configRef: HeartbeatPage["configRef"];
  readonly revisionRef: HeartbeatPage["revisionRef"];
  readonly setFailure: HeartbeatPage["setFailure"];
}) {
  const { client, workspaceId } = useWorkspace();
  return (
    <section aria-labelledby={`${ids}-watch`}>
      <h2 className="center-subhead" id={`${ids}-watch`}>
        What should I keep an eye on?
      </h2>
      {editing === undefined ? (
        <>
          {lines.length === 0 ? (
            <p className="muted">Nothing yet: add a line, or pick a suggestion.</p>
          ) : (
            <ul className="heartbeat-lines">
              {lines.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
          <div className="heartbeat-actions cluster">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing({ text: config.instructions, base: config.instructions, revision })}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={history !== undefined}
              onClick={() => {
                if (history !== undefined) setHistory(undefined);
                else
                  void heartbeatHistory(client, workspaceId).then((outcome) =>
                    outcome.ok ? setHistory(outcome.value.history) : setFailure(outcome.message),
                  );
              }}
            >
              History
            </Button>
          </div>
          <ul className="heartbeat-suggestions list-reset" aria-label="Suggestions">
            {HEARTBEAT_SUGGESTIONS.filter((suggestion) => !lines.includes(suggestion)).map((suggestion) => (
              <li key={suggestion}>
                <Button
                  className="chip"
                  onClick={() =>
                    void apply((at) => {
                      // Added to the instructions as the owner last answered them, so two quick taps keep both lines.
                      const current = (configRef.current ?? config).instructions;
                      return setHeartbeatInstructions(
                        client,
                        workspaceId,
                        at,
                        `${current.trimEnd()}${current.trim() === "" ? "" : "\n"}${suggestion}\n`,
                      );
                    }, "Added.")
                  }
                >
                  + {suggestion}
                </Button>
              </li>
            ))}
          </ul>
          {history === undefined ? null : (
            <ol className="heartbeat-history list-reset" aria-label="Instructions history">
              {history.length === 0 ? (
                <li className="muted">No earlier instructions.</li>
              ) : (
                history.map((entry) => (
                  <li key={entry.revision}>
                    <span className="meta-sm">
                      Revision {entry.revision} · {localDate(entry.createdAt, timezone)} {localTime(entry.createdAt, timezone)} ·{" "}
                      {entry.author}
                    </span>
                    <pre className="heartbeat-history-text">{entry.text}</pre>
                  </li>
                ))
              )}
            </ol>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            // Written over the revision the editor opened at: a change made meanwhile (by chat, the terminal) is refused, never lost.
            void apply(() => setHeartbeatInstructions(client, workspaceId, editing.revision, editing.text), "Saved.").then((saved) => {
              if (saved) setEditing(undefined);
              // Refused, the person has been told why and the page read again: a second Save writes over what is there now.
              else
                setEditing((open) =>
                  open === undefined ? open : { ...open, base: (configRef.current ?? config).instructions, revision: revisionRef.current },
                );
            });
          }}
        >
          <Field id={`${ids}-text`} label="Instructions" labelClassName="visually-hidden">
            <textarea
              className="heartbeat-editor"
              rows={8}
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            />
          </Field>
          <div className="heartbeat-actions cluster">
            <Button size="sm" type="submit">
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
