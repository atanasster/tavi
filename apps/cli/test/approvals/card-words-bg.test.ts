import { labelSummary, untrustedLabel, type PendingApprovalRow } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import {
  assessBrowserBatch,
  assessBrowserNavigate,
  assessDesktopAct,
  assessHttpRequest,
  assessMessagingSend,
  assessSandboxRun,
  assessWebSearch,
  type ObservedElement,
} from "../../src/features/approvals/call-assessors.js";
import { cardKind, cardReason, cardWords } from "../../src/features/approvals/card-words.js";
import { approvalListRowOf } from "../../src/features/approvals/inbox.js";
import { analyzerAssessment } from "../../src/features/video/tools.js";

/** An approval card in the workspace's language; what the model reads, and an English card, as they were. */

const bg = coreIn("bg");

describe("approval cards in Bulgarian", () => {
  it("says a sandbox run's title, detail and reasons in the workspace's language", () => {
    expect(assessSandboxRun({ command: "ls", args: ["-la"] }, { locale: "bg" }).display.title).toBe("Пусни „ls -la“ в изолираната среда");
    const reaching = assessSandboxRun({ command: "rm", args: ["-rf", "/tmp/x"], requestDomains: ["example.com"] }, { locale: "bg" });
    expect(reaching.display.title).toBe("Пусни „rm -rf /tmp/x“ в изолираната среда с достъп до example.com");
    expect(reaching.reasons).toEqual([
      "изтрива файлове рекурсивно",
      "изтрива или изпразва файлове",
      "иска достъп до example.com за това изпълнение",
    ]);
    // What it decides by is the same in either language.
    const english = assessSandboxRun({ command: "rm", args: ["-rf", "/tmp/x"], requestDomains: ["example.com"] });
    expect({ ...reaching, display: undefined, reasons: undefined }).toEqual({ ...english, display: undefined, reasons: undefined });
    expect(english.display.title).toBe("Run “rm -rf /tmp/x” in the sandbox, reaching example.com");
    const opaque = assessSandboxRun({ command: "sh", args: ["-c", "echo $(date) && ls"] }, { locale: "bg" });
    expect(opaque.display.detail).toBe(
      "Питам всеки път, защото командата изпълнява заместване на команда. Разделена на отделни команди без тези неща, може да се разреши завинаги",
    );
    expect(opaque.reasons).toEqual(["изпълнява заместване на команда"]);
  });

  it("says a request, a search and a reply in Bulgarian", () => {
    const request = assessHttpRequest({ method: "POST", url: "https://api.example.com/x", body: "{}" }, bg);
    expect(request.display).toMatchObject({ title: "POST api.example.com", detail: "Тяло: {}" });
    expect(request.reasons).toEqual(["изпраща заявка POST, която може да промени отдалечени данни"]);
    const search = assessWebSearch({ query: "weather sofia", site: "example.com", recency: "week" }, bg);
    expect(search.display.title).toBe("Търси в мрежата „weather sofia“ в example.com, от последната седмица");
    expect(search.display.detail).toBe("Търсене: weather sofia\nСайт: example.com\nПериод: седмица");
    expect(assessWebSearch({ query: "q", recency: "week" }).display.detail).toBe("Query: q\nRecency: week");
    expect(search.reasons).toEqual(["изпраща търсенето до доставчик на търсене"]);
    const secret = assessWebSearch({ query: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, bg);
    expect(secret.reasons).toContain(
      "търсенето съдържа нещо, което прилича на таен ключ (api-key): търсенето би го изпратило до доставчика на търсене",
    );
    expect(assessMessagingSend({ content: "hi" }, { locale: "bg" }).display.title).toBe("Отговори в този разговор");
  });

  it("says browser and desktop actions in Bulgarian", () => {
    expect(assessBrowserNavigate({ sessionId: "s", url: "https://example.com/a" }, bg).display.title).toBe(
      "Отвори example.com/a в браузъра",
    );
    const batch = assessBrowserBatch(
      {
        sessionId: "s",
        actions: [
          { kind: "type", ref: "e1", epoch: 1, value: "Sofia" },
          { kind: "scroll", value: "down" },
        ],
      },
      undefined,
      undefined,
      bg,
    );
    expect(batch.display).toEqual({ title: "Браузър: въвеждане в поле, превъртане", detail: "Стъпка 1 ← Sofia" });
    const typed = assessDesktopAct(
      { kind: "type", app: "Notes", bundleId: "com.apple.Notes", ref: "ax-1", text: "hello" },
      { role: "AXTextArea", title: "Body" } as never,
      () => "full",
      bg,
    );
    expect(typed.display).toEqual({ title: "Работен плот: писане в „Body“ в Notes", detail: "Текст: hello" });
    expect(typed.reasons).toEqual(["управлява настолно приложение"]);
  });

  it("keeps what the model reads in English: a refusal is never translated", () => {
    const batch = { sessionId: "s", actions: Array.from({ length: 40 }, () => ({ kind: "scroll", value: "down" })) };
    const element = { ref: "e1", role: "button" } as unknown as ObservedElement;
    const refused = assessBrowserBatch(batch, () => element, undefined, bg).hardDeny;
    expect(refused).toMatch(/^a batch of more than/);
    expect(refused).toBe(assessBrowserBatch(batch, () => element).hardDeny);
  });

  it("is English, as it always was, with no language or English given", () => {
    expect(cardWords()).toBe(cardWords({ locale: "en" }));
    expect(cardReason("deletes files recursively", cardWords())).toBe("deletes files recursively");
    expect(cardReason("deletes files recursively", bg)).toBe("изтрива файлове рекурсивно");
    // A reason with names in it, which no key says, stays as written.
    expect(cardReason("Ada is a blocked desktop application", bg)).toBe("Ada is a blocked desktop application");
    expect(cardKind("click", bg)).toBe("натискане");
    expect(cardKind("pinch", bg)).toBe("pinch");
  });
});

describe("a video analyser's card in Bulgarian", () => {
  it("names the remote analyser and where the video goes in the workspace's words", () => {
    const remote = {
      first: () => ({ manifest: () => ({ id: "cloud-ocr", local: false, attribution: { name: "Cloud OCR" } }) }),
    } as never;
    const context = { workspaceId: "w", principalId: "p", runId: "r", caller: "test" };
    const said = analyzerAssessment(remote, { capability: "ocr", frames: 1 }, { ...context, locale: "bg" }, "Прочети текста");
    expect(said.display).toEqual({
      title: "Прочети текста с cloud-ocr",
      destination: "Cloud OCR: кадрите или звукът, които получава, напускат този компютър",
    });
    expect(said.reasons).toEqual(["cloud-ocr е отдалечен анализатор: каквото получи, се изпраща извън този компютър"]);
    expect(analyzerAssessment(remote, { capability: "ocr", frames: 1 }, context, "Read").display.title).toBe("Read with cloud-ocr");
  });
});

describe("the Inbox in Bulgarian", () => {
  const row: PendingApprovalRow = {
    approvalId: "a1",
    taskId: "t1",
    toolId: "http.request",
    callId: "c1",
    steps: 1,
    createdAt: "2026-09-30T08:00:00.000Z",
    workspaceId: "default",
    principalId: "operator",
    taskStatus: "waiting",
    allowedScopes: ["once"],
  };
  const label = labelSummary(untrustedLabel("web", { ref: { ref: "c1", host: "news.example", at: "2026-09-30T08:00:00.000Z" } }));

  it("says where a round's chat read untrusted content in the workspace's words", () => {
    expect(approvalListRowOf({ ...row, label }, undefined, bg).provenance).toBe("⚠ след четене на news.example — само веднъж");
    expect(approvalListRowOf({ ...row, label }).provenance).toBe("⚠ after reading news.example — once only");
  });
});
