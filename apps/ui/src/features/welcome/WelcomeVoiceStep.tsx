import { useCallback, useEffect, useState } from "react";

import type { VoiceSetupStatus } from "@tavi/contracts";

import { loadVoice, startVoiceSetup } from "./onboarding-api.js";
import { type StepProps, Working } from "./WelcomeStepParts.js";
import { Failure, Notice, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";

/** How often the step reads the owner's setup job while it runs. */
const POLL_MS = 1_000;

/** The job's line: its own words, and the download's share once its size is known. */
function progressLine(job: NonNullable<VoiceSetupStatus["job"]>): string {
  if (job.phase !== "download" || job.total === undefined || job.total <= 0) return job.message;
  return `${job.message} ${String(Math.floor(((job.received ?? 0) / job.total) * 100))}%`;
}

/**
 * Voice messages: what transcribing them on this computer needs (FFmpeg,
 * whisper.cpp, Whisper's base model), each ticked when it is here, and one
 * button that has the owner add the rest — Homebrew as the person's user,
 * the pinned model, `analyzers.json` — read back every second until it ends.
 * Where the owner cannot (no Homebrew, Linux), the commands that do it by hand.
 */
export function VoiceStep(props: StepProps) {
  const { client, onDone } = props;
  const [voice, setVoice] = useState<VoiceSetupStatus>();
  const [problem, setProblem] = useState<string>();
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const answer = await loadVoice(client);
    if (!answer.ok) return setProblem(answer.message);
    setProblem(undefined);
    setVoice(answer.value);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = voice?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(timer);
  }, [running, voice, refresh]);

  const start = async (): Promise<void> => {
    setStarting(true);
    setProblem(undefined);
    const answer = await startVoiceSetup(client);
    setStarting(false);
    if (!answer.ok) return setProblem(answer.message);
    setVoice(answer.value);
  };

  if (voice === undefined)
    return <Pending label="Checking what voice messages need here…" error={problem} reload={() => void refresh()} status />;
  if (voice.ready)
    return (
      <div className="welcome-voice">
        <Notice>Voice messages are transcribed on this computer.</Notice>
        <div className="actions">
          <Button variant="primary" onClick={onDone}>
            Continue
          </Button>
        </div>
      </div>
    );
  const parts: readonly (readonly [string, boolean])[] = [
    ["FFmpeg", voice.ffmpeg],
    ["whisper.cpp", voice.whisper],
    [`Whisper's base model (${String(voice.modelInfo.megabytes)} MB, ${voice.modelInfo.licence})`, voice.model],
  ];
  const failed = voice.job?.state === "failed" ? voice.job.message : undefined;
  return (
    <div className="welcome-voice">
      <ul className="welcome-voice-parts">
        {parts.map(([label, here]) => (
          <li key={label}>
            {here ? "✓" : "–"} {label}
            {here ? "" : " — not here yet"}
          </li>
        ))}
      </ul>
      {voice.automatic ? (
        <div className="actions">
          <Button variant="primary" disabled={running || starting} onClick={() => void start()}>
            {running ? "Setting up…" : failed === undefined ? "Set up voice messages" : "Try again"}
          </Button>
        </div>
      ) : (
        <>
          <Notice>Tavi cannot install these itself here. Run these in a terminal, then check again:</Notice>
          <ul className="welcome-voice-commands">
            {voice.commands.map((command) => (
              <li key={command}>
                <Command>{command}</Command>
              </li>
            ))}
          </ul>
          <div className="actions">
            <Button variant="primary" onClick={() => void refresh()}>
              Check again
            </Button>
          </div>
        </>
      )}
      {running && voice.job !== undefined ? <Working>{progressLine(voice.job)}</Working> : null}
      {failed === undefined ? null : <Failure>{failed}</Failure>}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </div>
  );
}
