#!/usr/bin/env node
// Cuts the scenes scripts/docs/demo-record.mjs recorded into the demo video:
//
//   node scripts/docs/demo-edit.mjs [--in <recording dir>] [--out <dir>]
//
// Writes, into --out (by default .demo-video/ at the repository root):
//   tavi-demo.mp4    1920×1080, 30 fps, H.264 — for YouTube, and to drop into a README or release
//   poster.png       a still of the canvas scene, for a README link
//   thumbnail.png    1280×720, for YouTube
//   youtube.md       a title, a description and chapters timed to this cut
//
// Each scene's frames are shown for as long as the page held them, except a
// still stretch with no reading pause asked for, which is cut to under a
// second: the model's think time is shortened, never what it drew. Needs
// ffmpeg with libx264 on the PATH, and the browser plugin's Playwright (for
// the title cards and captions, drawn in the canvas's own faces).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { launchBrowser, root } from "./browser.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const input = flag("--in") ?? join(root, ".demo-recording");
const out = flag("--out") ?? join(root, ".demo-video");
const FPS = 30;
/** The longest a still stretch stays on screen when no reading pause was asked for. */
const STILL = 0.8;
/** The longest a wait the recording marked fast lasts in the cut. */
const FAST = 2;
const W = 1920;
const H = 1080;
/** Where a recorded scene sits on the stage, leaving a band below for its caption. */
const BOX = { x: 160, y: 34, w: 1600, h: 900 };
const PHONE_H = 900;

const SCENES = [
  { name: "terminal", chapter: "In the terminal: tavi chat" },
  { name: "canvas", chapter: "In the browser: the web canvas" },
  { name: "phone", chapter: "On your phone" },
];

try {
  execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { stdio: "pipe" }).toString().includes("libx264") ||
    (() => {
      throw new Error("this ffmpeg has no libx264");
    })();
} catch (error) {
  console.error(`ffmpeg with libx264 is needed on the PATH: ${error.message}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "tavi-demo-edit-"));
mkdirSync(out, { recursive: true });
const ffmpeg = (...rest) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...rest], { stdio: "inherit" });
const ENCODE = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart"];

// ---------------------------------------------------------------------------
// The timeline of a scene: each frame's time on screen, and its captions placed on it.

function timeline(manifest) {
  const frames = [...manifest.frames].sort((a, b) => a.t - b.t);
  const durations = frames.map((frame, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : manifest.end;
    return { frame, real: Math.max(0, next - frame.t), shown: Math.max(1 / FPS, Math.min(next - frame.t, STILL)) };
  });
  const at = (t) => {
    let i = durations.findIndex((entry, k) => t >= entry.frame.t && (k + 1 === durations.length || t < durations[k + 1].frame.t));
    if (i === -1) i = t < frames[0].t ? 0 : durations.length - 1;
    return i;
  };
  // A wait marked fast plays in at most FAST seconds, however much the page redrew during it.
  const spans = [];
  for (const mark of manifest.marks.filter((m) => m.fast !== undefined)) {
    if (mark.fast) spans.push({ from: mark.t, to: manifest.end });
    else if (spans.length > 0 && spans.at(-1).to === manifest.end) spans.at(-1).to = mark.t;
  }
  for (const span of spans) {
    const inside = durations.filter((entry) => entry.frame.t >= span.from && entry.frame.t < span.to);
    const total = inside.reduce((sum, entry) => sum + entry.shown, 0);
    if (total > FAST)
      for (const entry of inside) {
        entry.shown *= FAST / total;
        // How a moment inside this frame maps into it: in proportion, as the whole wait was.
        entry.scale = entry.real > 0 ? entry.shown / entry.real : 0;
      }
  }
  /** Where a moment `dt` seconds into a frame falls in the frame's time on screen. */
  const offset = (entry, dt) => Math.max(0, entry.scale === undefined ? Math.min(dt, STILL) : dt * entry.scale);
  // A hold keeps the screen as it is at its mark for that long, from the mark on.
  for (const mark of manifest.marks.filter((m) => m.hold !== undefined)) {
    const entry = durations[at(mark.t)];
    entry.shown = Math.max(entry.shown, offset(entry, mark.t - entry.frame.t) + mark.hold / 1000);
  }
  const starts = [];
  let clock = 0;
  for (const entry of durations) {
    starts.push(clock);
    clock += entry.shown;
  }
  const outputTime = (t) => {
    const i = at(t);
    return starts[i] + Math.min(offset(durations[i], t - durations[i].frame.t), durations[i].shown);
  };
  const captions = manifest.marks
    .filter((m) => m.caption !== undefined)
    .map((m) => ({ text: m.caption, start: outputTime(m.t) }))
    .map((c, i, all) => ({ ...c, end: i + 1 < all.length ? all[i + 1].start : clock }));
  const fast = spans
    .map((span) => ({ start: outputTime(span.from), end: outputTime(span.to) }))
    .filter((span) => span.end - span.start > 0.2);
  return { durations, length: clock, captions, fast };
}

// ---------------------------------------------------------------------------
// Stills drawn in the canvas's faces: the stage, captions, and the title and end cards.

const fromCanvas = createRequire(join(root, "apps/ui/package.json"));
const font = (pkg, file) => pathToFileURL(join(dirname(fromCanvas.resolve(`${pkg}/package.json`)), "files", file)).href;
const banner = pathToFileURL(join(root, "docs/assets/brand/banner-dark.png")).href;
const page = (body, background = "transparent") => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: "Bricolage"; src: url("${font("@fontsource-variable/bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2")}") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Inter"; src: url("${font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2")}") format("woff2"); font-weight: 100 900; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${background}; }
  body { position: relative; font-family: "Inter", system-ui, sans-serif; color: hsl(150 21% 93%); }
  .stage { position: absolute; inset: 0; background: radial-gradient(1400px 800px at 50% 30%, hsl(160 24% 10%), hsl(160 24% 6%)); }
  .box { position: absolute; border-radius: 14px; box-shadow: 0 28px 90px rgba(0,0,0,.55), 0 0 0 1px hsl(160 14% 20%); }
  .phone { position: absolute; border-radius: 58px; background: #050807; box-shadow: 0 28px 90px rgba(0,0,0,.6), 0 0 0 2px hsl(160 14% 24%); }
  .caption { position: absolute; left: 0; right: 0; top: ${BOX.y + BOX.h + 26}px; text-align: center; }
  .caption span { display: inline-flex; align-items: center; gap: 16px; font-size: 40px; font-weight: 550; letter-spacing: -0.01em; }
  .caption i { width: 14px; height: 14px; border-radius: 50%; background: hsl(40 89% 66%); display: inline-block; }
  .badge { position: absolute; display: inline-flex; align-items: center; gap: 10px; padding: 8px 18px; border-radius: 999px; background: hsl(160 24% 7% / 82%); color: hsl(40 89% 70%); font-size: 24px; font-weight: 650; letter-spacing: .02em; box-shadow: 0 0 0 1px hsl(40 60% 50% / 40%); }
  .card { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 34px; text-align: center; }
  .card img { width: 1280px; }
  .card .line { font-size: 38px; color: hsl(153 10% 72%); }
  .card .url { font-family: "Bricolage"; font-weight: 600; font-size: 64px; letter-spacing: -0.02em; color: hsl(158 56% 64%); }
  .beta { display: inline-block; padding: 6px 18px; border-radius: 999px; background: hsl(40 89% 66%); color: hsl(160 24% 7%); font-weight: 700; font-size: 26px; letter-spacing: .06em; text-transform: uppercase; }
</style></head><body>${body}</body></html>`;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const tab = await context.newPage();
async function still(file, html, transparent = false) {
  const path = join(work, `${file}.html`);
  writeFileSync(path, html);
  await tab.goto(pathToFileURL(path).href);
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: join(work, `${file}.png`), omitBackground: transparent });
  return join(work, `${file}.png`);
}

