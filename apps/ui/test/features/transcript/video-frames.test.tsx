// @vitest-environment jsdom
import type { ToolCard } from "@tavi/client/browser";
import { describe, expect, it } from "vitest";

import { PreviewImageContext } from "../../../src/features/transcript/FillReview.js";
import { rendererFor } from "../../../src/features/transcript/ToolCards.js";
import { videoPreviewsOf } from "../../../src/features/transcript/VideoFrames.js";
import { mount, unmountAll } from "../../support/dom.js";

/**
 * A video tool's card on the canvas: the
 * contact sheet, the stills with their times and the pose overlays, read
 * through the preview rule, beside the call's payloads.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = async (artifactId: string) => ({ ok: true as const, value: `data:image/jpeg;base64,${artifactId}` });

describe("the video card", () => {
  it("names a result's sheet, stills and overlays, at most twelve, and nothing of a malformed one", () => {
    expect(
      videoPreviewsOf({
        sheet: { artifactId: "art-sheet", columns: 2, rows: 2 },
        frames: [{ artifactId: "art-f1", timeSec: 1.25 }, { artifactId: 7 }],
        reps: [{ overlayArtifactId: "art-o1", bottomSec: 2 }],
      }),
    ).toEqual([
      { artifactId: "art-sheet", caption: "Contact sheet", wide: true },
      { artifactId: "art-f1", caption: "Frame at 1.3 s", wide: false },
      { artifactId: "art-o1", caption: "Rep 1 at 2.0 s", wide: false },
    ]);
    expect(
      videoPreviewsOf({ frames: Array.from({ length: 20 }, (_, index) => ({ artifactId: `art-${String(index)}`, timeSec: index })) }),
    ).toHaveLength(12);
    // A rep with no usable time is captioned by its number alone.
    expect(videoPreviewsOf({ reps: [{ overlayArtifactId: "art-o2", bottomSec: null }] })).toEqual([
      { artifactId: "art-o2", caption: "Rep 1", wide: false },
    ]);
    expect(videoPreviewsOf("not a result")).toEqual([]);
    expect(videoPreviewsOf(null)).toEqual([]);
  });

  it("shows a completed frames call's sheet beside its payloads, headed by its mode", async () => {
    const card = {
      callId: "c1",
      toolName: "video.frames",
      status: "completed",
      input: { source: { artifactId: "art-clip" }, mode: "scene" },
      output: { sheet: { artifactId: "art-sheet", columns: 2, rows: 2 }, frames: [], shown: ["art-sheet"] },
    } as unknown as ToolCard;
    const shown = await mount(
      <PreviewImageContext.Provider value={read}>{rendererFor("video.frames").body?.(card)}</PreviewImageContext.Provider>,
    );
    expect([...shown.querySelectorAll(".video-frame img")].map((image) => [image.getAttribute("alt"), image.getAttribute("src")])).toEqual([
      ["Contact sheet", "data:image/jpeg;base64,art-sheet"],
    ]);
    expect(shown.querySelector(".video-frame-wide")).not.toBeNull();
    expect(rendererFor("video.frames").headline?.(card)).toBe("scene");
  });

  it("shows stills with their times and a pose call's overlays by rep, and nothing while it runs", async () => {
    const card = {
      callId: "c2",
      toolName: "video.pose",
      status: "completed",
      input: { source: { path: "squat.mov" }, movement: "squat" },
      output: { frames: [{ artifactId: "art-f1", timeSec: 0.5 }], reps: [{ overlayArtifactId: "art-o1", bottomSec: 2.25 }] },
    } as unknown as ToolCard;
    const shown = await mount(
      <PreviewImageContext.Provider value={read}>{rendererFor("video.pose").body?.(card)}</PreviewImageContext.Provider>,
    );
    expect([...shown.querySelectorAll(".video-frame img")].map((image) => image.getAttribute("alt"))).toEqual([
      "Frame at 0.5 s",
      "Rep 1 at 2.3 s",
    ]);
    expect([...shown.querySelectorAll(".video-frame figcaption")].map((caption) => caption.textContent)).toEqual([
      "Frame at 0.5 s",
      "Rep 1 at 2.3 s",
    ]);
    expect(rendererFor("video.pose").headline?.(card)).toBe("squat");
    unmountAll();
    const running = await mount(
      <PreviewImageContext.Provider value={read}>
        {rendererFor("video.frames").body?.({ ...card, toolName: "video.frames", status: "running" } as ToolCard)}
      </PreviewImageContext.Provider>,
    );
    expect(running.querySelector(".video-frame")).toBeNull();
  });
});
