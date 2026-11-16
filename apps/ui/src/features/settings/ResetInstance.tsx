import { useState } from "react";

import { RESET_INSTANCE_CONFIRMATION } from "@tavi/contracts";

import { Modal } from "../../ui/Modal.js";
import { resetInstance } from "./workspace-api.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * Reset instance: delete everything the owner keeps, as if tavi had
 * just been installed. It cannot be undone, so the person types the word
 * first; the owner then stops, deletes and starts again on the empty
 * directory, and the page starts over once it is back.
 */
export function ResetInstance({ onReset }: { readonly onReset?: (() => void) | undefined }) {
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const close = (): void => {
    setOpen(false);
    setTyped("");
    setFailure(undefined);
  };
  return (
    <>
      <section className="danger-zone" aria-label="reset instance">
        <h2>Reset instance</h2>
        <p>
          Deletes everything this instance keeps, in every workspace: chats, tasks, memory, schedules, reminders, settings, artifacts, every
          chat's working folder, saved credentials and API keys, installed plugins and logs, as if tavi had just been installed. Folders on
          your computer that a chat works in or attaches are not touched. Nothing is kept; run <Command>tavi backup</Command> first for a
          copy. Or use <Command>tavi reset --yes</Command>.
        </p>
        {resetting ? (
          <p className="muted" role="status">
            Resetting. The owner is restarting on an empty data directory, and this page reloads when it is back.
          </p>
        ) : (
          <div className="danger-zone-actions">
            <Button variant="danger-ghost" onClick={() => setOpen(true)}>
              Reset instance…
            </Button>
          </div>
        )}
      </section>
      {open ? (
        <Modal title="Reset this instance?" busy={working} onClose={close}>
          <form
            className="settings-fields"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed !== RESET_INSTANCE_CONFIRMATION || working) return;
              setWorking(true);
              setFailure(undefined);
              void resetInstance(client).then((outcome) => {
                setWorking(false);
                if (!outcome.ok) {
                  setFailure(outcome.message);
                  return;
                }
                close();
                setResetting(true);
                onReset?.();
              });
            }}
          >
            <p>
              Every chat, setting, credential and plugin is deleted, and the owner restarts as if newly installed. This cannot be undone.
            </p>
            <label>
              <span>
                Type <code>{RESET_INSTANCE_CONFIRMATION}</code> to confirm
              </span>
              <input
                aria-label="type reset to confirm"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={working}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            {failure === undefined ? null : <Failure>{failure}</Failure>}
            <div className="actions">
              <Button variant="ghost" disabled={working} onClick={close}>
                Cancel
              </Button>
              <Button variant="destructive" type="submit" disabled={working || typed !== RESET_INSTANCE_CONFIRMATION}>
                {working ? "Resetting…" : "Reset instance"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
