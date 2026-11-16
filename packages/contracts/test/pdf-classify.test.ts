import { describe, expect, it } from "vitest";

import { fieldTokens, maskSensitive, sensitiveOf, userOnlyOf } from "../src/index.js";

describe("PDF field classification", () => {
  it("splits names into words", () => {
    expect(fieldTokens("InsurancePolicyNo")).toEqual(["insurance", "policy", "no"]);
    expect(fieldTokens("patient_dob")).toEqual(["patient", "dob"]);
    expect(fieldTokens("phone2.home")).toEqual(["phone", "2", "home"]);
    expect(fieldTokens("SSNNumber")).toEqual(["ssn", "number"]);
  });

  it("matches whole tokens, never inside a word", () => {
    expect(sensitiveOf("protein", undefined)).toEqual([]);
    expect(sensitiveOf("writing", undefined)).toEqual([]);
    expect(sensitiveOf("undeclared", undefined)).toEqual([]);
    expect(sensitiveOf("ssn", undefined)).toEqual(["government-id"]);
    expect(sensitiveOf("patient_dob", undefined)).toEqual(["birth-date"]);
    expect(sensitiveOf("InsurancePolicyNo", undefined)).toEqual(["insurance"]);
    expect(sensitiveOf("f1", "Vaccinations received")).toEqual(["health"]);
    expect(sensitiveOf("f2", "Date of birth")).toEqual(["birth-date"]);
    expect(sensitiveOf("birthdate", undefined)).toEqual(["birth-date"]);
    expect(sensitiveOf("dateofbirth", undefined)).toEqual(["birth-date"]);
  });

  it("classifies by value shape whatever the label says", () => {
    expect(sensitiveOf("f3", "Number", "123-45-6789")).toEqual(["government-id"]);
    expect(sensitiveOf("f4", "Number", "4111 1111 1111 1111")).toContain("financial");
    expect(sensitiveOf("f5", "Write here", "leo@example.com")).toEqual(["contact"]);
    expect(sensitiveOf("f6", "Name", "Leo Smith")).toEqual([]);
    expect(sensitiveOf("f7", "Birthdate", "03/04/2016")).toEqual(["birth-date"]);
    expect(sensitiveOf("f8", "When", "2016.3.2")).toEqual(["birth-date"]);
  });

  it("masks with the strictest category", () => {
    expect(maskSensitive("123-45-6789", ["contact", "government-id"])).toBe("•••-••-6789");
    expect(maskSensitive("4111 1111 1111 4821", ["financial"])).toBe("•••• 4821");
    expect(maskSensitive("2016-03-02", ["birth-date"])).toBe("2016-••-••");
    expect(maskSensitive("leo@example.com", ["contact"])).toBe("l•••@example.com");
    expect(maskSensitive("555-867-1234", ["contact"])).toBe("•••-•••-1234");
    expect(maskSensitive("MMR 2016-03-02", ["health", "birth-date"])).toBe("[health-verified]");
    expect(maskSensitive("Leo", [])).toBe("Leo");
  });

  it("keeps signatures, initials and attestations for the person", () => {
    expect(userOnlyOf("signature", "sig1", undefined)).toBe("signature");
    expect(userOnlyOf("text", "parentSignature", undefined)).toBe("signature-like");
    expect(userOnlyOf("text", "f9", "Parent signature")).toBe("signature-like");
    expect(userOnlyOf("text", "initials_p3", undefined)).toBe("signature-like");
    for (const label of ["Sign here", "SignHere", "Signed by", "signed_by"])
      expect(userOnlyOf("text", label, undefined), label).toBe("signature-like");
    expect(userOnlyOf("text", "f1", "Sign here")).toBe("signature-like");
    expect(userOnlyOf("checkbox", "c1", "I certify that the information above is true")).toBe("attestation");
    expect(userOnlyOf("text", "design", "Design notes")).toBeUndefined();
    expect(userOnlyOf("text", "undeclared", undefined)).toBeUndefined();
  });
});
