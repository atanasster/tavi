import { formatHeartbeatInterval, type HeartbeatGetAnswer } from "@tavi/contracts";
import { useEffect, useId, useState } from "react";

import { Failure } from "../../ui/Parts.js";
import { dismissHeartbeatOffer, getHeartbeatOffer, heartbeatEstimate, startHeartbeat } from "./heartbeat-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/**
 * The heartbeat's first-run offer: one
 * card, in Home (or the Center's rail with Home off), shown only while the
 * owner offers it — the heartbeat off, the offer never dismissed, something
 * to watch. *Turn on* switches it on with the instructions it prefilled (which
 * the person may edit first); *Not now* is for good.
 */
export function HeartbeatOffer({ onDone }: { readonly onDone?: (() => void) | undefined }) {
  const { client, workspaceId } = useWorkspace();
  const [answer, setAnswer] = useState<HeartbeatGetAnswer | undefined>();
  const [instructions, setInstructions] = useState("");
  const [failure, setFailure] = useState<string | undefined>();
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  useEffect(() => {
    let current = true;
    void getHeartbeatOffer(client, workspaceId).then((outcome) => {
      if (!current || !outcome.ok) return;
      setAnswer(outcome.value);
      setInstructions(outcome.value.offer?.instructions ?? "");
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);
  const offer = answer?.offer;
  if (answer === undefined || offer === undefined || settled) return null;
  const { config } = answer;
  const estimate = heartbeatEstimate(config, undefined);
  const settle = (outcome: { readonly ok: boolean; readonly message?: string }): void => {
    setBusy(false);
    if (!outcome.ok) {
      setFailure(outcome.message);
      return;
    }
    setSettled(true);
    onDone?.();
  };
  return (
    <section className="section-card heartbeat-offer" aria-labelledby={`${ids}-title`}>
      <h2 className="center-subhead" id={`${ids}-title`}>
        Want a heartbeat?
      </h2>
      <p>
        Want me to check on things every {formatHeartbeatInterval(config.everyMs)} between {config.activeHours.start} and{" "}
        {config.activeHours.end}, and only message you when something needs you?
      </p>
      <p className="meta-sm">
        Up to {estimate.checks} checks a day, each a short read-only turn on your fast model; you can change all of it later in Center →
        Heartbeat.
      </p>
      <Field id={`${ids}-watch`} label="What I'd keep an eye on">
        <textarea className="heartbeat-editor" rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </Field>
      <div className="heartbeat-actions cluster">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void startHeartbeat(client, workspaceId, answer.revision, instructions).then(settle);
          }}
        >
          Turn on
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void dismissHeartbeatOffer(client, workspaceId).then(settle);
          }}
        >
          Not now
        </Button>
      </div>
      <Failure message={failure} />
    </section>
  );
}
