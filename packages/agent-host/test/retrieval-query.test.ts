import { describe, expect, it } from "vitest";

import { MEMORY_SEMANTIC_QUERY_MAX_CHARS } from "@tavi/contracts";
import {
  isSubstantiveMessage,
  parseTemporalQueryRange,
  queryExpansionFor,
  retrievalKeywordsFrom,
  retrievalQueryFrom,
  semanticQueryFrom,
  substantiveKeywordCount,
  turnRetrievalQueryFrom,
} from "@tavi/agent-host/workflow";

/**
 * The shared keyword builder and the turn's hybrid query: a Chinese, Japanese
 * or Korean word shorter than 3 characters, a 2-letter uppercase ASCII acronym
 * or a 2-digit number is kept as a keyword, other short Latin words are
 * not, and no bigrams are made (those are past-chat search's); the text hybrid
 * recall embeds is the person's newest message, bounded.
 */

describe("retrievalKeywordsFrom", () => {
  it("keeps a short CJK word written on its own, and still drops short lowercase Latin words and stopwords", () => {
    expect(retrievalKeywordsFrom("住所は 東京 です")).toEqual(["住所は", "東京", "です"]);
    expect(retrievalKeywordsFrom("我 爱 猫")).toEqual(["我", "爱", "猫"]);
    expect(retrievalKeywordsFrom("회사 위치")).toEqual(["회사", "위치"]);
    expect(retrievalKeywordsFrom("カメラ、ペン。")).toEqual(["カメラ", "ペン"]);
    expect(retrievalKeywordsFrom("an ox is ok")).toEqual([]);
    // An unspaced sentence stays one term: no bigrams for memory.
    expect(retrievalKeywordsFrom("明日東京で会議")).toEqual(["明日東京で会議"]);
  });

  it("with bigrams (past-chat search), adds each CJK run's overlapping 2-character pieces after the whole terms, within the bounds", () => {
    expect(retrievalKeywordsFrom("明日東京で会議", { bigrams: true })).toEqual([
      "明日東京で会議",
      "明日",
      "日東",
      "東京",
      "京で",
      "で会",
      "会議",
    ]);
    // A 2-character run is already its own bigram; Latin words get none; a repeated piece is one keyword.
    expect(retrievalKeywordsFrom("東京 budget 東京都", { bigrams: true })).toEqual(["東京", "budget", "東京都", "京都"]);
    expect(retrievalKeywordsFrom("회사에서 일해요", { bigrams: true })).toEqual([
      "회사에서",
      "일해요",
      "회사",
      "사에",
      "에서",
      "일해",
      "해요",
    ]);
    expect(retrievalKeywordsFrom("明日東京で会議", { bigrams: true, maxTerms: 3 })).toEqual(["明日東京で会議", "明日", "日東"]);
  });

  it("feeds the turn's query unchanged otherwise", () => {
    expect(retrievalQueryFrom([{ id: "input-1", role: "user", text: "Where is 東京 office?" }])).toBe("東京 office");
  });

  it("keeps 2-letter uppercase acronyms and 2-digit numbers, drops OK/NO/SO and all-caps 2-letter words, and filters multilingual stopwords", () => {
    expect(retrievalKeywordsFrom("What about AI and QA in the UK or US on PR 42?")).toEqual(["ai", "qa", "uk", "us", "pr", "42"]);
    expect(retrievalKeywordsFrom("Is IT or GO used? OK NO SO")).toEqual(["it", "go"]);
    expect(retrievalKeywordsFrom("WHAT ABOUT AI IN THE UK")).toEqual([]);
    expect(retrievalKeywordsFrom("WHAT ABOUT AI IN THE UK OFFICE")).toEqual(["office"]);
    expect(substantiveKeywordCount("ok")).toBe(0);
    expect(substantiveKeywordCount("OK")).toBe(0);
    expect(substantiveKeywordCount("thanks")).toBe(0);
    expect(isSubstantiveMessage("ok thanks")).toBe(false);
    expect(retrievalKeywordsFrom("les une dans avec der das und ist los las por uma uns das gli dei een voor niet Berlin")).toEqual([
      "berlin",
    ]);
    expect(
      retrievalKeywordsFrom(
        "What's my dog's name? Didn't, wouldn't, couldn't, shouldn't, wasn't, weren't, hasn't, haven't, hadn't, isn't, aren't, won't, doesn't, don't, mustn't, mightn't, let's check",
      ),
    ).toEqual(["dog", "name", "check"]);
  });

  it("drops Bulgarian function words and keeps Bulgarian content words", () => {
    expect(retrievalKeywordsFrom("Какво мислиш за моята нова работа в София?")).toEqual(["мислиш", "моята", "нова", "работа", "софия"]);
    expect(retrievalKeywordsFrom("Може ли това да стане след вечеря")).toEqual(["стане", "вечеря"]);
    expect(isSubstantiveMessage("благодаря много")).toBe(false);
  });

  it("keeps English names and words that are function words elsewhere", () => {
    expect(retrievalKeywordsFrom("What did Dan say about Mia's school and Sue?")).toEqual(["dan", "say", "mia", "school", "sue"]);
    expect(retrievalKeywordsFrom("Is my MIT application due?")).toEqual(["mit", "application", "due"]);
    expect(retrievalKeywordsFrom("den die aus con sin una dal plus sans met todo como")).toEqual([
      "den",
      "die",
      "aus",
      "con",
      "sin",
      "una",
      "dal",
      "plus",
      "sans",
      "met",
      "todo",
      "como",
    ]);
  });

  it("never reads an all-caps contraction as an acronym", () => {
    expect(retrievalKeywordsFrom("I DON'T like it, WE'RE done, IT'S late, CAN'T stay, WON'T go, HE'S out")).toEqual(["late", "stay"]);
    expect(retrievalKeywordsFrom("Does IT approve PR 7?")).toEqual(["it", "approve", "pr"]);
  });

  it("keeps a capitalised acronym beside uncased or non-Latin scripts", () => {
    expect(retrievalKeywordsFrom("Что такое AI")).toEqual(["что", "такое", "ai"]);
    expect(retrievalKeywordsFrom("AIについて教えて")).toEqual(["ai", "について教えて"]);
    expect(retrievalKeywordsFrom("WHAT IS AI")).toEqual([]);
  });
});

