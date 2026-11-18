// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { Composer } from "../../../src/features/chat/Composer.js";
import { FILES_ONLY_PROMPT, type UploadAttachment } from "../../../src/features/chat/attachments.js";
import { mount } from "../../support/dom.js";

/** The composer with a PDF or a video: uploaded as the message is sent, named by it, kept on a failure. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The composer mounted, sending to `onSubmit` and uploading through `onUpload`. */
const composer = (
  onSubmit: (prompt: string, sent?: { readonly attachments?: readonly string[]; readonly attachmentNames?: readonly string[] }) => void,
  onUpload: (file: UploadAttachment) => Promise<string>,
): Promise<HTMLElement> =>
  mount(<Composer disabled={false} placeholder="Message" onSubmit={onSubmit} onUpload={onUpload} onRetry={() => undefined} />);

async function attach(shown: HTMLElement, file: File): Promise<void> {
  const input = shown.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function send(shown: HTMLElement): Promise<void> {
  await act(async () => {
    (shown.querySelector("form") as HTMLFormElement).requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const pdf = (): File => new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], "form.pdf", { type: "application/pdf" });

describe("the composer with a PDF", () => {
  it("uploads the file, then sends a message of files alone naming it", async () => {
    const sent: { prompt: string; attachments?: readonly string[]; names?: readonly string[] }[] = [];
    const shown = await composer(
      (prompt, extra) =>
        void sent.push({
          prompt,
          ...(extra?.attachments === undefined ? {} : { attachments: extra.attachments }),
          ...(extra?.attachmentNames === undefined ? {} : { names: extra.attachmentNames }),
        }),
      async () => "art-up-7",
    );
    await attach(shown, pdf());
    expect(shown.querySelector(".attachment-list")?.textContent).toContain("form.pdf");
    await send(shown);
    // Its name goes with it, for the message to show; the owner is sent only the id.
    expect(sent).toEqual([{ prompt: FILES_ONLY_PROMPT, attachments: ["art-up-7"], names: ["form.pdf"] }]);
    expect(shown.querySelector(".attachment-list")).toBeNull();
  });

  it("keeps the prompt and the file, and says why, when the upload is refused", async () => {
    const sent: string[] = [];
    const shown = await composer(
      (prompt) => void sent.push(prompt),
      async () => {
        throw new Error("form.pdf: not a PDF");
      },
    );
    await attach(shown, pdf());
    await send(shown);
    expect(sent).toHaveLength(0);
    expect(shown.textContent).toContain("form.pdf: not a PDF");
    expect(shown.querySelector(".attachment-list")?.textContent).toContain("form.pdf");
  });
});

describe("the composer with a video", () => {
  it("accepts a video and a GIF, uploads each as itself, and says so in its hint", async () => {
    const uploaded: UploadAttachment[] = [];
    const sent: (readonly string[] | undefined)[] = [];
    const shown = await composer(
      (_prompt, extra) => void sent.push(extra?.attachments),
      async (file) => {
        uploaded.push(file);
        return `art-up-${String(uploaded.length)}`;
      },
    );
    expect((shown.querySelector("input[type=file]") as HTMLInputElement).accept).toContain(".mp4,.mov,.m4v,.webm,.gif");
    // What can be attached is said on the attach button, not in a line under the box.
    expect(shown.querySelector('[aria-label="Attach PDF, video, GIF, text and code files"]')).not.toBeNull();
    await attach(
      shown,
      new File([new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")])], "clip.mp4", { type: "video/mp4" }),
    );
    await attach(shown, new File([new TextEncoder().encode("GIF89a")], "loop.gif", { type: "image/gif" }));
    await send(shown);
    expect(uploaded.map((file) => [file.name, file.media])).toEqual([
      ["clip.mp4", "video"],
      ["loop.gif", "gif"],
    ]);
    expect(sent).toEqual([["art-up-1", "art-up-2"]]);
  });

  it("refuses a file named as a video that is not one, before anything is sent", async () => {
    const shown = await composer(
      () => undefined,
      async () => "art-up-1",
    );
    await attach(shown, new File(["just text"], "clip.mp4"));
    expect(shown.textContent).toContain("clip.mp4: this file is not an MP4, MOV or WebM video.");
    expect(shown.querySelector(".attachment-list")).toBeNull();
  });
});
