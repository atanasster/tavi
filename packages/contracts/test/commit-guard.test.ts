import { describe, expect, it } from "vitest";

import {
  ASSIST_ONLY_COMMIT_LABEL,
  commitCategory,
  isSearchFormFacts,
  labelIsFinalStep,
  pressCommits,
  pressRefusal,
  urlIsFinalStep,
  type FinalStepRule,
  type PressFacts,
} from "../src/index.js";

const facts = (extra: Partial<PressFacts> = {}): PressFacts => ({
  pressable: true,
  label: "Next",
  submitsForm: false,
  selectorMatched: false,
  headings: [],
  url: "https://acme.wd5.myworkdayjobs.com/x/apply",
  ...extra,
});
const workday: FinalStepRule = {
  labels: ["Submit", "Absenden"],
  urlPatterns: [],
  selectors: ["[data-automation-id=pageFooterNextButton]"],
  stepHeadings: ["Review"],
};

describe("what a press commits", () => {
  it("reads Apply as committing only on a control that submits its form", () => {
    expect(pressCommits("Apply", true)).toBe(true);
    expect(pressCommits("Submit application", false)).toBe(true);
    expect(pressCommits("Apply", false)).toBe(false);
    for (const label of ["Apply filters", "Check all that apply", "Apply for this job"])
      expect(pressCommits(label, true), label).toBe(false);
  });

  it("matches a final step by its whole label, its address, or its selector under its step heading", () => {
    expect(labelIsFinalStep("  submit ", workday)).toBe(true);
    expect(labelIsFinalStep("Save and Continue", workday)).toBe(false);
    expect(urlIsFinalStep("https://x.example/apply/review?step=3", { labels: ["x"], urlPatterns: ["/apply/review*"] })).toBe(true);
    // Workday's Next and Submit are one element: the selector counts only on the Review step.
    expect(
      pressRefusal(facts({ label: "Save and Continue", selectorMatched: true, headings: ["My Experience"] }), {
        commitApproved: false,
        finalStep: workday,
      }),
    ).toBeUndefined();
    expect(
      pressRefusal(facts({ label: "Save and Continue", selectorMatched: true, headings: ["Review"] }), {
        commitApproved: false,
        finalStep: workday,
      }),
    ).toMatchObject({ finalStep: true });
    expect(pressRefusal(facts({ label: "Submit" }), { commitApproved: true, finalStep: workday })).toMatchObject({ finalStep: true });
  });

  it("refuses a committing press the call was not approved for, and lets an approved one through", () => {
    expect(pressRefusal(facts({ label: "Submit application" }), { commitApproved: false })).toMatchObject({
      finalStep: false,
      reason: expect.stringMatching(/not asked about as one/),
    });
    // A plain link whose label commits (QA-20261110-1803): the reason says what happened and how to be asked, and
    // blames no page change nobody saw.
    const link = pressRefusal(facts({ label: "Cancel membership" }), { commitApproved: false })?.reason ?? "";
    expect(link).toMatch(/^this press of "Cancel membership" commits/);
    expect(link).toMatch(/observe the page again .* so the person is asked about this press/);
    expect(link).not.toMatch(/the page changed/);
    expect(pressRefusal(facts({ label: "Submit application" }), { commitApproved: true })).toBeUndefined();
    expect(pressRefusal(facts({ label: "Next" }), { commitApproved: false })).toBeUndefined();
    // A field's label is no press: "Confirm email", a "Subscribe" checkbox.
    expect(pressRefusal(facts({ pressable: false, label: "Confirm email" }), { commitApproved: false })).toBeUndefined();
    // Enter in a search form's field runs the search.
    expect(
      pressRefusal(facts({ label: "Submit", submitsForm: true, searchForm: true, viaEnter: true }), { commitApproved: false }),
    ).toBeUndefined();
  });

  it("refuses a press that sends its form, whatever its label, unless approved as a submit", () => {
    for (const label of ["Continue", "Weiter", "→"]) {
      expect(pressRefusal(facts({ label, submitsForm: true, sendsForm: true }), { commitApproved: false }), label).toMatchObject({
        finalStep: false,
        reason: expect.stringMatching(/sends its form, and it was not approved as a submit/),
      });
      expect(pressRefusal(facts({ label, submitsForm: true, sendsForm: true }), { commitApproved: true }), label).toBeUndefined();
    }
    // A download approved on its own card may send an export form; a label that commits still needs a commit's approval.
    expect(
      pressRefusal(facts({ label: "Export CSV", submitsForm: true, sendsForm: true }), { commitApproved: false, formSendApproved: true }),
    ).toBeUndefined();
    expect(
      pressRefusal(facts({ label: "Pay now", submitsForm: true, sendsForm: true }), { commitApproved: false, formSendApproved: true }),
    ).toMatchObject({ reason: expect.stringMatching(/commits/) });
    // A button in a filled form that sends nothing, a filter form's own button, and a search form's submit.
    expect(pressRefusal(facts({ label: "Add passenger", submitsForm: true }), { commitApproved: false })).toBeUndefined();
    expect(pressRefusal(facts({ label: "Apply filters", submitsForm: true, sendsForm: true }), { commitApproved: false })).toBeUndefined();
    expect(
      pressRefusal(facts({ label: "Go", submitsForm: true, sendsForm: true, searchForm: true }), { commitApproved: false }),
    ).toBeUndefined();
  });

  it("re-checks Enter in a search form when its submit names a commit", () => {
    for (const label of ["Pay", "Delete account"]) {
      expect(
        pressRefusal(facts({ label, submitsForm: true, searchForm: true, viaEnter: true }), { commitApproved: false }),
        label,
      ).toMatchObject({ finalStep: false });
    }
    for (const label of ["Search", "Suchen", "Go"]) {
      expect(
        pressRefusal(facts({ label, submitsForm: true, searchForm: true, viaEnter: true }), { commitApproved: false }),
        label,
      ).toBeUndefined();
    }
  });

  it("re-checks a click on a commit label inside a search form", () => {
    for (const label of ["Pay", "Delete account", "Submit"]) {
      expect(pressRefusal(facts({ label, submitsForm: true, searchForm: true }), { commitApproved: false }), label).toMatchObject({
        finalStep: false,
      });
    }
  });

  it("classifies commit labels across all five categories and every protected-field language", () => {
    for (const label of ["Pay now", "Bezahlen", "Acheter", "Comprar", "Betalen", "Betala", "Acquista", "Encomendar", "Zapłać", "Плати"]) {
      expect(commitCategory(label), label).toBe("pay");
    }
    for (const label of [
      "Post",
      "Publish",
      "Reply",
      "Absenden",
      "Envoyer",
      "Enviar",
      "Verzenden",
      "Skicka",
      "Invia",
      "Submeter",
      "Wyślij",
      "Изпрати",
    ]) {
      expect(commitCategory(label), label).toBe("send");
    }
    expect(commitCategory("Conferma acquisto")).toBe("pay");
    expect(commitCategory("Valider")).toBe("send");
    expect(commitCategory("Aprovar")).toBe("legal");
    for (const label of [
      "Enroll",
      "Authorize",
      "Allow",
      "Registrieren",
      "S'inscrire",
      "Autorizar",
      "Inschrijven",
      "Registrera",
      "Iscriviti",
      "Subscrever",
      "Zarejestruj się",
      "Регистрирай се",
    ]) {
      expect(commitCategory(label), label).toBe("account");
    }
    for (const label of [
      "Accept",
      "Agree",
      "Approve",
      "Akzeptieren",
      "Accepter",
      "Aceptar",
      "Accepteren",
      "Godkänn",
      "Accetta",
      "Aceitar",
      "Zaakceptuj",
      "Приеми",
    ]) {
      expect(commitCategory(label), label).toBe("legal");
    }
    for (const label of [
      "Delete",
      "Remove",
      "Cancel booking",
      "Cancel my subscription",
      "Cancel account",
      "Löschen",
      "Buchung stornieren",
      "Supprimer",
      "Annuler ma réservation",
      "Eliminar",
      "Cancelar suscripción",
      "Verwijderen",
      "Ta bort",
      "Elimina",
      "Annulla prenotazione",
      "Apagar",
      "Usuń",
      "Изтрий",
    ]) {
      expect(commitCategory(label), label).toBe("destructive");
    }
    // A modal's plain Cancel stays inert.
    for (const label of ["Cancel", "Annuler", "Annulla", "Cancelar", "Anuluj"]) {
      expect(commitCategory(label), label).toBeUndefined();
    }
    // Assist-only COMMITS stays stricter than the shared table.
    for (const extra of ["Sign in", "Log in", "Apply", "Save", "Anmelden", "Se connecter", "Guardar", "Inloggen", "Spara", "Accedi"]) {
      expect(ASSIST_ONLY_COMMIT_LABEL.test(extra), extra).toBe(true);
    }
  });

  it("distinguishes strict search forms from booking and personal-data forms", () => {
    expect(
      isSearchFormFacts([
        { tag: "INPUT", type: "text", role: "textbox", visible: true, texts: ["destination", "Where to?"] },
        { tag: "INPUT", type: "text", role: "textbox", visible: true, texts: ["check-in", "Check-in"] },
      ]),
    ).toBe(true);
    expect(
      isSearchFormFacts([
        { tag: "INPUT", type: "text", role: "textbox", visible: true, texts: ["city", "City"] },
        { tag: "INPUT", type: "email", role: "textbox", visible: true, texts: ["email", "Email address"] },
      ]),
    ).toBe(false);
    expect(
      isSearchFormFacts([
        { tag: "INPUT", type: "text", role: "textbox", visible: true, texts: ["city", "City"] },
        { tag: "INPUT", type: "text", role: "textbox", visible: true, texts: ["recipient", "Recipient full name"] },
      ]),
    ).toBe(false);
  });
});
