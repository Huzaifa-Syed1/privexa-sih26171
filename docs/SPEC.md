# SIH26171 — Technical Spec v0.1
On-device Visual Perception for Light-weight Browser Agents

This document is the contract every piece of code below must follow.
If code and spec disagree, the spec is fixed first, then code is updated —
never the other way around silently.

---

## 1. System Overview

```
Browser tab
  │
  ├─ Tier 0: DOM Reader          (instant, deterministic, no ML)
  ├─ Tier 1: Local Vision        (WebGPU, only for DOM-opaque regions)
  ├─ Redactor                    (turns raw values into typed placeholders)
  │
  ▼
Scene-Graph (JSON, sanitized)  ──────────►  Server
                                              │
                                              ├─ Cache lookup (scene-graph hash)
                                              └─ LLM Planner → Action JSON
  ▲                                            │
  └────────────────────────────────────────────┘
Action Executor (content script) runs the action on the real DOM
```

Golden rule: **nothing with a redaction type crosses the network boundary
in raw form.** The redactor is the only thing allowed to touch raw PII,
and it never leaves the browser process.

---

## 2. Scene-Graph Schema (the wire format)

This is the ONLY thing sent to the server for the common (DOM-explainable) case.

```jsonc
{
  "version": "1.0",
  "url_hash": "sha256:...",          // hashed, never raw URL if it may contain PII in query params
  "viewport": { "w": 1440, "h": 900 },
  "timestamp": 1735900000,
  "nodes": [
    {
      "id": "n1",                    // stable per-session id, not a DOM selector (selectors leak structure but are fine; values are not)
      "role": "textbox",              // ARIA role or inferred role
      "label": "Email",               // visible label / aria-label — NOT the value
      "type": "email",                // input type if applicable
      "bbox": [x, y, w, h],
      "value_redacted": null,         // see §3 — null, or a typed placeholder, NEVER raw
      "source": "dom"                 // "dom" | "vision" | "fused"
    },
    {
      "id": "n2",
      "role": "textbox",
      "label": "Password",
      "type": "password",
      "bbox": [x, y, w, h],
      "value_redacted": "<REDACTED:password>",
      "source": "dom"
    },
    {
      "id": "n3",
      "role": "image",
      "label": null,
      "bbox": [x, y, w, h],
      "value_redacted": "<REDACTED:face,count=1>",
      "source": "vision"
    },
    {
      "id": "n4",
      "role": "button",
      "label": "Submit",
      "bbox": [x, y, w, h],
      "value_redacted": null,
      "source": "dom"
    }
  ],
  "focused_node_id": "n1",
  "task_context": "user is filling a login form"   // short, LLM-provided or template string — no PII
}
```

Rules:
- `label` is the field's *name*, never its *value*. "Email" is fine. "huzaifa@x.com" is not.
- `value_redacted` is either `null` (nothing sensitive / not applicable) or a placeholder token from the fixed vocabulary in §3. It is never a raw string pulled from the page.
- `bbox` coordinates are safe to send (layout is not PII).
- Every node must have `source`. This is what the demo dashboard uses to show "how much of this screen did we understand without vision."

---

## 3. Redaction Token Vocabulary (fixed, closed set)

The server is hard-coded to understand exactly these. Anything else is a bug, not a feature — an open-ended token vocabulary is how PII leaks through the back door (e.g. someone "helpfully" stuffing a snippet of real value into a token string).

| Token | Meaning |
|---|---|
| `<REDACTED:password>` | Password field, any value |
| `<REDACTED:email>` | Email field or detected email pattern |
| `<REDACTED:phone>` | Phone number pattern |
| `<REDACTED:aadhaar>` | 12-digit Aadhaar pattern (Verhoeff-valid) |
| `<REDACTED:pan>` | PAN card pattern (`[A-Z]{5}[0-9]{4}[A-Z]`) |
| `<REDACTED:card_number>` | Credit/debit card pattern (Luhn-valid) |
| `<REDACTED:face,count=N>` | N faces detected in an image region |
| `<REDACTED:document>` | Detected ID-card/document-like image (heuristic: face + dense text block) |
| `<REDACTED:generic_pii,count=N>` | OCR text matched a PII regex not covered above |

