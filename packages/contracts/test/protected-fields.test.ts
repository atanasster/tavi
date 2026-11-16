import { describe, expect, it } from "vitest";

import { protectedFieldClass, protectedFieldRefusal, protectedValueClass } from "../src/index.js";

describe("protected form fields", () => {
  it("knows each class, in eight languages, and the names the ATSs use", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["Gender", "demographic"],
      ["Race", "demographic"],
      ["Are you Hispanic or Latino?", "demographic"],
      ["Sexual orientation", "demographic"],
      ["Geschlecht", "demographic"],
      ["Sexe", "demographic"],
      ["Género", "demographic"],
      ["Geslacht", "demographic"],
      ["Kön", "demographic"],
      ["Sesso", "demographic"],
      ["Raça", "demographic"],
      ["Disability status", "disability"],
      ["Stato di disabilità", "disability"],
      ["Disabilità", "disability"],
      ["Schwerbehinderung", "disability"],
      ["Discapacidad", "disability"],
      ["Funktionsnedsättning", "disability"],
      ["Protected veteran status", "veteran"],
      ["Have you ever been convicted of a felony?", "criminal-history"],
      ["Führungszeugnis", "criminal-history"],
      ["Casier judiciaire", "criminal-history"],
      ["I consent to a background check", "background-check"],
      ["I certify that the information above is true", "attestation"],
      ["I personally completed this application without AI", "attestation"],
      ["AI Policy for Application", "attestation"],
      ["Ich versichere, dass…", "attestation"],
      ["Je certifie…", "attestation"],
      ["Signature", "signature"],
      ["Unterschrift", "signature"],
      ["Firma digital", "signature"],
      ["Assinatura", "signature"],
      ["Gênero", "demographic"],
      ["Genere", "demographic"],
      ["Razza", "demographic"],
      ["Origine etnica", "demographic"],
      ["Origem étnica", "demographic"],
      ["Etnische afkomst", "demographic"],
      ["Etnisk bakgrund", "demographic"],
      ["Handicap", "disability"],
      ["Avez-vous un handicap ?", "disability"],
      ["Strafregister", "criminal-history"],
      ["Casellario", "criminal-history"],
      ["Achtergrondcontrole", "background-check"],
      ["Bakgrundskontroll", "background-check"],
      ["Controllo dei precedenti", "background-check"],
      ["Verificação de antecedentes", "background-check"],
      ["Ich akzeptiere die AGB", "attestation"],
      ["J'accepte les conditions générales", "attestation"],
      ["Acepto los términos y condiciones", "attestation"],
      ["Accetto i termini", "attestation"],
      ["Ik ga akkoord met de voorwaarden", "attestation"],
      ["Jag godkänner villkoren", "attestation"],
      ["Aceito os termos", "attestation"],
      // ATS field names.
      ["hispanic_ethnicity", "demographic"],
      ["veteran_status", "veteran"],
      ["disability_status", "disability"],
      ["eeo[race]", "demographic"],
      ["_systemfield_eeoc_gender", "demographic"],
      ["formField-veteranStatus", "veteran"],
      ["formField-acceptTermsAndAgreements", "attestation"],
      ["selfIdentifiedDisabilityData", "disability"],
      ["veteranStatus", "veteran"],
    ];
    expect(cases.map(([text]) => [text, protectedFieldClass([text])])).toEqual(cases);
  });

  it("leaves a form's ordinary fields alone", () => {
    for (const text of [
      "First name",
      "Email",
      "Phone",
      "Firma",
      "Ihre Firma",
      "Company name",
      "Current company",
      "LinkedIn profile",
      "Cover letter",
      "Résumé",
      "Years of experience",
      "Salary expectation",
      "Notice period",
      "How did you hear about us?",
      "Are you legally authorized to work in the US?",
      "Will you require sponsorship?",
      "Check all that apply",
      "Address",
      "Website",
      "Why do you want to work here?",
      "Genre",
      "Golf handicap",
      "Email signature",
      "Racecourse",
      "Herkunft",
      "racecourse_name",
      "Criminal defense lawyer",
      "Accetto",
      "Acepto",
      "Aceito",
      "Ich akzeptiere",
      "J'accepte",
      "Jag godkänner",
      "Alle akzeptieren",
    ]) {
      expect(protectedFieldClass([text]), text).toBeUndefined();
    }
  });

  it("reads a value about to be typed only as a first-person attestation: a search is never one", () => {
    expect(protectedValueClass("I hereby certify this is my own work")).toBe("attestation");
    for (const search of [
      "criminal defense lawyer austin",
      "Formula 1 race tickets",
      "artificial intelligence engineer",
      "I confirm that I will attend",
      "AI policy jobs",
      "disability insurance",
    ])
      expect(protectedValueClass(search), search).toBeUndefined();
    expect(protectedFieldRefusal("signature")).toMatch(/only the person fills it/);
  });

  it("knows a clinic's medical intake in the booking profiles' languages, and leaves a booking's ordinary fields alone", () => {
    for (const text of [
      "Medical history",
      "Health declaration",
      "Please describe your symptoms",
      "Current medications",
      "Pre-existing conditions",
      "Consent to treatment",
      "Anamnese",
      "Vorerkrankungen",
      "Antécédents médicaux",
      "Questionnaire de santé",
      "Historial clínico",
      "Síntomas",
      "Histórico médico",
      "Questionário de saúde",
      "Wywiad medyczny",
      "Objawy",
      "Zgoda na leczenie",
      "Medische voorgeschiedenis",
      "Gezondheidsverklaring",
      "Medications",
      "Medication list",
      "Patient history",
      "Huidige klachten",
      "Consentimiento informado para el tratamiento",
      "Aktuelle Beschwerden",
    ]) {
      expect(protectedFieldClass([text]), text).toBe("medical-intake");
    }
    // A booking's and a job form's ordinary fields, and a privacy form's consent.
    for (const text of [
      "Allergies or dietary requirements",
      "Special requests",
      "Reason for visit",
      "Party size",
      "Date of visit",
      "Terms and conditions apply",
      "Notes for the restaurant",
      "Do you have a medical background?",
      "Years of experience with diagnoses",
      "Anregungen und Beschwerden",
      "Consentimiento informado",
      "Pharmacy medications delivery",
      "Klachten",
    ]) {
      expect(protectedFieldClass([text]), text).not.toBe("medical-intake");
    }
    expect(protectedFieldRefusal("medical-intake")).toMatch(
      /medical-history, symptom or treatment-consent question: only the person fills it/,
    );
  });
});