describe("the no-embedding query expansion", () => {
  it("adds diet and allergy words to a food question, and nothing to an unrelated one", () => {
    const added = queryExpansionFor("Suggest a quick dinner I could cook tonight");
    expect(added).toContain("vegetarian");
    expect(added).toContain("allergy");
    expect(added).toContain("diet");
    expect(queryExpansionFor("Any recipes for Sunday?")).toContain("vegan");
    expect(queryExpansionFor("Where do I live now?")).toEqual([]);
    expect(queryExpansionFor("")).toEqual([]);
    // A word the person already wrote is not added twice.
    expect(queryExpansionFor("vegetarian dinner ideas")).not.toContain("vegetarian");
  });

  it("puts the expansion after the person's own keywords, in the turn's lexical query only", () => {
    const conversation = [{ id: "input-1", role: "user" as const, text: "Suggest a quick dinner I could cook tonight" }];
    const query = turnRetrievalQueryFrom(conversation)!;
    expect(query.keywords.startsWith(`${retrievalQueryFrom(conversation)} `)).toBe(true);
    expect(query.keywords.split(" ")).toContain("vegetarian");
    expect(query.semantic).toBe("Suggest a quick dinner I could cook tonight");
    expect(turnRetrievalQueryFrom([{ id: "input-1", role: "user", text: "Where do I live now?" }])?.keywords).toBe("live");
  });

  it("is triggered by the person's newest message only, never by the assistant's answer or an earlier turn", () => {
    const conversation = [
      { id: "input-1", role: "user" as const, text: "Give me a recipe for lasagne" },
      { id: "answer-1", role: "assistant" as const, text: "Here is a dinner recipe." },
      { id: "input-2", role: "user" as const, text: "What time is my dentist appointment?" },
    ];
    expect(turnRetrievalQueryFrom(conversation)?.keywords.split(" ")).not.toContain("vegetarian");
  });

  it("stays within the search's 512 characters", () => {
    const long = Array.from({ length: 23 }, (_, index) => `word${"x".repeat(14)}${index}`).join(" ");
    const conversation = [{ id: "input-1", role: "user" as const, text: `${long} dinner` }];
    const keywords = turnRetrievalQueryFrom(conversation)!.keywords;
    expect(keywords.length).toBeLessThanOrEqual(512);
    expect(keywords.split(" ")).toContain("dinner");
  });
});

