import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { allowUntilEnded, footOf, promptSent, readFromTheTop, recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer, restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/**
 * A made-up forum thread: a firm moving to three office days a week, and what its readers say. Every name is invented,
 * and the comments fall into a few arguments on each side, as a busy thread's do.
 */
const COMMENTS: readonly (readonly [string, string])[] = [
  ["fernhollow", "My commute is 70 minutes each way. Three office days means almost nine hours a week on a train I pay for myself."],
  [
    "tidepool_dev",
    "Train fares went up again this year. Nobody is offering to cover the commute cost, so it is a pay cut by another name.",
  ],
  ["maplebyte", "Commuting three days a week costs me more in fuel and parking than my last raise. The commute is the real problem."],
  ["gravel_and_ink", "The commute alone kills it for me. Two hours of travel a day is two hours I used to spend working or with my kids."],
  ["oatmilk_otter", "If they paid for the commute, train or parking, I would not mind the office days half as much."],
  ["lanternfish9", "People who live near the office love this. Those of us with a long commute are paying for it in time and money."],
  ["quietkestrel", "I get far more focused work done at home. The open-plan office is noise, meetings and people stopping by my desk."],
  ["spreadsheet_owl", "Open-plan offices are terrible for focus. I wear headphones all day there just to get any deep work done."],
  [
    "northwind_rae",
    "Every office day turns into back-to-back calls from a noisy desk. I do my real focused work at home in the evening anyway.",
  ],
  ["pebble_theory", "Deep work needs quiet. The office has none, so office days are for meetings and home days are for focus."],
  ["cobaltfinch", "Our team measured it: fewer bugs shipped in the remote year. Focus at home is not a myth."],
  [
    "junebug_codes",
    "As a junior I learned more in three months in the office than in a year remote. You pick things up by overhearing seniors.",
  ],
  ["harbourlight", "Mentoring juniors over video is hard. Office days give new starters someone to ask without booking a call."],
  ["tinroof_tess", "New starters on my team were lost when we were fully remote. Mentoring and onboarding work better in person."],
  [
    "sorrel_and_sage",
    "I was hired remote and felt invisible for a year. Being in the office with my team helped me learn and get noticed.",
  ],
  [
    "windowseat_kai",
    "Whiteboard sessions and quick questions at a desk beat any video call for mentoring juniors and solving problems together.",
  ],
  ["mossgarden", "Collaboration is better in person. The best ideas on our team came from conversations in the office kitchen."],
  [
    "bramble_ops",
    "School pickup is at three. With three fixed office days I cannot do pickup, and childcare after school costs a fortune.",
  ],
  ["kettle_on_kim", "Flexibility was the reason I took this job. I care for my dad, and fixed office days make that much harder."],
  ["duskrunner", "Parents and carers are the ones who lose here. Childcare does not fit around a fixed office schedule."],
  ["paperlantern_jo", "Remote work let me manage childcare and a full-time job. Three fixed days will push some parents out entirely."],
  ["saltmarsh_sam", "Let teams choose their own office days. Fixed days ignore childcare, caring and everyone's different lives."],
  ["ironbark_lee", "This is about the expensive office lease, not productivity. Management wants the building to look full."],
  ["thistledown", "If management trusted us, they would measure results, not desk time. This is about control and trust."],
  ["copperkettle", "Nobody has shown any data that office days improve anything. It feels like management does not trust remote staff."],
  ["glasswing_ana", "They signed a long lease on a big office and now need people in it. Call it what it is."],
  ["riverstone_max", "Watching badge swipes is not management. Trust people and judge the work they deliver."],
  ["hazelnut_hal", "Does anyone know if the canteen is reopening on the fourth floor?"],
  ["lowtide_lou", "First!"],
  ["bluefern", "Honestly I just want a desk with a working monitor, whatever the policy is."],
];

/** The thread, drawn as a forum page draws one: who said it, and what. */
const FORUM = {
  name: "Watercooler Commons",
  colour: "#2f5d62",
  pages: {
    "/threads/three-office-days": {
      title: "Our company is moving to three office days a week. Good idea?",
      html:
        "<h2>Our company is moving to three office days a week. Good idea?</h2>" +
        `<p>${COMMENTS.length} comments</p>` +
        COMMENTS.map(([who, said]) => `<article><p><strong>${who}</strong></p><p>${said}</p></article>`).join(""),
    },
  },
};

let page: Page;
let site: TestSite;

walkGuide("everyday/work-and-career/comment-clusters", {
  configured: true,
  model: true,
  timeoutMs: 600_000,
  steps: {
    "ask-for-it": async (walk) => {
      site = await testSite(FORUM);
      // The forum is on this computer, which the browser opens only once listed.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      page = await promptSent(walk, recipePrompt("work.comment-clusters", { link: `${site.origin}/threads/three-office-days` }));
    },
    "let-it-open-the-page": async (walk) => {
      const round = page.locator("section.round").last();
      await round.getByRole("button", { name: "Allow for this chat" }).waitFor({ timeout: 180_000 });
      await shotAlone(walk, round);
      await allowUntilEnded(page, 360_000);
    },
    "read-the-result": async (walk) => {
      // It read the thread itself, in the browser.
      expect(site.requests).toContain("GET /threads/three-office-days");
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      expect(
        tools.some((call) => call.toolName === "browser.read" || call.toolName === "browser.extract"),
        "the page was read in the browser",
      ).toBe(true);
      const text = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      // The thread's arguments, whatever the words: the cost of the commute, focus, juniors learning, childcare, trust.
      for (const theme of [
        /commut/i,
        /focus|deep work|nois/i,
        /mentor|junior|onboard|new (starter|hire)/i,
        /child ?care|carer|caring|pickup/i,
        /trust|lease|control/i,
      ]) {
        expect(text).toMatch(theme);
      }
      expect(text, "the side for it").toMatch(/\b(in favou?r|support\w*|pros?)\b|\bfor\b[^.\n]{0,30}\b(office|policy|mandate|days)\b/i);
      expect(text, "the side against it").toMatch(/\b(against|oppos\w*|cons)\b/i);
      // A name it gives is one on the page, not one it made up.
      const names = new Set(COMMENTS.map(([who]) => who));
      const handles = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+\d+\b/g)].map(([handle]) => handle);
      expect(handles.filter((handle) => !names.has(handle))).toEqual([]);
      // A long answer is pictured from its top, down to the end of a whole list: its themes, a picture under 250 KB.
      const answer = await lastAnswer(page);
      if (((await answer.boundingBox())?.height ?? 0) > 1200)
        await readFromTheTop(walk, page, await footOf(answer, ".markdown > ul, .markdown > ol", 1100));
      else await wholeAnswer(walk, page);
    },
  },
});
