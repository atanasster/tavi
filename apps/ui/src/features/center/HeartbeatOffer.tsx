import type { HeartbeatGetAnswer } from "@tavi/contracts";
import { useEffect, useId, useState } from "react";

import { useT } from "../../lib/i18n.js";
import { Failure } from "../../ui/Parts.js";
import { dismissHeartbeatOffer, getHeartbeatOffer, heartbeatEstimate, startHeartbeat } from "./heartbeat-api.js";
import { Button } from "../../ui/Button.js";
import { heartbeatInterval } from "./heartbeat-options.js";
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
  const t = useT();
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
        {t("center.heartbeatOffer.title")}
      </h2>
      <p>
        {t("center.heartbeatOffer.ask", {
          interval: heartbeatInterval(config.everyMs),
          start: config.activeHours.start,
          end: config.activeHours.end,
        })}
      </p>
      <p className="meta-sm">{t("center.heartbeatOffer.hint", { count: estimate.checks })}</p>
      <Field id={`${ids}-watch`} label={t("center.heartbeatOffer.watch")}>
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
          {t("center.heartbeatOffer.turnOn")}
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
          {t("center.heartbeatOffer.notNow")}
        </Button>
      </div>
      <Failure message={failure} />
    </section>
  );
}