describe("the turn's hybrid query", () => {
  it("is the person's newest message, trimmed and bounded, beside the keywords", () => {
    const long = "a".repeat(MEMORY_SEMANTIC_QUERY_MAX_CHARS + 50);
    const conversation = [
      { id: "input-1", role: "user" as const, text: "I moved to Lisbon" },
      { id: "answer-1", role: "assistant" as const, text: "Noted." },
      { id: "input-2", role: "user" as const, text: `  where do I live now? ${long}` },
    ];
    const semantic = semanticQueryFrom(conversation)!;
    expect([...semantic]).toHaveLength(MEMORY_SEMANTIC_QUERY_MAX_CHARS);
    expect(semantic.startsWith("where do I live now?")).toBe(true);
    expect(turnRetrievalQueryFrom(conversation)).toEqual({ keywords: retrievalQueryFrom(conversation), semantic });
    expect(semanticQueryFrom([{ id: "answer-1", role: "assistant", text: "Only an answer" }])).toBeUndefined();
    // No keyword: the message alone, for hybrid recall by meaning; lexical recall answers no hits.
    expect(turnRetrievalQueryFrom([{ id: "input-1", role: "user", text: "a an of" }])).toEqual({ keywords: "", semantic: "a an of" });
    expect(turnRetrievalQueryFrom([{ id: "answer-1", role: "assistant", text: "Only an answer" }])).toBeUndefined();
  });

  it("appends the previous person message when the newest person message has fewer than 3 keywords or under 60 characters", () => {
    const followUp = [
      { id: "input-1", role: "user" as const, text: "Tell me about my sister Ana." },
      { id: "answer-1", role: "assistant" as const, text: "Ana lives in Coimbra." },
      { id: "input-2", role: "user" as const, text: "When is her birthday?" },
    ];
    expect(semanticQueryFrom(followUp)).toBe("When is her birthday?\nTell me about my sister Ana.");

    // Fewer than 3 keywords even when >= 60 characters also appends the previous person message.
    const paddedFewKeywords = `${"the and for with from into ".repeat(3)}birthday?`;
    expect(paddedFewKeywords.length).toBeGreaterThanOrEqual(60);
    expect(retrievalKeywordsFrom(paddedFewKeywords)).toEqual(["birthday"]);
    expect(
      semanticQueryFrom([
        { id: "input-1", role: "user" as const, text: "Tell me about my sister Ana." },
        { id: "input-2", role: "user" as const, text: paddedFewKeywords },
      ]),
    ).toBe(`${paddedFewKeywords}\nTell me about my sister Ana.`);

    // At least 60 characters and at least 3 keywords keeps only the newest person message.
    const selfContained = "Which quarterly deployment checklist covers staging database migrations for our European production cluster?";
    expect(selfContained.length).toBeGreaterThanOrEqual(60);
    expect(retrievalKeywordsFrom(selfContained).length).toBeGreaterThanOrEqual(3);
    expect(
      semanticQueryFrom([
        { id: "input-1", role: "user" as const, text: "Earlier unrelated topic about vacations." },
        { id: "input-2", role: "user" as const, text: selfContained },
      ]),
    ).toBe(selfContained);
  });

  it("parses deterministic temporal query ranges in English and six European languages, honouring timeZone and Reference date prefixes", () => {
    const now = "2026-10-14T12:00:00.000Z";
    expect(parseTemporalQueryRange("What did I do yesterday?", now)).toEqual({
      from: "2026-10-13T00:00:00.000Z",
      to: "2026-10-13T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Que faisais-je hier ?", now)).toEqual({
      from: "2026-10-13T00:00:00.000Z",
      to: "2026-10-13T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Was habe ich gestern gemacht?", now)).toEqual({
      from: "2026-10-13T00:00:00.000Z",
      to: "2026-10-13T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Where did I travel in March?", now)).toEqual({
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Which gym have I gone to since June?", now)).toEqual({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-10-14T23:59:59.999Z",
      pastOnly: false,
    });
    expect(parseTemporalQueryRange("Where did I live two years ago?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Où habitais-je il y a deux ans ?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Wo wohnte ich vor zwei Jahren?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("¿Dónde vivía hace dos años?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Onde eu morava há dois anos?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Dove abitavo due anni fa?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Waar woonde ik twee jaar geleden?", now)).toEqual({
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T23:59:59.999Z",
      pastOnly: true,
    });

    // Reference date prefix overrides `now` (or works without `now`).
    expect(parseTemporalQueryRange("Reference date: 2026-05-10\nWhat did I do yesterday?")).toEqual({
      from: "2026-05-09T00:00:00.000Z",
      to: "2026-05-09T23:59:59.999Z",
      pastOnly: true,
    });

    // Time zone shifts the local calendar date at 2026-10-14T23:30:00.000Z -> 2026-10-15 in Asia/Tokyo,
    // and each boundary is a Tokyo midnight.
    expect(parseTemporalQueryRange("What happened yesterday?", "2026-10-14T23:30:00.000Z", "Asia/Tokyo")).toEqual({
      from: "2026-10-13T15:00:00.000Z",
      to: "2026-10-14T14:59:59.999Z",
      pastOnly: true,
    });

    // Past-history cues ("Where did I live before Porto?") vs non-temporal "before" habits/rules.
    expect(parseTemporalQueryRange("Where did I live before Porto?", now)).toEqual({
      from: "1970-01-01T00:00:00.000Z",
      to: "2026-10-13T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("What coffee do I drink before standup?", now)).toBeUndefined();
    expect(parseTemporalQueryRange("What check must run before creating a git commit?", now)).toBeUndefined();
    expect(parseTemporalQueryRange("How many days did my spring trip to Madrid last?", now)).toBeUndefined();

    // `turnRetrievalQueryFrom` attaches `range` when `now` is passed.
    const turnQuery = turnRetrievalQueryFrom([{ id: "u1", role: "user", text: "Where did I live before Porto?" }], { now });
    expect(turnQuery?.range).toEqual({
      from: "1970-01-01T00:00:00.000Z",
      to: "2026-10-13T23:59:59.999Z",
      pastOnly: true,
    });
  });

  it("puts each boundary at a midnight in the workspace zone, across a DST change", () => {
    expect(parseTemporalQueryRange("What did I do yesterday?", "2026-10-14T12:00:00.000Z", "America/Los_Angeles")).toEqual({
      from: "2026-10-13T07:00:00.000Z",
      to: "2026-10-14T06:59:59.999Z",
      pastOnly: true,
    });
    // Lisbon leaves summer time on Sunday 2026-10-25: that day starts at UTC+1 and ends at UTC+0.
    expect(parseTemporalQueryRange("What did I do yesterday?", "2026-10-26T12:00:00.000Z", "Europe/Lisbon")).toEqual({
      from: "2026-10-24T23:00:00.000Z",
      to: "2026-10-25T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Where did I travel in March?", "2026-10-14T12:00:00.000Z", "Asia/Tokyo")).toEqual({
      from: "2026-02-28T15:00:00.000Z",
      to: "2026-03-31T14:59:59.999Z",
      pastOnly: true,
    });
    // An unknown zone falls back to UTC.
    expect(parseTemporalQueryRange("What did I do yesterday?", "2026-10-14T12:00:00.000Z", "Not/AZone")?.from).toBe(
      "2026-10-13T00:00:00.000Z",
    );
  });

  it("reads last <Month> as the most recent one and last week as the previous Monday-to-Sunday week", () => {
    const now = "2026-10-14T12:00:00.000Z"; // a Wednesday
    expect(parseTemporalQueryRange("Where did I go last March?", now)).toEqual({
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("Where did I go last December?", now)?.from).toBe("2025-12-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Where did I go last October?", now)?.from).toBe("2025-10-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("What did I cook last week?", now)).toEqual({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-11T23:59:59.999Z",
      pastOnly: true,
    });
    expect(parseTemporalQueryRange("What did I cook last week?", "2026-10-12T09:00:00.000Z")?.from).toBe("2026-10-05T00:00:00.000Z");
  });

  it("lets nothing in the person's text but a leading Reference date line move the clock", () => {
    const now = "2026-10-14T12:00:00.000Z";
    // A date the person writes is a day asked about, never "today": yesterday stays relative to `now`.
    expect(parseTemporalQueryRange("Today is 2026-05-10. What did I do yesterday?", now)?.from).toBe("2026-05-10T00:00:00.000Z");
    expect(parseTemporalQueryRange("Today is 2026-05-10. What did I do yesterday?", now)?.from).not.toBe("2026-05-09T00:00:00.000Z");
    expect(parseTemporalQueryRange("Question: What did I do yesterday?\n\nAnswer briefly", now)?.from).toBe("2026-10-13T00:00:00.000Z");
    expect(parseTemporalQueryRange("Please note:\nReference date: 2026-05-10\nWhat did I do yesterday?", now)?.from).not.toBe(
      "2026-05-09T00:00:00.000Z",
    );
  });

  it("reads Bulgarian dates and ranges, with Cyrillic words bounded as words", () => {
    const now = "2026-10-14T12:00:00.000Z"; // a Wednesday
    const range = (text: string) => parseTemporalQueryRange(text, now);
    expect(range("Какво правих вчера?")).toEqual({ from: "2026-10-13T00:00:00.000Z", to: "2026-10-13T23:59:59.999Z", pastOnly: true });
    expect(range("Къде бях завчера?")?.from).toBe("2026-10-12T00:00:00.000Z");
    expect(range("Какво казах онзи ден?")?.from).toBe("2026-10-12T00:00:00.000Z");
    expect(range("Какво сготвих миналата седмица?")).toEqual({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-11T23:59:59.999Z",
      pastOnly: true,
    });
    expect(range("Какво купих миналия месец?")).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T23:59:59.999Z",
      pastOnly: true,
    });
    expect(range("Къде пътувах миналата година?")?.from).toBe("2025-01-01T00:00:00.000Z");
    expect(range("Къде бях лани?")?.from).toBe("2025-01-01T00:00:00.000Z");
    // "преди <N> <unit>", the count as a figure, a word or left out.
    expect(range("Какво реших преди 3 дни?")?.from).toBe("2026-10-10T00:00:00.000Z");
    expect(range("Какво реших преди три дни?")?.from).toBe("2026-10-10T00:00:00.000Z");
    expect(range("С кого говорих преди две седмици?")?.from).toBe(range("Who did I talk to 2 weeks ago?")?.from);
    expect(range("Какво казах преди два месеца?")?.from).toBe("2026-08-01T00:00:00.000Z");
    expect(range("Какво казах преди месец?")?.from).toBe(range("What did I say 1 month ago?")?.from);
    expect(range("Къде живеех преди година?")?.from).toBe("2025-01-01T00:00:00.000Z");
    // This week, month and year: up to the end of today.
    expect(range("Какво съм планирал тази седмица?")).toEqual({
      from: "2026-10-12T00:00:00.000Z",
      to: "2026-10-14T23:59:59.999Z",
      pastOnly: false,
    });
    expect(range("Колко похарчих този месец?")?.from).toBe("2026-10-01T00:00:00.000Z");
    expect(range("Какво прочетох тази година?")).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-10-14T23:59:59.999Z",
      pastOnly: false,
    });
    // Months: "през", "в", "миналия", "от" (since), with a year written with or without "г.".
    expect(range("Къде бях през март?")).toEqual({ from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z", pastOnly: true });
    expect(range("Къде бях в декември?")?.from).toBe("2025-12-01T00:00:00.000Z");
    expect(range("Къде ходих миналия октомври?")?.from).toBe("2025-10-01T00:00:00.000Z");
    expect(range("Какво стана през май 2024 г.?")?.from).toBe("2024-05-01T00:00:00.000Z");
    expect(range("Какво стана януари 2025?")?.from).toBe("2025-01-01T00:00:00.000Z");
    expect(range("Какво стана яну 2025?")?.from).toBe("2025-01-01T00:00:00.000Z");
    expect(range("Какво се промени от февруари?")).toEqual({
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-10-14T23:59:59.999Z",
      pastOnly: false,
    });
    expect(range("Какво се промени от 2020 г.?")?.from).toBe("2020-01-01T00:00:00.000Z");
    expect(range("Къде живеех през 2019 година?")?.from).toBe("2019-01-01T00:00:00.000Z");
    expect(range("Къде живеех в 2019?")?.from).toBe("2019-01-01T00:00:00.000Z");
    // Past history: "навремето", or a past verb with "преди" and a name.
    expect(range("Къде живеех преди Порто?")?.pastOnly).toBe(true);
    expect(range("Преди Порто къде живеех?")?.pastOnly).toBe(true);
    expect(range("Къде работех навремето?")?.pastOnly).toBe(true);
    expect(range("Къде живеех преди да се преместя?")?.pastOnly).toBe(true);
    // Words that only look like a date are not one.
    for (const text of [
      "Май ще вали утре",
      "Ное е в ковчега",
      "Направи го за пет дни",
      "Струва от 2000 лева",
      "В 2000 години ще има промени",
      "Провери вчерашния отчет",
      "Ела преди обяд",
      "Какво мислиш за плана?",
      "Пожелай ми успех преди Коледа",
      "Имам страх преди Изпита",
      // A plural with no count is no number, as English "years ago" is not.
      "Какво правих преди години?",
      "Какво правих преди дни?",
      "What did I do years ago?",
    ]) {
      expect(range(text), text).toBeUndefined();
    }
  });

  it("does not read a date into words that only look like one", () => {
    const now = "2026-10-14T12:00:00.000Z";
    for (const text of [
      "Was hast du hier gemacht?",
      "Wat doe je hier met de kinderen?",
      "Did the tests pass before merging?",
      "Did I check the logs before the deploy?",
      "Did I deploy before noon?",
      "Kannst du früher kommen?",
      "Bel me voordat ik vertrek",
      "Summarise it in 2000 words",
      "Explain it in 1984 terms",
      "Il faut le faire en sept jours",
      "What did the rover find in Mars soil?",
      "What was in Jan's message?",
      "Cosa fa da Marco?",
      "since 2000 users signed up, what changed?",
    ]) {
      expect(parseTemporalQueryRange(text, now), text).toBeUndefined();
    }
    // The unambiguous forms still parse.
    expect(parseTemporalQueryRange("Qu'ai-je fait hier soir ?", now)?.from).toBe("2026-10-13T00:00:00.000Z");
    expect(parseTemporalQueryRange("Wo habe ich früher gewohnt?", now)?.pastOnly).toBe(true);
    expect(parseTemporalQueryRange("Waar woonde ik vroeger?", now)?.pastOnly).toBe(true);
    expect(parseTemporalQueryRange("Where did I live before I moved to Porto?", now)?.pastOnly).toBe(true);
    expect(parseTemporalQueryRange("Which company did I work at before joining Contoso?", now)?.pastOnly).toBe(true);
    expect(parseTemporalQueryRange("Where did I live in 2019?", now)?.from).toBe("2019-01-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Where was I in Jan 2025?", now)?.from).toBe("2025-01-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Où étais-je en mars ?", now)?.from).toBe("2026-03-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Wo war ich im Mai?", now)?.from).toBe("2026-05-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Waar was ik in mei?", now)?.from).toBe("2026-05-01T00:00:00.000Z");
    expect(parseTemporalQueryRange("Dove sono stato dal marzo?", now)?.from).toBe("2026-03-01T00:00:00.000Z");
  });
});
