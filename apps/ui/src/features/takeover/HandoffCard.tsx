import type { BrowserHandoff } from "@tavi/contracts";
import { useId, useState } from "react";

import { useNow } from "../../hooks/use-poll.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { useTakeover } from "./context.js";
import { formatLeft } from "./input.js";
import { NoteForm } from "./NoteForm.js";
import { Button } from "../../ui/Button.js";

/**
 * The agent asks a person to act in its browser: where an `ask_user` question's card goes. **Take control**
 * opens the takeover surface; **I can't do this** answers it, with an
 * optional note, without taking the page. A take of the person's own that
 * the agent's call is waiting on (`operator`) offers to resume control.
 */
export function HandoffCard({
  taskId,
  handoff,
  deadlineAt,
  now = Date.now,
}: {
  readonly taskId: string;
  readonly handoff: BrowserHandoff;
  readonly deadlineAt: string;
  readonly now?: () => number;
}) {
  const takeover = useTakeover();
  const id = useId();
  const clock = useNow(1000, true, now);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string>();
  const [declined, setDeclined] = useState(false);
  const left = Date.parse(deadlineAt) - clock;
  const target = {
    taskId,
    sessionId: handoff.sessionId,
    handoff: { ...(handoff.instructions === undefined ? {} : { instructions: handoff.instructions }), deadlineAt, reason: handoff.reason },
  };
  const asked = handoff.reason !== "operator";
  return (
    <section className="handoff-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{asked ? "Tavi needs you in the browser" : "Tavi is waiting for you to hand the browser back"}</h3>
      {handoff.instructions === undefined ? null : <p>{handoff.instructions}</p>}
      <p className="muted">
        {Number.isFinite(left) ? `${formatLeft(left)} left` : null}
        {" · "}Taking over shows the page as pictures: a screen reader cannot read it. If you cannot act in it, say so instead.
      </p>
      {takeover === undefined ? (
        <Notice>Open Tavi where the live browser view is offered to take over.</Notice>
      ) : declined ? (
        <Notice role="status">Told Tavi you could not do this.</Notice>
      ) : declining ? (
        <NoteForm
          id={`${id}-note`}
          label="Why not? (optional)"
          note={note}
          onNote={setNote}
          submit="Tell Tavi"
          onSubmit={() => {
            void takeover.decline(target, note.trim() === "" ? undefined : note.trim()).then((why) => {
              if (why === undefined) setDeclined(true);
              else setFailure(why);
            });
          }}
          onCancel={() => setDeclining(false)}
        />
      ) : (
        <div className="handoff-actions">
          <Button variant="primary" onClick={() => takeover.open(target)}>
            {asked ? "Take control" : "Resume control"}
          </Button>
          {asked ? <Button onClick={() => setDeclining(true)}>I can't do this</Button> : null}
        </div>
      )}
      <Failure message={failure} />
    </section>
  );
}
