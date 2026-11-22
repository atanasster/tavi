import { useState } from "react";

import { RESET_INSTANCE_CONFIRMATION } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { Modal } from "../../ui/Modal.js";
import { resetInstance } from "./workspace-api.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * Reset instance: delete everything the owner keeps, as if tavi had
 * just been installed. It cannot be undone, so the person types the word
 * first; the owner then stops, deletes and starts again on the empty
 * directory, and the page starts over once it is back.
 */
export function ResetInstance({ onReset }: { readonly onReset?: (() => void) | undefined }) {
  const t = useT();
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
      <section className="danger-zone" aria-label={t("settings.reset.region")}>
        <h2>{t("settings.reset.title")}</h2>
        <p>
          {withParts(t("settings.reset.body"), {
            backup: <Command>tavi backup</Command>,
            command: <Command>tavi reset --yes</Command>,
          })}
        </p>
        {resetting ? (
          <p className="muted" role="status">
            {t("settings.reset.resetting")}
          </p>
        ) : (
          <div className="danger-zone-actions">
            <Button variant="danger-ghost" onClick={() => setOpen(true)}>
              {t("settings.reset.open")}
            </Button>
          </div>
        )}
      </section>
      {open ? (
        <Modal title={t("settings.reset.confirmTitle")} busy={working} onClose={close}>
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
            <p>{t("settings.reset.confirmBody")}</p>
            <label>
              <span>{withParts(t("settings.reset.type"), { word: <code>{RESET_INSTANCE_CONFIRMATION}</code> })}</span>
              <input
                aria-label={t("settings.reset.typeLabel")}
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
                {t("ui.confirm.cancel")}
              </Button>
              <Button variant="destructive" type="submit" disabled={working || typed !== RESET_INSTANCE_CONFIRMATION}>
                {working ? t("settings.reset.working") : t("settings.reset.title")}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
