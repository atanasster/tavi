import { mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lookup } from "node:dns/promises";

import { createConfinedChromium, type ChromiumSandboxMode } from "../../packages/builtin/browser/src/confined.js";

/**
 * Chromium confined under the real srt, in the Linux matrix
 * (`TAVI_SANDBOX_MATRIX=srt`, with Playwright's Chromium in the image). On
 * macOS Chromium cannot start inside srt 0.0.79 (it registers a Mach service,
 * which srt's Seatbelt profile has no setting for), so it runs with
 * Chromium's own sandbox there instead (`identity.ts`).
 */

const RUNS = process.platform === "linux" && process.env["TAVI_SANDBOX_MATRIX"] === "srt";
const SECRET = "TAVI-BROWSER-SECRET";

describe.skipIf(!RUNS)("a confined Chromium (linux)", () => {
  let data = "";
  let scratch = "";
  let chosen: { mode: ChromiumSandboxMode; failures: readonly { mode: ChromiumSandboxMode; error: string }[] } | undefined;
  const temp = temporaryDirectories();
  beforeAll(() => {
    data = realpathSync(temp.create("tavi-browser-real-"));
    mkdirSync(join(data, "credentials"));
    writeFileSync(join(data, "credentials", "key.txt"), SECRET);
    scratch = join(data, "browser-scratch");
  });
  afterAll(() => temp.cleanup());

  const confined = () =>
    createConfinedChromium({
      confinement: createSrtConfinement({}),
      denyRead: [homedir(), data],
      scratchDirectory: scratch,
      onMode: (mode, failures) => {
        chosen = { mode, failures };
        console.info(`chromium sandbox mode: ${mode}; stronger ones failed: ${JSON.stringify(failures)}`);
      },
    });

  it("starts with the strongest Chromium sandbox that works inside srt, renders, and reaches the web", async () => {
    const browser = await confined().launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto("https://example.org/", { timeout: 30_000 });
      expect(await page.title()).toContain("Example Domain");
    } finally {
      await browser.close();
    }
    expect(chosen?.mode).toBeDefined();
  }, 120_000);

  it("keeps a renderer from the denied data directory by srt alone, even with Chromium's own sandbox off", async () => {
    // The probe must be readable inside: beside the data directory, not in the denied home. It is read by /bin/sh, never executed.
    const probe = join(tmpdir(), `tavi-renderer-probe-${String(process.pid)}.sh`);
    writeFileSync(probe, readFileSync(join(import.meta.dirname, "fixtures", "renderer-probe.sh")));
    // --renderer-cmd-prefix needs --no-zygote, which Chromium takes only with --no-sandbox: srt is the only boundary here.
    const chromium = createConfinedChromium({
      confinement: createSrtConfinement({}),
      denyRead: [homedir(), data],
      scratchDirectory: scratch,
      modes: ["none"],
    });
    const browser = await chromium.launch({ headless: true, args: ["--no-zygote", `--renderer-cmd-prefix=/bin/sh ${probe}`] });
    let probes: string[] = [];
    try {
      const page = await browser.newPage();
      await page.setContent("<p>probe</p>");
      for (const launch of readdirSync(scratch).filter((name) => name.startsWith("launch-") && !name.includes("."))) {
        const folder = join(scratch, launch, ".tmp");
        probes = [
          ...probes,
          ...readdirSync(folder)
            .filter((name) => name.startsWith("renderer-probe-"))
            .map((name) => readFileSync(join(folder, name), "utf8")),
        ];
      }
    } finally {
      await browser.close();
      rmSync(probe, { force: true });
    }
    console.info(`renderer probes:\n${probes.join("\n")}`);
    expect(probes.length).toBeGreaterThan(0);
    for (const found of probes) {
      expect(found).toContain("key=denied");
      expect(found).toMatch(/Seccomp:\s+2/);
    }
  }, 120_000);

  it("runs its renderers under Chromium's own seccomp filter and namespaces, inside srt's", async () => {
    const chromium = confined();
    const browser = await chromium.launch({ headless: true });
    const ours = readlinkSync("/proc/self/ns/user");
    const renderers: { readonly seccomp: string; readonly userns: string; readonly pidns: string }[] = [];
    try {
      const page = await browser.newPage();
      await page.setContent("<p>renderer</p>");
      for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        try {
          if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type=renderer")) continue;
          renderers.push({
            seccomp: /Seccomp:\s+(\d)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? "?",
            userns: readlinkSync(`/proc/${pid}/ns/user`),
            pidns: readlinkSync(`/proc/${pid}/ns/pid`),
          });
        } catch {
          // Gone, or not ours to read.
        }
      }
    } finally {
      await browser.close();
    }
    console.info(`mode ${chromium.mode() ?? "?"}; renderers: ${JSON.stringify(renderers)}; the test's own user namespace: ${ours}`);
    expect(renderers.length).toBeGreaterThan(0);
    for (const renderer of renderers) {
      expect(renderer.seccomp).toBe("2");
      expect(renderer.userns).not.toBe(ours);
    }
  }, 120_000);

  it("keeps downloads in the launch's scratch, and opens no denied file by URL", async () => {
    const browser = await confined().launch({ headless: true });
    try {
      const page = await browser.newPage({ acceptDownloads: true });
      await page.setContent(`<a id=get href="data:text/plain,hello" download="note.txt">get</a>`);
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#get")]);
      expect(await download.path()).toMatch(new RegExp(`^${scratch}/launch-`));
      const opened = await page.goto(`file://${join(data, "credentials", "key.txt")}`).then(
        () => page.content(),
        (error: unknown) => String(error),
      );
      expect(opened).not.toContain(SECRET);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("keeps a workspace's profile across launches", async () => {
    const profile = join(data, "browser-profiles", "default");
    mkdirSync(profile, { recursive: true });
    const chromium = confined();
    const first = await chromium.launchPersistent(profile, { headless: true });
    const page = await first.newPage();
    await page.goto("https://example.org/");
    await page.evaluate(() => localStorage.setItem("tavi", "kept"));
    await first.close();
    const second = await chromium.launchPersistent(profile, { headless: true });
    try {
      const again = await second.newPage();
      await again.goto("https://example.org/");
      expect(await again.evaluate(() => localStorage.getItem("tavi"))).toBe("kept");
    } finally {
      await second.close();
    }
  }, 120_000);

  it("reaches no address on this host, by number or by name, nor the metadata service", async () => {
    const server: Server = createServer((_request, response) => response.end("owner-only"));
    const port = await listenLocally(server);
    const browser = await confined().launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const url of [
        `http://127.0.0.1:${String(port)}/`,
        `http://localhost:${String(port)}/`,
        "http://169.254.169.254/latest/meta-data/",
      ]) {
        const shown = await page.goto(url, { timeout: 15_000 }).then(
          async (response) => `${String(response?.status())} ${await page.content()}`,
          (error: unknown) => String(error),
        );
        expect(shown, url).not.toContain("owner-only");
        expect(shown, url).not.toMatch(/^200 /);
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);

  it("reaches no private-network address, by number or by a name resolving to one, when the owner holds it off", async () => {
    // 10.255.255.1 answers nothing: a refusal by policy is srt's own quick answer, an unheld one a dial that never connects.
    const target = "http://10.255.255.1:81/";
    // A public name resolving to the same private address, when this container can resolve it.
    const named = "http://10.255.255.1.nip.io:81/";
    const resolvesNamed = await lookup("10.255.255.1.nip.io").then(
      (answer) => answer.address === "10.255.255.1",
      () => false,
    );
    const held = createConfinedChromium({
      confinement: createSrtConfinement({}),
      denyRead: [homedir(), data],
      scratchDirectory: scratch,
      privateAddresses: { except: [] },
    });
    const open = async (chromium: ReturnType<typeof createConfinedChromium>, url: string): Promise<string> => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const started = Date.now();
        const shown = await page.goto(url, { timeout: 10_000 }).then(
          (response) => `status ${String(response?.status())}`,
          (error: unknown) => `error ${String(error).split("\n")[0] ?? ""}`,
        );
        console.info(`${url}: ${shown} after ${String(Date.now() - started)} ms`);
        return shown;
      } finally {
        await browser.close();
      }
    };
    expect(await open(held, target)).toBe("status 403");
    if (resolvesNamed) expect(await open(held, named)).toBe("status 403");
    else console.info("10.255.255.1.nip.io does not resolve here: the by-name case is left to the unit tests");
    // The same address, not held off: no answer from srt, only a dial that never connects.
    expect(await open(confined(), target)).not.toBe("status 403");
  }, 180_000);
});
