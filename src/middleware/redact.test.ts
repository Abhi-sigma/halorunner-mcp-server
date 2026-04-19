import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redact, type RedactionPlan } from "./redact.js";

function plan(input: {
  pii?: string[];
  declared?: string[];
  strict?: boolean;
  value?: string;
}): RedactionPlan {
  const declared = new Set(input.declared ?? [...(input.pii ?? [])]);
  return {
    piiPaths: new Set(input.pii ?? []),
    declaredPaths: declared,
    strict: input.strict ?? true,
    redactionValue: input.value ?? "REDACTED"
  };
}

describe("redact — scalar behaviour", () => {
  it("replaces a top-level pii field with the sentinel", () => {
    const p = plan({ pii: ["firstName"], declared: ["firstName"] });
    assert.deepEqual(redact(p, { firstName: "John" }), { firstName: "REDACTED" });
  });

  it("preserves null at a pii path (does not replace null with the sentinel)", () => {
    const p = plan({ pii: ["firstName"], declared: ["firstName"] });
    assert.deepEqual(redact(p, { firstName: null }), { firstName: null });
  });

  it("passes a declared non-pii field through unchanged", () => {
    const p = plan({ pii: [], declared: ["patientId"] });
    assert.deepEqual(redact(p, { patientId: 42 }), { patientId: 42 });
  });

  it("uses the plan's redactionValue", () => {
    const p = plan({ pii: ["name"], declared: ["name"], value: "[PII]" });
    assert.deepEqual(redact(p, { name: "Jane" }), { name: "[PII]" });
  });
});

describe("redact — nested objects", () => {
  it("redacts a dotted pii path inside a declared parent", () => {
    const p = plan({
      pii: ["data.patientName"],
      declared: ["data.patientId", "data.patientName"]
    });
    const out = redact(p, { data: { patientId: 7, patientName: "John" } });
    assert.deepEqual(out, { data: { patientId: 7, patientName: "REDACTED" } });
  });

  it("keeps a parent object whose descendant is declared", () => {
    const p = plan({ pii: [], declared: ["data.patient.id"] });
    const out = redact(p, { data: { patient: { id: 1 } } });
    assert.deepEqual(out, { data: { patient: { id: 1 } } });
  });

  it("drops an undeclared sibling when strict=true", () => {
    const p = plan({ pii: [], declared: ["data.patientId"], strict: true });
    const out = redact(p, {
      data: { patientId: 1, medicareNumber: "2 1234 56789 1" }
    });
    assert.deepEqual(out, { data: { patientId: 1 } });
  });

  it("keeps an undeclared sibling when strict=false", () => {
    const p = plan({ pii: [], declared: ["data.patientId"], strict: false });
    const out = redact(p, {
      data: { patientId: 1, medicareNumber: "2 1234 56789 1" }
    });
    assert.deepEqual(out, {
      data: { patientId: 1, medicareNumber: "2 1234 56789 1" }
    });
  });
});

describe("redact — arrays", () => {
  it("redacts pii fields inside every element of a top-level array (path does not extend through arrays)", () => {
    const p = plan({ pii: ["firstName"], declared: ["firstName", "id"] });
    const out = redact(p, [
      { id: 1, firstName: "A" },
      { id: 2, firstName: "B" }
    ]);
    assert.deepEqual(out, [
      { id: 1, firstName: "REDACTED" },
      { id: 2, firstName: "REDACTED" }
    ]);
  });

  it("redacts pii fields in a nested array of objects (collection endpoint pattern)", () => {
    const p = plan({
      pii: ["data.items.patientName"],
      declared: ["data.page", "data.items.patientId", "data.items.patientName"]
    });
    const out = redact(p, {
      data: {
        page: 1,
        items: [
          { patientId: "A", patientName: "John" },
          { patientId: "B", patientName: "Jane" }
        ]
      }
    });
    assert.deepEqual(out, {
      data: {
        page: 1,
        items: [
          { patientId: "A", patientName: "REDACTED" },
          { patientId: "B", patientName: "REDACTED" }
        ]
      }
    });
  });

  it("drops undeclared fields inside collection elements under strict=true", () => {
    const p = plan({
      pii: [],
      declared: ["data.items.patientId"],
      strict: true
    });
    const out = redact(p, {
      data: {
        items: [{ patientId: "A", leakField: "secret" }]
      }
    });
    assert.deepEqual(out, { data: { items: [{ patientId: "A" }] } });
  });
});

describe("redact — opt-out", () => {
  it("returns the body untouched when the plan has no declared paths", () => {
    const p = plan({ pii: [], declared: [], strict: true });
    const body = { anything: "goes", nested: { here: true } };
    assert.deepEqual(redact(p, body), body);
  });
});

describe("redact — primitives at the root", () => {
  it("returns a primitive unchanged", () => {
    const p = plan({ pii: [], declared: ["x"] });
    assert.equal(redact(p, 42), 42);
    assert.equal(redact(p, "hello"), "hello");
    assert.equal(redact(p, null), null);
  });
});
