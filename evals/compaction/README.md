# Compaction quality eval

`anchors.json` plants things a later turn must still be able to name exactly, in a chat's first turns:
links, file paths (repository-relative and `./`-relative), a git commit hash, a task id, and a request the
person stated once. Each anchor says where it was planted: in the person's message, in a tool's output, or in the
assistant's answer.

`packages/agent-host/test/compaction-quality.eval.test.ts` reads the fixture and drives a chat through the real
workflow adapter with a scripted stub model (each `toolInput` turn makes one echo round trip). Triggers are lowered
so the chat rolls over every few turns, but what an epoch summary keeps follows the shipped rules. Once the latest
request carries the summary of epoch `minRollovers` (3), the test checks that:

- none of the planted turns is still in the request verbatim, so whatever it names, it names through the summary;
- every anchor appears, exactly, in that summary;
- the once-stated request is quoted in it.

It runs with the ordinary test suite (`pnpm test`, or `pnpm exec vitest run test/compaction-quality.eval.test.ts`
from `packages/agent-host`). It is a regression gate, not a quality score. A change that drops an anchor class or
the request fails it.

To add a case, add an anchor to `anchors` and plant its value in one of the `turns`, either in a `prompt`, a
`toolInput` (echoed back as the tool's output) or an `answer`. Keep prompts on one line: the stub finds a turn's
script by the prompt's opening words.

Known limit: earlier summaries are carried forward clipped to 3,000 characters each, nested one inside the
next, so a request quoted in epoch 1 drops out after about eight rollovers. Anchors are carried forward as a list
and last much longer, up to the summary's 80-anchor cap.
