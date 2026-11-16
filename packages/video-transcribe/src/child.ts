import { spawn } from "node:child_process";

import { fail, languageOf, runTranscribe, type Exec } from "./run.js";

/**
 * The transcription add-on's child:
 * run by the owner as a command analyser, in its own confined process: inside
 * the denied home and data directory it reads only the run, this package,
 * Node's own install, whisper.cpp and the person's model. Arguments:
 * `<audio> <outDir> <options> --model <path> --whisper <path>`. Its answer is
 * `<outDir>/result.json`; every failure is said there by kind.
 */

const [audio, outDir, options, ...flags] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = flags.indexOf(`--${name}`);
  return index < 0 ? undefined : flags[index + 1];
};

/** A program run to its end, its stderr's tail kept, with nothing of the parent's environment but its path. */
const exec: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });

async function main(): Promise<void> {
  if (audio === undefined || outDir === undefined)
    throw new Error("usage: child <audio> <outDir> <options> --model <path> --whisper <path>");
  const model = flag("model");
  const whisper = flag("whisper");
  if (model === undefined || whisper === undefined || audio === "") {
    fail(outDir, "bad-input", "the transcription child was started without its audio, model or whisper.cpp");
    return;
  }
  const language = languageOf(options);
  await runTranscribe({ audio, outDir, whisper, model, ...(language === undefined ? {} : { language }) }, exec);
}

main().catch((error: unknown) => {
  if (outDir !== undefined) fail(outDir, "internal", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
