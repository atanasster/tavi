# Videos: watching them, hearing them, measuring a movement

Tavi looks at videos with five built-in tools. This page is for the person
using them; how they fit with the rest of Tavi is in
[CONCEPTS.md](CONCEPTS.md#videos).

## What a chat can do

Send a video in a chat (on Telegram, Discord or email, or attached in the
canvas's composer), or point at one in the chat's folders, and ask about it.

- **`video.info`**: the video's facts: its container, duration, codec, size,
  frame rate and rotation, whether it has sound and subtitles, and whether it
  records a location. It never says where the location is.
- **`video.frames`**: the video through its frames. They can be evenly spaced,
  at its scene cuts, where it moves most, or at the times you name. They come
  back as one contact sheet labelled with their times, or as separate stills,
  of which the first three are shown to the model. With `ocr: true` it also
  reads the text shown in the frames.
- **`video.view`**: watches the video. Every model gets a contact sheet and two
  stills. A model you turned native video on for also gets the whole clip with
  its sound (see *A video sent whole* below).
- **`video.transcribe`**: what is said in the video, with the times it is said,
  beside the video's own subtitles. A long video is read in five-minute parts:
  the model calls again from `nextFrom`.
- **`video.pose`**: measures a person's movement over up to 60 s (see
  *Measuring a movement* below).

The same transcription reads voice messages too, with `audio.transcribe` (see
*Voice messages and other audio* below).

A video is read only from an approved attachment of the same chat (an
attachment belongs to the chat its message started or joined), or from
a file the chat may read: its own folder and the folders attached to it. What
the tools return carries where the video came from. A video someone sent you is
untrusted content: its words, subtitles and on-screen text are data, never
instructions, and an instruction found in them is asked about before anything
acts on it. No tool identifies a person, describes their face, or guesses
their age.

### Formats and limits

- **Read:** MP4, MOV, 3GP, WebM, Matroska and GIF, up to 100 MiB and 10
  minutes. The type comes from the file's bytes, so a file merely named `.mp4`
  is refused before FFmpeg sees it.
- **Uploaded in the canvas:** MP4, MOV, M4V, WebM and GIF, up to 50 MiB. The
  file goes up in pieces as you send and is never held whole. It is taken
  wherever the video tools are on, whatever `pdf.enabled` says.
- **Kept:** a video sent from a channel, mail or the web is kept 30 days, then
  deleted with its body (`tavi config set video.keepDays <1–3650>`). The frames
  taken from it stay with the chat. Asking for the video again after that says
  it is no longer kept. Videos in your folders are never pruned.

## What you bring

Tavi ships no codec, no model and no dataset whose licence it could not
confirm as permissive. You install what the tools run on, under the
licences you hold.

| What | For | How |
| --- | --- | --- |
| **FFmpeg** (required) | Every video tool | `brew install ffmpeg`, or `apt install ffmpeg`. Without it the tools are not offered, and `tavi doctor` says how to add it. `tavi serve --video-ffmpeg <path>` and `--video-ffprobe <path>` name one off your `PATH` |
| **The pose add-on** (`@tavi/video-pose`, with `onnxruntime-node`) and an RTMPose ONNX model | `video.pose` | See *Measuring a movement* |
| **The transcription add-on** (`@tavi/video-transcribe`), whisper.cpp and a ggml model | `video.transcribe`, `audio.transcribe` | `brew install whisper-cpp`, or a build of your own on `PATH`; the model goes in `<data>/video/models`, named in `analyzers.json` (see *Analysers*) |
| **The PDF tools' OCR add-on** (`@tavi/pdf-ocr`) | `video.frames { ocr: true }` | As for scanned PDFs ([PDF.md](PDF.md)) |
| **Your own analysers** | Any of the three | A command or an MCP server (see *Analysers*) |
| **A remote analyser or a native video model** | Optional | It sends what it is handed off the machine; see *What leaves the machine* |
| **Datasets** | Measuring pose accuracy yourself | `node evals/video/pose-eval.ts --dataset <dir> --analyzer <entry.json>` (see [evals/video/README.md](../evals/video/README.md)). Every major video and motion-capture dataset is non-commercial, so none is in the repository |

Add-ons are installed where `tavi` is installed. A model file must be in
`<data>/video/models`; one outside that directory is refused.

## Voice messages and other audio

Send a voice message (or an audio file) in a chat, and the chat's model reads
what is said in it with **`audio.transcribe`**: the words, and when each part
is said. A long recording is read in five-minute parts, as a video is.

- It runs on this machine, on the same path as `video.transcribe`: your FFmpeg
  turns the audio into 16 kHz mono WAV in a sandboxed run of its own, and your
  transcription analysers (whisper.cpp on your own model) read it. The audio
  leaves the machine only when you list a remote analyser, and such a call is
  asked first (see *What leaves the machine*).
- **Read:** Ogg (Telegram's voice messages, Opus), MP3, WAV, M4A and AAC, by
  the file's bytes, within the channel's attachment cap and Tavi's 100 MiB.
  Voice messages come in over a channel (Telegram, email); the canvas's
  composer does not attach audio yet.
- **Kept:** as a video is, 30 days (`video.keepDays`), then deleted with its
  body.
- The words are the sender's file's, not your message: they are untrusted
  `attachment` content, labelled as the attachment is, and an instruction in
  them is asked about before anything acts on it. No speaker is identified.
- It is turned on and off with the video tools (`video.enabled`).

Setup's **Voice messages** step does it for you (Welcome, Home's setup
checklist, or `tavi setup voice` with `tavi serve` running). It shows which of
FFmpeg, whisper.cpp and a speech model are here, and on your yes the owner:

- installs what is missing with Homebrew, as your user (never `sudo`; a fixed
  `brew install whisper-cpp ffmpeg`, nothing through a shell, never waiting on
  a prompt: when Homebrew needs something first, such as Xcode's command-line
  tools, the step fails with Homebrew's own words);
- downloads Whisper's base model (`ggml-base.bin`, about 148 MB, MIT) from the
  whisper.cpp project on Hugging Face into `<data>/video/models`, keeping it
  only when its size and SHA-256 match the ones pinned in Tavi;
- names it first under `transcribe` in `<data>/video/analyzers.json`, keeping
  everything else in the file (one that is not valid JSON is left alone, and
  the step says so);
- reloads its analysers: no restart.

Without Homebrew (or on Linux), the step gives the commands instead:

```bash
brew install whisper-cpp ffmpeg
```

then the model into `<data>/video/models` (`curl -L -o …`). *Check again* then
offers the last part, naming the model in `analyzers.json`; by hand, name it
under `transcribe` (see *Analysers*) and restart `tavi serve`.

Until then, a voice message is still received and kept: `audio.transcribe`
answers that it arrived, which of FFmpeg and a transcription analyser is
missing, and how to finish setup, and the chat passes that on rather than
saying the file never came. With the video plugin turned off, it says that
instead. `tavi doctor` has a **Transcription** line (ready, or what is
missing) and lists the transcription chain with why an entry of it cannot run.

## Analysers

Pose, transcription and on-screen text come from **analysers**, chosen by the
owner in `<data>/video/analyzers.json`. That file is host configuration: it is
never a workspace setting, and neither the canvas nor a model can change it.
It lists, per capability, the analysers to try in order. When one times out,
runs out of memory or is not available, the next is tried. Without the file,
each capability lists its built-in analyser. On-screen text then works wherever
the PDF tools' OCR add-on is installed. Pose and transcription do not: Tavi
ships no model for them, so they run only once the file names your own model.

```json
{
  "pose": [{ "type": "builtin", "id": "rtmpose", "model": { "path": "rtmpose-s.onnx", "detectorPath": "rtmdet-nano.onnx", "licence": "<the licence you hold>" } }],
  "transcribe": [{ "type": "builtin", "id": "whisper-cpp", "model": { "path": "ggml-base.bin", "licence": "MIT" } }],
  "ocr": [{ "type": "builtin", "id": "pdf-ocr" }, { "type": "mcp", "server": "vision", "tool": "read" }]
}
```

- **Built-in** analysers are the add-ons above, each on the model you name.
  The licence you give is shown in `doctor`, and in each `video.pose` result.
- **A command** is named by its absolute path. Its arguments are fixed, with
  `{{framesDir}}`, `{{audio}}`, `{{outDir}}` and `{{options}}` as whole
  arguments. It reads the decoded frames or the audio, never the video, and
  answers in `{{outDir}}/result.json`. It runs in the same sandbox as FFmpeg,
  with no network, unless its manifest says `"local": false` and its entry lists
  the hosts it may reach (`domains`).
- **An MCP server's tool** must be added, approved and enabled as any MCP server
  is, and offered to the person in the chat. Its manifest is the tool's own
  `_meta["tavi/analyzer"]`, approved with its definition, so a server that
  changes it has the tool withheld until you review it again. When the tool
  declares none, the entry can pin one. A stdio server reads each call's frames
  from a directory of its own under `<data>/video/mcp/`, which its sandbox may
  read but never write, and which is emptied after the call. Any other server is
  sent them inline, at most 8 MiB a call.

### Your own MediaPipe, as a command

MediaPipe has no Node runtime, so Tavi does not build it in. If you have it in
Python, it can be your pose analyser as a command. A virtual environment with
`mediapipe` and `numpy`, and a pose landmarker model (`pose_landmarker_full.task`,
from Google, under its licence), are all it needs. Save this as `pose.py` beside
the model:

```python
import json, sys, pathlib
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

frames_dir, out_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
model = pathlib.Path(__file__).with_name("pose_landmarker_full.task")
landmarker = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=str(model)), num_poses=2))
index = json.loads((frames_dir / "frames.json").read_text())["frames"]
frames = []
for entry in index:
    w, h = entry["width"], entry["height"]
    pixels = np.frombuffer((frames_dir / entry["file"]).read_bytes(), dtype=np.uint8).reshape(h, w, 3)
    found = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels))
    people = []
    for landmarks in found.pose_landmarks:
        points = [[p.x * w, p.y * h, max(0.0, min(1.0, p.visibility))] for p in landmarks]
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        people.append({"bbox": [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)],
                       "score": sum(p[2] for p in points) / len(points), "keypoints": points})
    frames.append({"timeSec": entry["timeSec"], "people": people})
(out_dir / "result.json").write_text(json.dumps({"result": {"skeleton": "mp33", "coordSpace": "pixels", "frames": frames}, "model": "pose_landmarker_full"}))
```

Then name it in `analyzers.json`, with your environment's Python by its
absolute path, and every folder it reads as `readRoots` (at most eight). The
video sandbox denies your home, and on macOS all of `/Users`, so list the
script's folder and the environment's, and also the base interpreter the
environment points at when that is under your home (uv's and pyenv's are; check
`home` in the environment's `pyvenv.cfg`). Otherwise Python cannot start in the
sandbox, and `video.pose` reports the analyser as crashed although `doctor`
says it is ready.

```json
{ "pose": [{ "type": "command", "id": "mediapipe", "command": "/Users/you/mediapipe/.venv/bin/python",
  "args": ["/Users/you/mediapipe/pose.py", "{{framesDir}}", "{{outDir}}"],
  "readRoots": ["/Users/you/mediapipe", "/Users/you/.local/share/uv/python"],
  "manifest": { "id": "cmd.mediapipe", "version": "1", "attribution": { "name": "MediaPipe Pose", "url": "https://ai.google.dev/edge/mediapipe", "licence": "Apache-2.0" },
    "capabilities": [{ "capability": "pose", "inputs": ["frames"], "output": "PoseTrack@1", "skeleton": "mp33" }],
    "local": true, "confined": true, "models": [{ "name": "pose_landmarker_full", "installed": true }] } }] }
```

It is handed raw RGB frames (`format: "rgb24"`) and runs in the video sandbox
with no network. It is started again for each part of a measurement, at most
60 frames at a time, within 320 MiB of resident memory, and the whole
measurement has 120 s. `tavi doctor` shows it as
ready once its entry is valid; a first `video.pose` call shows whether it runs.

`tavi doctor` lists each capability's chain and why an entry cannot run. The
canvas shows the same under Settings → Models → **Video analysers** (through
the `models` IPC's `video-status`, as the bridge refuses `doctor`). The file is
read when `serve` starts.

Whichever analyser found the joints or the words, Tavi checks its answer
against the result's schema and size before using it. The measuring of a
movement is Tavi's own.

## Measuring a movement

`video.pose` gives joint angles over time and the reps, from up to 60 s of a
video (`from`-`to`). For a squat, a push-up, a lunge or a hip hinge
(`movement`), it also gives each rep's measures at its key frame, with an
overlay of the body: the bones, the joints, and an arc for each measured
angle. `side` is the side facing the camera (`auto` by default).

- **The angles are approximate.** They are 2D angles from one camera. A
  movement names faults only once its checks are validated on recorded clips;
  until then its measures carry `validated: false` and no fault is named.
- **The setup is checked.** It looks at the view, whether the whole body is in
  frame, other people, the light, and a moving camera. Each problem found is
  named beside the measures, so the model can say what it puts in doubt. A
  measure the skeleton has no joint for (the toes, for some models) is left out.
- **The words are about fitness.** The model describes technique; it does not
  judge injury risk or diagnose. Mention of pain sends you to a
  physiotherapist or a coach.

To set up the pose add-on:
1. Add `onnxruntime-node` beside the add-on in your checkout:
   `pnpm --filter @tavi/video-pose add onnxruntime-node` (the add-on itself is part of the build).
   This edits the add-on's `package.json` and `pnpm-lock.yaml` in your checkout: keep the change
   across pulls (on a branch of your own, say).
2. Put the model (and, optionally, a person detector) in `<data>/video/models`.
3. Name it in `analyzers.json`, as in the example above.

For the best measures, film side-on at hip height, level, with the whole body
in frame and nobody else in it. The full protocol, written for the clips that
validate a movement, is [evals/video/RECORDING.md](../evals/video/RECORDING.md).

## A video sent whole

Without native video, a chat sees a video through at most three still images
and a contact sheet. Native video is per model, and off until you turn it on.
Under the cache-stable prompt layout (`models.promptLayout v2`) a video
result reads the same whether the clip is sent whole or not, so an earlier
turn's result is sent byte for byte as before.

- **Which models.** One qualifies when the provider's catalog says it takes
  video (`tavi models discover`), or when
  `tavi models probe <connection-id> --video --model <model>` passes. The probe sends a 4-second clip of four random digits, encoded by
  your FFmpeg, and the model must read them back in order. Never on OpenAI's or
  Anthropic's endpoints.
- **Turning it on.** `tavi models video <connection-id> --enable <model> --yes`, after
  reading what it means. In the canvas, Settings → Models lists each
  connection's models under **Native video**, with a switch that shows the same
  words and asks before it turns on, and **Probe** for any other model.
- **When it is used.** The model is handed the whole clip, with its sound, only
  when all of these hold:
  - the video is MP4, MOV or WebM;
  - it is up to 2 minutes and 20 MiB;
  - the whole clip is asked for (no `from`/`to`);
  - a person is in the chat.

  `notWhole` says why when it is not. A routine or a heartbeat always gets
  frames.

## What leaves the machine

Each video is read in a run of its own. On macOS, and on Linux where the
sandbox works, that run is under srt:
- no network;
- nothing readable of your home or Tavi's data but the run's own directory;
- that directory the only writable place;
- within a memory and time cap (384 MiB; 1 GiB for a transcription analyser, whose speech model needs it).

A video whose run was stopped is refused for a day. On a Linux host whose
sandbox is unavailable, video calls are refused unless you start
`tavi serve --video-allow-unconfined`.

What the tools return goes to the chat's model, as any tool result does: the
contact sheet and stills, the transcript, the text read from frames, a pose
result and its overlay. With a model run by a provider, those go to that
provider. With a local model (`--local-only`), they stay on the machine.

The video itself, its whole frames and its sound, leave the machine only when
you set up something that sends them:
- **A remote analyser** (a command with `"local": false`, or an MCP server that
  can reach the network: an HTTP one, one granted domains, or one running
  unsandboxed). Each call that would use one is asked, naming it, and no
  standing permission answers it. A routine or a heartbeat never makes one; it
  uses a local analyser instead, or none.
- **A model with native video on.** It is sent the whole clip as described
  above.

## Turning it off

`tavi config set video.enabled off` (or Settings → General) turns the video
tools off for a workspace. `tavi doctor`'s `video` section says:
- which FFmpeg was found, and how video runs are confined;
- whether the sandbox works here;
- each capability's analyser chain;
- the workspaces the tools are off in.

Its `--format text` summary has one **Video** line: ticked when the tools are on
and FFmpeg was found, crossed when they are on and FFmpeg is missing, and `–`
when they are off.

## Architecture

Video decoding, frame extraction, speech transcription, and pose biomechanics are isolated behind `VideoDecoderPort`, `VideoAnalyzerPort`, and `VideoPoseEnginePort`, and wired in a single CLI host module (`apps/cli/src/features/video/host.ts`, enforced by [`tests/boundaries.test.ts`](../tests/boundaries.test.ts)):

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Contracts & Ports** | `packages/contracts/src/video.ts`, `video-engine.ts`, `video-sniff.ts`, `movement-templates.ts` | `VideoDecoderPort`, `VideoAnalyzerPort`, `VideoPoseEnginePort`, `video.*` tool schemas, container header sniffing, and movement template schemas. |
| **Video Engine (`@tavi/plugin-video`)** | `packages/builtin/video/src/decoder.ts`, `ffmpeg.ts`, `supervise.ts`, `run.ts`, `sniff.ts`, `subtitles.ts`, `registry.ts`, `command-analyzer.ts`, `mcp-analyzer.ts`, `angles.ts`, `reps.ts`, `smooth.ts`, `template-engine.ts`, `templates.ts`, `overlay.ts` | Supervises sandboxed `ffmpeg`/`ffprobe` runs (`decoder.ts`, `supervise.ts`), orchestrates analyzer chains (`registry.ts`, `command-analyzer.ts`, `mcp-analyzer.ts`), computes 2D joint angles and rep phases (`angles.ts`, `reps.ts`, `template-engine.ts`), and renders skeleton overlays (`overlay.ts`). Its entry point is what the owner composes: the decoder, analyser and registry factories, FFmpeg discovery, the pose engine (`pose-engine.ts`) and the PDF engine's OCR as an analyser (`pdf-ocr-analyzer.ts`); `@tavi/plugin-video/internals` holds the building blocks the evals drive one at a time. |
| **Transcription & Pose Add-ons** | `packages/video-transcribe/src/index.ts` (`@tavi/video-transcribe`), `packages/video-pose/src/index.ts` (`@tavi/video-pose`) | Optional local analyzers wrapping `whisper.cpp` and ONNX pose/person-detection models (`RTMPose` with optional `RTMDet-nano` person detector), passed into `@tavi/plugin-video` via ports. |
| **Single-Owner Wiring & Tools** | `apps/cli/src/features/video/host.ts`, `tools.ts`, `audio.ts`, `retention.ts` | Single point where `@tavi/plugin-video`, `@tavi/video-pose`, and `@tavi/video-transcribe` are wired with `ConfinementPort`; registers `video.info`, `video.frames`, `video.view`, `video.transcribe`, `video.pose` and `audio.transcribe` (a voice message's speech, through the decoder's `openAudio`), and runs the 30-day media retention sweep. |

See [ARCHITECTURE.md](ARCHITECTURE.md), [evals/video/README.md](../evals/video/README.md), and [evals/video/RECORDING.md](../evals/video/RECORDING.md).
