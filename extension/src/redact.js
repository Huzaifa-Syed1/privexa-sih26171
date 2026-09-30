/**
 * Stage A — deterministic redaction rules.
 *
 * Spec: docs/SPEC.md §3 (token vocabulary) and §4 (Stage A rules).
 *
 * Hard rule enforced here: a redaction token is NEVER allowed to carry a
 * fragment of the real value. Every function below returns either `null`
 * (nothing sensitive found) or one of the exact strings in TOKENS. There
 * is no code path that concatenates any part of the input into the output.
 */

export const TOKENS = Object.freeze({
  PASSWORD: "<REDACTED:password>",
  EMAIL: "<REDACTED:email>",
  PHONE: "<REDACTED:phone>",
  AADHAAR: "<REDACTED:aadhaar>",
  PAN: "<REDACTED:pan>",
  CARD: "<REDACTED:card_number>",
  VALUE: "<REDACTED:value>",
  OPAQUE_IMAGE: "<REDACTED:opaque_image>",
  face: (n) => `<REDACTED:face,count=${n}>`,
  DOCUMENT: "<REDACTED:document>",
  generic: (n) => `<REDACTED:generic_pii,count=${n}>`,
});

// ---- Pattern library ---------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Indian phone numbers: optional +91, then 10 digits starting 6-9.
// Allows an optional single space/hyphen after the first 5 digits, since
// numbers are commonly displayed as "98765 43210".
const PHONE_RE = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;

// Aadhaar: 12 digits, commonly grouped as 4-4-4.
const AADHAAR_RE = /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/;

// PAN: 5 letters, 4 digits, 1 letter.
const PAN_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;

// Card number: 13-19 digits, optionally grouped in 4s.
const CARD_RE = /\b((?:\d[ -]*?){13,19})\b/;

/**
 * Verhoeff checksum validation for Aadhaar numbers.
 * Reduces false positives from arbitrary 12-digit strings (order IDs,
 * phone-like sequences, etc.) that aren't actually Aadhaar numbers.
 */
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];

function verhoeffIsValid(numStr) {
  const digits = numStr.replace(/\D/g, "").split("").reverse().map(Number);
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
  }
  return c === 0;
}

function luhnIsValid(numStr) {
  const digits = numStr.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---- DOM-attribute rules (Stage A, field-level) ------------------------

/**
 * Given a form-field-like descriptor, return a redaction token or null.
 * Deliberately takes a plain object (not a live DOM node) so this stays
 * unit-testable without a DOM.
 *
 * @param {{type?: string, autocomplete?: string}} field
 * @returns {string|null}
 */
export function redactField(field) {
  const type = (field.type || "").toLowerCase();
  const auto = (field.autocomplete || "").toLowerCase();

  if (type === "password") return TOKENS.PASSWORD;
  if (type === "email" || auto === "email") return TOKENS.EMAIL;
  if (type === "tel" || auto.includes("tel")) return TOKENS.PHONE;
  if (auto.includes("cc-number")) return TOKENS.CARD;

  return null;
}

// ---- Text-content rules (Stage A, regex-level; also used by Stage B on OCR output) ----

/**
 * Scan free text for PII patterns. Returns a redaction token for the
 * FIRST/strongest match, or null. Order matters: more specific patterns
 * (Aadhaar, PAN, card) are checked before generic email/phone so a
 * document blob doesn't get mis-tagged as merely "generic".
 *
 * @param {string} text
 * @returns {string|null}
 */
export function redactText(text) {
  if (!text || typeof text !== "string") return null;

  const aadhaarMatch = text.match(AADHAAR_RE);
  if (aadhaarMatch && verhoeffIsValid(aadhaarMatch[1])) {
    return TOKENS.AADHAAR;
  }

  const panMatch = text.match(PAN_RE);
  if (panMatch) {
    return TOKENS.PAN;
  }

  const cardMatch = text.match(CARD_RE);
  if (cardMatch && luhnIsValid(cardMatch[1])) {
    return TOKENS.CARD;
  }

  if (EMAIL_RE.test(text)) {
    return TOKENS.EMAIL;
  }

  if (PHONE_RE.test(text)) {
    return TOKENS.PHONE;
  }

  return null;
}

/**
 * Combine field-level and text-level redaction for a DOM node descriptor.
 * This is the single entry point content_script.js should call — it never
 * touches raw values itself, only this function does, and only to decide
 * which token (if any) applies.
 *
 * @param {{type?: string, autocomplete?: string, textContent?: string}} node
 * @returns {string|null}
 */
export function redactNode(node) {
  const fieldToken = redactField(node);
  if (fieldToken) return fieldToken;

  if (node.textContent) {
    return redactText(node.textContent);
  }

  return null;
}