const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const phoneW = (frameW, frameH) => Math.round((PHONE_H * frameW) / frameH / 2) * 2;

// ---------------------------------------------------------------------------

const clips = [];
const chapters = [];
let clock = 0;

const title = await still(
  "title",
  page(
    `<div class="stage" style="background:hsl(160 24% 7%)"></div><div class="card"><img src="${banner}"><div><span class="beta">Beta</span></div><div class="line">Open source · runs on your own computer · no account, no telemetry</div></div>`,
  ),
);
const end = await still(
  "end",
  page(
    `<div class="stage" style="background:hsl(160 24% 7%)"></div><div class="card"><img src="${banner}" style="width:960px"><div class="url">github.com/atanasster/tavi</div><div class="line">Beta · MIT licence · your choice of model, cloud or local</div></div>`,
  ),
);

async function card(name, png, seconds) {
  const file = join(work, `${name}.mp4`);
  ffmpeg(
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    String(seconds),
    "-i",
    png,
    "-vf",
    `fade=in:st=0:d=0.5,fade=out:st=${seconds - 0.5}:d=0.5`,
    ...ENCODE,
    file,
  );
  clips.push(file);
  clock += seconds;
}

// YouTube takes chapters only from 0:00 and at least 10 s each: the cards belong to the scenes beside them.
await card("title", title, 4);

