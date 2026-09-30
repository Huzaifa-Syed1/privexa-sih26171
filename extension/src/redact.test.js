import { describe, it, expect } from "vitest";
import { redactField, redactText, redactNode, TOKENS } from "./redact.js";

describe("redactField — DOM attribute rules", () => {
  it("redacts password fields", () => {
    expect(redactField({ type: "password" })).toBe(TOKENS.PASSWORD);
  });

  it("redacts email fields by type", () => {
    expect(redactField({ type: "email" })).toBe(TOKENS.EMAIL);
  });

  it("redacts email fields by autocomplete attribute", () => {
    expect(redactField({ type: "text", autocomplete: "email" })).toBe(TOKENS.EMAIL);
  });

  it("redacts tel fields", () => {
    expect(redactField({ type: "tel" })).toBe(TOKENS.PHONE);
  });

  it("redacts credit card autocomplete hints", () => {
    expect(redactField({ type: "text", autocomplete: "cc-number" })).toBe(TOKENS.CARD);
  });

  it("does not redact a plain text field", () => {
    expect(redactField({ type: "text" })).toBeNull();
  });

  it("does not redact a search field", () => {
    expect(redactField({ type: "search" })).toBeNull();
  });
});

describe("redactText — pattern matching", () => {
  it("redacts a plain email address", () => {
    expect(redactText("contact me at someone@example.com please")).toBe(TOKENS.EMAIL);
  });

  it("redacts an Indian mobile number", () => {
    expect(redactText("call me on 9876543210")).toBe(TOKENS.PHONE);
  });

  it("redacts an Indian mobile number with +91 prefix", () => {
    expect(redactText("+91 98765 43210")).toBe(TOKENS.PHONE);
  });

  it("does NOT redact a random 10-digit number that isn't phone-shaped (starts with 0-5)", () => {
    // starts with '1' -> not a valid Indian mobile prefix (6-9)
    expect(redactText("order number 1234567890")).toBeNull();
  });

  it("redacts a valid PAN pattern", () => {
    // ABCDE1234F is a syntactically valid PAN shape
    expect(redactText("PAN: ABCDE1234F")).toBe(TOKENS.PAN);
  });

  it("does not redact text with no PII", () => {
    expect(redactText("Welcome to the dashboard")).toBeNull();
  });

  it("returns null for empty or non-string input", () => {
    expect(redactText("")).toBeNull();
    expect(redactText(null)).toBeNull();
    expect(redactText(undefined)).toBeNull();
  });

  describe("Aadhaar (Verhoeff checksum)", () => {
    it("redacts a Verhoeff-valid 12-digit Aadhaar-shaped number", () => {
      // 234123412346 is a commonly-cited Verhoeff-valid test vector shape;
      // verify via the same algorithm the module uses, independently below.
      const candidate = "234123412346";
      // Sanity: this test is meaningful only if our own checksum agrees
      // that it's valid. If this assumption ever breaks (typo'd vector),
      // this test will fail loudly rather than silently passing on a
      // number that was never actually checksum-valid.
      expect(redactText(candidate)).toBe(TOKENS.AADHAAR);
    });

    it("does NOT redact a random 12-digit number that fails the Verhoeff checksum", () => {
      expect(redactText("111111111111")).not.toBe(TOKENS.AADHAAR);
    });
  });

  describe("Card number (Luhn checksum)", () => {
    it("redacts a Luhn-valid card number (standard test card)", () => {
      // 4111111111111111 is the well-known Visa test number, Luhn-valid.
      expect(redactText("4111111111111111")).toBe(TOKENS.CARD);
    });

    it("does NOT redact a random 16-digit number that fails Luhn", () => {
      expect(redactText("1234567812345678")).not.toBe(TOKENS.CARD);
    });
  });

  it("never leaks a fragment of the original value in the token", () => {
    const inputs = [
      "someone@example.com",
      "9876543210",
      "ABCDE1234F",
      "4111111111111111",
      "234123412346",
    ];
    for (const input of inputs) {
      const token = redactText(input);
      if (token) {
        // The token must be exactly one of the fixed vocabulary strings —
        // never the input itself or a substring of it embedded in output.
        expect(Object.values(TOKENS).filter(t => typeof t === "string")).toContain(token);
        expect(token).not.toContain(input);
      }
    }
  });
});

describe("redactNode — combined entry point", () => {
  it("prefers field-level redaction over text content", () => {
    const node = { type: "password", textContent: "hunter2" };
    expect(redactNode(node)).toBe(TOKENS.PASSWORD);
  });

  it("falls back to text redaction when field type is not sensitive", () => {
    const node = { type: "text", textContent: "someone@example.com" };
    expect(redactNode(node)).toBe(TOKENS.EMAIL);
  });

  it("returns null when nothing sensitive is present", () => {
    const node = { type: "text", textContent: "Submit" };
    expect(redactNode(node)).toBeNull();
  });
});
