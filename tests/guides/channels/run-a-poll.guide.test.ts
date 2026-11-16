import { expect } from "vitest";

import { toolsCalled } from "../support/extend.js";
import { chatPage, pollAskedInTheRoom, pollPosted, waitingCard, waitingFor } from "../support/rooms.js";
import { turnEnded } from "../support/steps.js";
import { askUser } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "channels/run-a-poll";

let taskId = "";

/** The room chat's newest approval card, for the step's picture. */
const card = async (walk: Parameters<typeof waitingCard>[0]): Promise<{ round: Awaited<ReturnType<typeof waitingCard>> }> => ({
  round: await waitingCard(walk, taskId),
});

walkGuide(GUIDE, {
  configured: true,
  model: true,
  steps: {
    "ask-for-a-poll-in-the-room": async (walk) => {
      // Before you start: the bot on the person's server, with its room, and the person allowed.
      taskId = await pollAskedInTheRoom(
        walk,
        GUIDE,
        "@<your bot> Run a poll: pizza or tacos for Friday's lunch? Keep it open for an hour.",
      );
      const { round } = await card(walk);
      await walk.shot(round);
    },
    "approve-it": async (walk) => {
      const page = await pollPosted(walk, taskId);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "let-people-vote-then-close-it": async (walk) => {
      await askUser(
        GUIDE,
        "Vote in the poll, then in the room write: @<your bot> End the poll now and tell us the results.",
        () => waitingFor(walk, "messaging.end_poll") !== undefined,
      );
      const { round } = await card(walk);
      await walk.shot(round);
    },
    "read-the-results": async (walk) => {
      const { round } = await card(walk);
      await round.getByRole("button", { name: "Allow once" }).click();
      const page = await chatPage(walk, taskId);
      await turnEnded(page);
      await expect.poll(() => toolsCalled(walk, taskId), { timeout: 180_000, interval: 3_000 }).toContain("messaging.poll_results");
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
  },
});