for (const scene of SCENES) {
  const dir = join(input, scene.name);
  if (!existsSync(join(dir, "manifest.json"))) {
    console.warn(`no ${scene.name} scene in ${input}: left out`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const { durations, length, captions, fast } = timeline(manifest);
  const list = join(work, `${scene.name}.ffconcat`);
  const lines = ["ffconcat version 1.0"];
  for (const { frame, shown } of durations) lines.push(`file '${join(dir, frame.file)}'`, `duration ${shown.toFixed(4)}`);
  lines.push(`file '${join(dir, durations.at(-1).frame.file)}'`);
  writeFileSync(list, `${lines.join("\n")}\n`);

  // The scene's place on the stage: the recorded box, or a phone in its bezel.
  const probe = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    join(dir, durations[0].frame.file),
  ])
    .toString()
    .trim()
    .split(",")
    .map(Number);
  const phone = scene.name === "phone";
  const place = phone ? { w: phoneW(probe[0], probe[1]), h: PHONE_H, y: BOX.y } : { w: BOX.w, h: BOX.h, y: BOX.y };
  place.x = Math.round((W - place.w) / 2);
  const stage = await still(
    `stage-${scene.name}`,
    page(
      `<div class="stage"></div>${
        phone
          ? `<div class="phone" style="left:${place.x - 16}px;top:${place.y - 16}px;width:${place.w + 32}px;height:${place.h + 32}px"></div>`
          : `<div class="box" style="left:${place.x}px;top:${place.y}px;width:${place.w}px;height:${place.h}px"></div>`
      }`,
    ),
  );
  const captionPngs = [];
  for (const [i, caption] of captions.entries())
    captionPngs.push(
      await still(`caption-${scene.name}-${i}`, page(`<div class="caption"><span><i></i>${escape(caption.text)}</span></div>`), true),
    );

  // While a wait plays sped up, a badge in the scene's corner says so.
  const badge = await still(
    `badge-${scene.name}`,
    page(
      phone
        ? `<div class="badge" style="left:${place.x + place.w + 44}px;top:${place.y + 8}px">▶▶ sped up</div>`
        : `<div class="badge" style="right:${W - place.x - place.w + 18}px;top:${place.y + 18}px">▶▶ sped up</div>`,
    ),
    true,
  );

  const inputs = ["-loop", "1", "-framerate", String(FPS), "-i", stage, "-f", "concat", "-safe", "0", "-i", list];
  for (const png of captionPngs) inputs.push("-loop", "1", "-framerate", String(FPS), "-i", png);
  inputs.push("-loop", "1", "-framerate", String(FPS), "-i", badge);
  const filters = [
    `[1:v]fps=${FPS},scale=${place.w}:${place.h}:flags=lanczos,setsar=1[rec]`,
    `[0:v][rec]overlay=${place.x}:${place.y}:shortest=1[v0]`,
  ];
  captions.forEach((caption, i) => {
    const fadeIn = `fade=in:st=${caption.start.toFixed(3)}:d=0.3:alpha=1`;
    filters.push(`[${i + 2}:v]format=rgba,${fadeIn}[c${i}]`);
    filters.push(
      `[v${i}][c${i}]overlay=0:0:shortest=1:enable='between(t,${caption.start.toFixed(3)},${caption.end.toFixed(3)})'[v${i + 1}]`,
    );
  });
  let last = `v${captions.length}`;
  if (fast.length > 0) {
    const when = fast.map((span) => `between(t,${span.start.toFixed(3)},${span.end.toFixed(3)})`).join("+");
    filters.push(`[${last}][${captions.length + 2}:v]overlay=0:0:shortest=1:enable='${when}'[vf]`);
    last = "vf";
  }
  filters.push(`[${last}]fade=in:st=0:d=0.4,fade=out:st=${Math.max(0, length - 0.4).toFixed(3)}:d=0.4,format=yuv420p[out]`);
  const file = join(work, `${scene.name}.mp4`);
  ffmpeg(...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-t", length.toFixed(3), ...ENCODE, file);
  clips.push(file);
  chapters.push({ at: chapters.length === 0 ? 0 : clock, text: scene.chapter });
  if (scene.name === "canvas") {
    // The poster: the canvas once its first answer is up, where the second caption starts.
    const at = (captions[1]?.start ?? length / 3) + 0.5;
    ffmpeg("-ss", at.toFixed(3), "-i", file, "-frames:v", "1", join(out, "poster.png"));
  }
  clock += length;
  console.log(
    `${scene.name}: ${length.toFixed(1)} s, ${durations.length} frames, ${captions.length} captions, ${fast.length} sped-up waits`,
  );
}

await card("end", end, 5);
await browser.close();

const joined = join(work, "clips.txt");
writeFileSync(joined, clips.map((clip) => `file '${clip}'`).join("\n"));
const video = join(out, "tavi-demo.mp4");
ffmpeg("-f", "concat", "-safe", "0", "-i", joined, "-c", "copy", "-movflags", "+faststart", video);
ffmpeg("-i", title, "-vf", "scale=1280:720:flags=lanczos", join(out, "thumbnail.png"));

const stamp = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
writeFileSync(
  join(out, "youtube.md"),
  `# Title

Tavi: a local-first personal AI agent in your terminal, browser and phone (beta demo)

# Description

Tavi is an open-source personal AI agent that runs on your own computer. Talk to it in a terminal, in a browser, or from your phone over Telegram, email and Discord: it is the same agent everywhere, with one memory, one set of permissions and one list of things waiting on you. Anything risky stops and asks you first. No account, no telemetry, and you choose the model, cloud or local.

Everything in this video is a real run on a fresh install; long waits for the model are shortened.

Code (MIT): https://github.com/atanasster/tavi

${chapters.map((chapter) => `${stamp(chapter.at)} ${chapter.text}`).join("\n")}

# Tags

ai agent, personal assistant, local-first, open source, self-hosted, llm, cli, typescript
`,
);
rmSync(work, { recursive: true, force: true });
console.log(`${video} (${clock.toFixed(1)} s), poster.png, thumbnail.png, youtube.md in ${out}`);
