import { errorMessage } from "@tavi/contracts/util";
import { useCallback, useState } from "react";

import { translateNow } from "../lib/i18n.js";
import type { Outcome } from "../lib/ipc.js";

/**
 * Opening something elsewhere (a task, a worker, a chat) from a list: the
 * last attempt's failure, "Task t1 could not be opened: …", cleared as the
 * next begins.
 */
export function useOpenError(): {
  readonly openError: string | undefined;
  readonly open: (what: string, opening: () => Promise<unknown>) => void;
} {
  const [openError, setOpenError] = useState<string>();
  const open = (what: string, opening: () => Promise<unknown>): void => {
    setOpenError(undefined);
    opening().catch((failure: unknown) => setOpenError(translateNow("ui.hooks.openFailed", { what, reason: errorMessage(failure) })));
  };
  return { openError, open };
}

/** Whether an action's note is its success (or a dialog's word) or its refusal. */
export type ActionTone = "note" | "failure";

/** How one action ends: `reload: false` for one that only reads (it opens a form, or a task), so nothing is read again. */
export interface ActionOptions {
  readonly reload?: boolean;
}

/**
 * The page's actions: one at a time (`busy` names it, and every button that
 * could start another is disabled meanwhile), each ending in a note — its
 * success or its refusal, in words, with `tone` saying which — and a reload,
 * unless it only read. Work that throws ends the same way: its error is the
 * refusal, and the buttons are enabled again.
 * `say` puts a dialog's own success over the note until the next action starts.
 */
export function useAction(reload: () => void): {
  readonly busy: string | undefined;
  readonly note: string | undefined;
  readonly tone: ActionTone;
  readonly run: (key: string, work: () => Promise<Outcome<string | undefined>>, options?: ActionOptions) => Promise<void>;
  readonly say: (note: string | undefined) => void;
} {
  const [busy, setBusy] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<{ readonly note: string | undefined; readonly tone: ActionTone }>({
    note: undefined,
    tone: "note",
  });
  const [said, say] = useState<string | undefined>();
  const run = useCallback(
    async (key: string, work: () => Promise<Outcome<string | undefined>>, options: ActionOptions = {}): Promise<void> => {
      say(undefined);
      setBusy(key);
      let done: Outcome<string | undefined>;
      try {
        done = await work();
      } catch (failure: unknown) {
        done = { ok: false, message: errorMessage(failure) };
      } finally {
        setBusy(undefined);
      }
      setOutcome(done.ok ? { note: done.value, tone: "note" } : { note: done.message, tone: "failure" });
      if (options.reload !== false) reload();
    },
    [reload],
  );
  return said === undefined ? { busy, ...outcome, run, say } : { busy, note: said, tone: "note", run, say };
}

/**
 * A modal form's submission: errors shown once a submit was tried, one save
 * at a time, the owner's refusal kept in words, and the form closed on
 * success.
 */
export function useFormSubmit(
  valid: boolean,
  save: () => Promise<string | undefined>,
  close: () => void,
): { readonly touched: boolean; readonly saving: boolean; readonly failure: string | undefined; readonly submit: () => void } {
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const submit = (): void => {
    setTouched(true);
    if (!valid || saving) return;
    setSaving(true);
    setFailure(undefined);
    void save().then((problem) => {
      setSaving(false);
      if (problem === undefined) close();
      else setFailure(problem);
    });
  };
  return { touched, saving, failure, submit };
}
