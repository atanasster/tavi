import { useState } from "react";

import { useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";
import { Card } from "../../ui/Card.js";
import { Command } from "../../ui/Command.js";
import { RHUMB_SIGN_UP_URL } from "./lifecycle-api.js";
import { KeyField } from "./PasswordInput.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/**
 * Model retirements: with a Rhumb key the owner checks daily whether a model
 * Tavi uses retires, is redirected or changes price, and never changes one.
 * Without one, where to get a key and a field to store it.
 */
export function RhumbKeyCard({
  stored,
  busy,
  onStore,
  onCheck,
}: {
  /** Whether the credential store holds `rhumb`; `undefined` while that is read. */
  readonly stored: boolean | undefined;
  readonly busy: string | undefined;
  readonly onStore: (key: string) => void;
  readonly onCheck: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  if (stored === undefined) return null;
  return (
    <Card
      title={t("settings.rhumb.title")}
      titleId="rhumb-title"
      level={2}
      actions={
        stored ? (
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={onCheck}>
            {busy === "lifecycle-sync" ? t("settings.rhumb.checking") : t("settings.rhumb.check")}
          </Button>
        ) : null
      }
    >
      {stored ? (
        <p className="muted">{withParts(t("settings.rhumb.stored"), { command: <Command>tavi doctor</Command> })}</p>
      ) : (
        <form
          className="rhumb-key"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() === "") return;
            // Kept until it is stored: a failed store leaves it to retry, and a stored one replaces the form.
            onStore(key);
          }}
        >
          <p className="muted">
            {withParts(t("settings.rhumb.pitch"), {
              rhumb: (
                <a href={RHUMB_SIGN_UP_URL} target="_blank" rel="noreferrer">
                  Rhumb
                </a>
              ),
            })}
          </p>
          <KeyField label={t("settings.rhumb.key")} id="rhumb-key" value={key} onChange={setKey} />
          <Button type="submit" variant="primary" size="sm" disabled={busy !== undefined || key.trim() === ""}>
            {busy === "rhumb-key" ? t("settings.rhumb.storing") : t("settings.rhumb.store")}
          </Button>
        </form>
      )}
    </Card>
  );
}
