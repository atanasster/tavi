import { describe, expect, it } from "vitest";

import { declaredTarget, isAllowed, licenceAllowed, requiredFrameworkPeers, violations } from "./support/dependency-rules.js";

/** The rule table both gates read, exercised on violations rather than only on passing manifests. */
describe("the headless closure's dependency rules", () => {
  it("allows react in the CLI's dependencies only", () => {
    expect(isAllowed("@tavi/cli", "react", "dependencies")).toBe(true);
    expect(isAllowed("@tavi/cli", "react", "peerDependencies")).toBe(false);
    expect(isAllowed("@tavi/runtime", "react", "devDependencies")).toBe(false);
    expect(isAllowed("@tavi/client", "react", "dependencies")).toBe(false);
  });

  it("allows plugin-browser's Playwright as a devDependency and a peer, nowhere else", () => {
    expect(isAllowed("@tavi/plugin-browser", "playwright", "peerDependencies")).toBe(true);
    expect(isAllowed("@tavi/plugin-browser", "playwright", "optionalDependencies")).toBe(false);
    expect(isAllowed("@tavi/plugin-browser", "playwright", "dependencies")).toBe(false);
    expect(isAllowed("@tavi/plugin-browser", "@playwright/test", "peerDependencies")).toBe(false);
    expect(isAllowed("@tavi/runtime", "playwright", "peerDependencies")).toBe(false);
  });

  it("refuses the forbidden list everywhere else, and ignores what it does not govern", () => {
    for (const name of ["electron", "react-dom", "puppeteer", "chromium"]) expect(isAllowed("@tavi/cli", name, "dependencies")).toBe(false);
    expect(isAllowed("@tavi/runtime", "better-sqlite3", "dependencies")).toBe(true);
  });

  it("sees through an npm alias", () => {
    expect(declaredTarget("r", "npm:react@19.2.0")).toBe("react");
    expect(declaredTarget("pw", "npm:@playwright/test@1")).toBe("@playwright/test");
    expect(declaredTarget("zod", "4.6.5")).toBe("zod");
    expect(violations("@tavi/runtime", { dependencies: { r: "npm:react@19.2.0" } })).toEqual(["react in dependencies"]);
  });

  it("keeps the TUI's stack — React, Ink and the reconciler — in the CLI alone", () => {
    expect(violations("@tavi/runtime", { dependencies: { ink: "7.1.1" } })).toEqual(["ink in dependencies"]);
    expect(violations("@tavi/agent-host", { peerDependencies: { "react-reconciler": "0.33.0" } })).toEqual([
      "react-reconciler in peerDependencies",
    ]);
    expect(violations("@tavi/cli", { dependencies: { ink: "7.1.1", react: "19.2.8" } })).toEqual([]);
    // Ink is a runtime dependency of the CLI, not a dev-only one.
    expect(violations("@tavi/cli", { devDependencies: { ink: "7.1.1" } })).toEqual(["ink in devDependencies"]);
    expect(violations("@tavi/cli", { dependencies: { "react-reconciler": "0.33.0" } })).toEqual(["react-reconciler in dependencies"]);
  });

  it("requires an excepted forbidden peer to be optional", () => {
    expect(violations("@tavi/plugin-browser", { peerDependencies: { playwright: "^1.63.0" } })).toEqual(["playwright as a required peer"]);
    expect(
      violations("@tavi/plugin-browser", {
        peerDependencies: { playwright: "^1.63.0" },
        peerDependenciesMeta: { playwright: { optional: true } },
      }),
    ).toEqual([]);
  });

  it("keeps onnxruntime-node to the pose add-on, and refuses a bundled FFmpeg everywhere", () => {
    expect(violations("@tavi/video-pose", { optionalDependencies: { "onnxruntime-node": "1.22.0" } })).toEqual([]);
    expect(violations("@tavi/cli", { dependencies: { "onnxruntime-node": "1.22.0" } })).toEqual([
      "onnxruntime-node outside @tavi/video-pose",
    ]);
    expect(violations("@tavi/plugin-video", { dependencies: { "onnxruntime-node": "1.22.0" } })).toEqual([
      "onnxruntime-node outside @tavi/video-pose",
    ]);
    for (const name of ["ffmpeg-static", "@ffmpeg/ffmpeg", "fluent-ffmpeg"])
      expect(violations("@tavi/plugin-video", { dependencies: { [name]: "1.0.0" } })).toEqual([`${name} in dependencies`]);
  });

  it("allows the test support package as a devDependency only", () => {
    expect(violations("@tavi/agent-host", { devDependencies: { "@tavi/test-support": "workspace:*" } })).toEqual([]);
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      expect(violations("@tavi/agent-host", { [section]: { "@tavi/test-support": "workspace:*" } })).toEqual([
        `@tavi/test-support in ${section}`,
      ]);
    }
    expect(violations("@tavi/cli", { dependencies: { support: "npm:@tavi/test-support@0.1.0" } })).toEqual([
      "@tavi/test-support in dependencies",
    ]);
  });

  it("refuses the PDF libraries the headless graph must not hold", () => {
    for (const name of ["canvas", "@napi-rs/canvas", "mupdf", "pdf-parse", "@embedpdf/engines"]) {
      expect(violations("@tavi/plugin-pdf", { dependencies: { [name]: "1.0.0" } })).toEqual([`${name} in dependencies`]);
    }
  });

  it("finds a required framework peer, and lets an optional one pass", () => {
    expect(requiredFrameworkPeers({ peerDependencies: { react: "*", vue: "*", "html-entities": "*" } })).toEqual(["react", "vue"]);
    expect(requiredFrameworkPeers({ peerDependencies: { svelte: "*" }, peerDependenciesMeta: { svelte: { optional: true } } })).toEqual([]);
    expect(requiredFrameworkPeers({ peerDependencies: { p: "npm:preact@10" } })).toEqual(["preact"]);
  });

  it("allows permissive licences, a permissive choice of an OR, and nothing copyleft or unknown", () => {
    for (const licence of ["MIT", "Apache-2.0", "OFL-1.1", "(MIT OR CC0-1.0)", "(BSD-3-Clause OR GPL-2.0)", "MIT AND ISC"])
      expect(licenceAllowed("x", licence), licence).toBe(true);
    for (const licence of ["AGPL-3.0-only", "GPL-3.0", "UNLICENSED", "MIT AND GPL-2.0", undefined, { type: "MIT" }])
      expect(licenceAllowed("x", licence), String(licence)).toBe(false);
    // Parentheses nest, and AND binds tighter than OR.
    expect(licenceAllowed("x", "(MIT OR GPL-2.0) AND (GPL-3.0)")).toBe(false);
    expect(licenceAllowed("x", "Apache-2.0 AND (MIT OR CC0-1.0)")).toBe(true);
    expect(licenceAllowed("x", "GPL-3.0 OR MIT AND ISC")).toBe(true);
    expect(licenceAllowed("x", "MIT AND GPL-3.0 OR AGPL-3.0")).toBe(false);
    expect(licenceAllowed("x", "(MIT")).toBe(false);
  });
});
