import { useEffect, useId, useState, type FormEvent } from "react";

import { HeartbeatGetAnswerSchema, MemoryListAnswerSchema, WorkspaceSettingsAnswerSchema } from "@tavi/contracts";

import { read } from "../../lib/ipc.js";
import { saveAbout } from "./onboarding-api.js";
import { Notice, StatusNote } from "../../ui/Parts.js";
import { type StepProps, Working } from "./WelcomeStepParts.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";

export function AboutStep(props: StepProps) {
  const nameId = useId();
  const zoneId = useId();
  const hoursId = useId();
  const [current, setCurrent] = useState<{
    readonly operatorName?: string;
    readonly timezone: string;
    readonly memoryOn: boolean;
    readonly heartbeatHours?: string;
  }>();
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [hours, setHours] = useState("");
  const [remember, setRemember] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string>();
  const fields = props.step.about?.fields ?? ["name", "timezone", "activeHours"];
  useEffect(() => {
    let live = true;
    void (async () => {
      const [settings, heartbeat] = await Promise.all([
        read(props.client, "workspace-settings", { action: "get", workspaceId: props.workspaceId }, WorkspaceSettingsAnswerSchema),
        read(props.client, "heartbeat", { action: "get", workspaceId: props.workspaceId }, HeartbeatGetAnswerSchema),
      ]);
      if (!live || !settings.ok) return;
      // Memory counts only where the owner offers it, the workspace has it on, and its host answers a read
      // (a disabled `tavi.memory` refuses one): otherwise it is paused here and nothing more asks it.
      const offered = props.memory !== false && settings.value.effective.memory?.enabled !== false;
      const memoryOn =
        offered &&
        (
          await read(
            props.client,
            "memory",
            { action: "list", workspaceId: props.workspaceId, kinds: ["preference"], scopes: ["personal"] },
            MemoryListAnswerSchema,
          )
        ).ok;
      if (!live) return;
      const timezone = settings.value.effective.timezone;
      const heartbeatHours =
        heartbeat.ok && heartbeat.value.config.enabled
          ? `${heartbeat.value.config.activeHours.start}-${heartbeat.value.config.activeHours.end}`
          : undefined;
      setCurrent({
        ...(settings.value.settings.operatorName === undefined ? {} : { operatorName: settings.value.settings.operatorName }),
        timezone,
        memoryOn,
        ...(heartbeatHours === undefined ? {} : { heartbeatHours }),
      });
      setName(settings.value.settings.operatorName ?? "");
      // Prefilled from the browser; saved only when it differs from the host's.
      setZone(props.browserTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? timezone);
      setHours(heartbeatHours ?? "");
    })();
    return () => {
      live = false;
    };
  }, [props.client, props.workspaceId, props.browserTimeZone, props.memory]);
  if (current === undefined) return <Working>Loading…</Working>;
  const range = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(hours);
  const hoursWrong =
    fields.includes("activeHours") && current.heartbeatHours !== undefined && hours !== current.heartbeatHours && range === null;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (hoursWrong) return;
    setSaving(true);
    const saved = await saveAbout(
      props.client,
      props.workspaceId,
      {
        ...(fields.includes("name") && name.trim() !== "" ? { name: name.trim() } : {}),
        ...(fields.includes("timezone") && zone.trim() !== "" ? { timezone: zone.trim() } : {}),
        ...(fields.includes("activeHours") && current.heartbeatHours !== undefined && range !== null && hours !== current.heartbeatHours
          ? { activeHours: { start: range[1] as string, end: range[2] as string } }
          : {}),
        remember,
      },
      current,
    );
    setSaving(false);
    if (!saved.ok) return setNote(saved.message);
    setNote(saved.value);
    props.onDone();
  };
  const remembered = [
    name.trim() === "" ? undefined : `your name is ${name.trim()}`,
    zone.trim() === "" ? undefined : `you're in ${zone.trim()}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <form className="welcome-about" onSubmit={(event) => void submit(event)}>
      {fields.includes("name") ? (
        <p>
          <Field id={nameId} label="Your name">
            <input value={name} maxLength={80} autoComplete="name" onChange={(event) => setName(event.target.value)} />
          </Field>
        </p>
      ) : null}
      {fields.includes("timezone") ? (
        <p>
          <Field id={zoneId} label="Your time zone">
            <input value={zone} onChange={(event) => setZone(event.target.value)} />
          </Field>
        </p>
      ) : null}
      {fields.includes("activeHours") && current.heartbeatHours !== undefined ? (
        <p>
          <Field
            id={hoursId}
            label="Hours the heartbeat may check in"
            hintAs="span"
            hintClassName="hint"
            hint={hoursWrong ? "Use HH:MM-HH:MM, such as 08:00-22:00." : undefined}
          >
            <input
              value={hours}
              placeholder="08:00-22:00"
              aria-invalid={hoursWrong ? true : undefined}
              onChange={(event) => setHours(event.target.value)}
            />
          </Field>
        </p>
      ) : null}
      {current.memoryOn ? (
        remembered === "" ? null : (
          <p>
            <label>
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Tavi will remember:{" "}
              {remembered}
            </label>
          </p>
        )
      ) : (
        <Notice>Memory is paused: these are kept in this workspace's settings only.</Notice>
      )}
      <div className="actions">
        <Button variant="primary" type="submit" disabled={saving || hoursWrong}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <StatusNote note={note} />
    </form>
  );
}
