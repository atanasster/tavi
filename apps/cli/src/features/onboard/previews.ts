/**
 * Features shipped as previews: off unless the person turns them on, since
 * they rest on something Tavi does not control.
 *
 * `TAVI_PREVIEW_CHATGPT=1` offers Sign in with ChatGPT in `tavi onboard` and
 * the web canvas's setup: it registers a client with OpenAI's sign-in for a
 * third-party app, which OpenAI may change or stop allowing. Set it for
 * `tavi serve` too, since the owner answers the canvas.
 */
export const CHATGPT_PREVIEW_VARIABLE = "TAVI_PREVIEW_CHATGPT";

/** Whether Sign in with ChatGPT is offered here. */
export function chatGptPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHATGPT_PREVIEW_VARIABLE] === "1";
}
