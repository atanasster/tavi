import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COPIED_RUN_WORDS, FillFactsSchema, createSkillIndex, fillPlan, tailorCheck, type SkillDictionary } from "../src/index.js";

const facts = FillFactsSchema.parse({
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7946 0000",
  location: "London, UK",
  links: [
    { label: "LinkedIn", url: "https://www.linkedin.com/in/ada" },
    { label: "GitHub", url: "https://github.com/ada" },
  ],
  workHistory: ["Analytical Engine, programmer, 1842–1843"],
});
const skills = createSkillIndex(
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "assets", "skills.json"), "utf8")) as SkillDictionary,
);

describe("fill_plan", () => {
  it("fills what the facts and the person's answers hold, leaves protected fields for the person, and guesses nothing else", () => {
    const plan = fillPlan({
      fields: [
        { ref: "e1", label: "First name" },
        { ref: "e2", label: "Last name" },
        { ref: "e3", label: "Email", type: "email" },
        { ref: "e4", label: "Phone", type: "tel" },
        { ref: "e5", label: "GitHub URL" },
        { ref: "e6", label: "Resume/CV", type: "file" },
        { ref: "e7", label: "Why do you want to work here?" },
        { ref: "e8", label: "Gender", name: "gender" },
        { ref: "e9", label: "Choose one", name: "eeo_gender" },
        { ref: "e10", label: "I certify the above is true" },
        { ref: "e11", label: "Notice period in weeks" },
      ],
      facts,
      answers: [{ question: "why do you want to work here", answer: "Because of the engines." }],
    });
    const byRef = new Map(plan.fields.map((field) => [field.ref, field]));
    expect(byRef.get("e1")).toMatchObject({ value: "Ada", source: "facts.firstName" });
    expect(byRef.get("e2")).toMatchObject({ value: "Lovelace" });
    expect(byRef.get("e3")).toMatchObject({ value: "ada@example.com", source: "facts.email" });
    expect(byRef.get("e5")).toMatchObject({ value: "https://github.com/ada", source: "facts.links" });
    expect(byRef.get("e6")).toMatchObject({ kind: "cv_upload", leaveForPerson: expect.stringMatching(/asks the person/) });
    expect(byRef.get("e7")).toMatchObject({ value: "Because of the engines.", source: "answer" });
    for (const ref of ["e8", "e9", "e10"]) expect(byRef.get(ref)?.leaveForPerson, ref).toMatch(/only the person fills it/);
    expect(byRef.get("e11")).toMatchObject({ unmapped: true });
    expect(byRef.get("e11")).not.toHaveProperty("value");
    expect(plan.blocked).toBeUndefined();
  });

  it("guesses nothing for a field that only looks like one it knows, and matches an answer to its own question only", () => {
    const plan = fillPlan({
      fields: [
        { ref: "c", label: "Company name" },
        { ref: "s", label: "School name" },
        { ref: "y", label: "Years of experience" },
        { ref: "l", label: "LinkedIn profile" },
        { ref: "e", label: "Email" },
        { ref: "a", label: "Age" },
        { ref: "w", label: "Website" },
      ],
      facts,
      answers: [
        { question: "May we email you about other roles?", answer: "No thanks" },
        { question: "Which languages do you speak?", answer: "English, French" },
      ],
    });
    const byRef = new Map(plan.fields.map((field) => [field.ref, field]));
    for (const ref of ["c", "s", "y", "a", "w"]) expect(byRef.get(ref), ref).toMatchObject({ unmapped: true });
    expect(byRef.get("l")).toMatchObject({ value: "https://www.linkedin.com/in/ada" });
    expect(byRef.get("e")).toMatchObject({ value: "ada@example.com", source: "facts.email" });
  });

  it("is blocked for a posting with a scam flag, and carries the employer's AI rule", () => {
    expect(fillPlan({ fields: [], facts, answers: [], posting: { flags: ["scam:id"], aiPolicy: "Do not use AI." } })).toMatchObject({
      blocked: true,
      reasons: [expect.stringMatching(/scam:id/)],
      aiPolicy: "Do not use AI.",
    });
  });
});

describe("tailor_check", () => {
  const posting = Array.from({ length: 60 }, (_, index) => `word${String(index)}`).join(" ");
  it("flags a copied run, hidden characters, a claimed skill the profile lacks, and an AI-use answer", () => {
    const copied = posting
      .split(" ")
      .slice(5, 5 + 45)
      .join(" ");
    const kinds = tailorCheck({
      text: `Dear team, ${copied}. I am skilled in Kubernetes.​ I did not use AI to write this.`,
      postingText: posting,
      profileSkills: ["Go"],
      skills,
    }).map((warning) => warning.kind);
    expect(kinds).toEqual(["copied", "hidden-characters", "skill-not-in-profile", "ai-attestation"]);
    expect(COPIED_RUN_WORDS).toBe(40);
  });

  it("finds nothing in a letter of the person's own", () => {
    expect(
      tailorCheck({
        text: "I have built Go services for six years and would love to help.",
        postingText: posting,
        profileSkills: ["Go"],
        skills,
      }),
    ).toEqual([]);
    // A posting whose text retention blanked: the copy check says it did not run.
    expect(
      tailorCheck({ text: "I have built Go services.", postingText: "", profileSkills: ["Go"], skills }).map((warning) => warning.kind),
    ).toEqual(["posting-text-gone"]);
  });
});