No token may ever be followed by a real value fragment (e.g. `<REDACTED:email:h***@x.com>` is **forbidden** — partial masking still leaks entropy).

---

## 4. Two-Stage Redaction Pipeline

**Stage A — Deterministic (DOM/attribute rules), runs on every node, <5ms:**
- `input[type=password]` → `<REDACTED:password>`
- `input[type=email]` or `autocomplete=email` → `<REDACTED:email>`
- `autocomplete` containing `cc-number` → `<REDACTED:card_number>`
- Regex match on any extracted text node against: email, phone (Indian formats), Aadhaar (with Verhoeff checksum validation — reduces false positives from random 12-digit numbers), PAN, card number (Luhn check)

**Stage B — Model-based (only for `source: "vision"` nodes, i.e. canvas/image regions DOM can't explain):**
- Face detector (BlazeFace) on the cropped region → if faces found, `<REDACTED:face,count=N>`
- OCR (Tesseract.js) on the cropped region → run Stage A regex rules against extracted text
- Document heuristic (face detected AND text density above threshold in same crop) → `<REDACTED:document>` instead of separate face/text tokens

Stage B never runs on the full screen — only on regions flagged by the DOM reader as "opaque" (canvas, cross-origin iframe placeholder, `<img>` with no meaningful alt text). This is the resource-utilization win: most pages trigger zero Stage B calls.

---

## 5. Action Protocol (server → client)

Server responds with exactly one of these shapes. No free-text.

```jsonc
{
  "action": "click",
  "target_node_id": "n4"
}
```
```jsonc
{
  "action": "type",
  "target_node_id": "n1",
  "value_source": "user_provided"   // server NEVER supplies the literal value for a redacted field —
                                      // it can only say "type the user's email here"; the client fills
                                      // it from a local, user-approved source (autofill, user types it themselves).
}
```
```jsonc
{
  "action": "scroll",
  "direction": "down",
  "amount_px": 400
}
```
```jsonc
{
  "action": "wait",
  "reason": "page_loading"
}
```
```jsonc
{
  "action": "done",
  "summary": "Logged in successfully"
}
```

Critical constraint: **the server can never send back a raw value for a redacted field.** For `type` actions on sensitive fields, the server can only say *which* field to fill and *what kind* of value belongs there — the actual value comes from the user or the browser's own (local) autofill, never round-tripped through the server. This is non-negotiable and must be enforced in the executor, not just assumed.

---

## 6. Caching Key

`cache_key = sha256(json.dumps(scene_graph_without_timestamp_and_bbox, sort_keys=True))`

bbox and timestamp are excluded from the hash because pixel-perfect layout jitter and time shouldn't bust the cache — same semantic state should hit the same cached plan.

---

## 7. What Ships in the 36-Hour Prototype (v0.1 scope)

In scope:
- Chrome MV3 extension, DOM reader (Stage A redaction), content script executor
- One local vision path: BlazeFace + Tesseract.js OCR on flagged regions (Stage B)
- FastAPI server: `/plan` endpoint, in-memory cache, one LLM call (Groq-hosted Qwen2.5 or similar)
- 2 working demo flows: mock login form, mock "bank summary" page with a redacted transaction image

Out of scope for v0.1 (call out explicitly, don't silently drop):
- WebGPU-accelerated ViT for general scene understanding (v0.1 uses BlazeFace/Tesseract only, which are already WASM-fast; the heavier ViT is a v0.2 addition if time allows)
- Cross-origin iframe handling
- Multi-tab / multi-session state

---

## 8. Definition of Done for v0.1

- [ ] Extension loads unpacked in Chrome, no console errors
- [ ] DOM reader produces a valid scene-graph (matches §2 schema) for the demo login page
- [ ] Password/email fields are redacted per §3 — verified by inspecting the actual network request payload in devtools, not just trusting the code
- [ ] Server never receives a raw password or email value — this is checked, not assumed
- [ ] Face in the demo bank-summary image is detected and redacted before any network call
- [ ] Server responds with a valid action per §5, executor performs it
- [ ] Cache hit on second identical scene-graph (verified via server log)
