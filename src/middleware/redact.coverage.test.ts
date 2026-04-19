import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadToolsConfig } from "../config/schema.js";
import { buildRedactionPlans, redact } from "./redact.js";

// Top-level await: supported in ESM + Node 22. node:test collects `it()`
// calls at module evaluation, so we need the config loaded before describe
// blocks run.
const config = await loadToolsConfig();
const plans = buildRedactionPlans(config);

function setByPath(root: Record<string, unknown>, dotted: string, value: unknown) {
  const parts = dotted.split(".");
  let node: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = node[key];
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function getByPath(root: unknown, dotted: string): unknown {
  const parts = dotted.split(".");
  let node: unknown = root;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const LEAK_FIELDS: Record<string, string> = {
  _leak_ssn: "123-45-6789",
  _leak_medicare: "2 1234 56789 1",
  _leak_unexpected_patient_note: "free-text with PII leaking through"
};

describe("tools.json — structural invariants", () => {
  it("every non-deprecated tool has at least one declared return field", () => {
    const violators = config.tools
      .filter(t => !t.deprecated)
      .filter(t => Object.keys(t.returns).length === 0)
      .map(t => t.tool_name);
    assert.deepEqual(
      violators,
      [],
      `Tools with empty returns opt out of BOTH redaction and strict mode. ` +
        `Populate returns or mark deprecated: ${violators.join(", ")}`
    );
  });

  it("strict_returns is enabled", () => {
    assert.equal(
      config.strict_returns,
      true,
      "strict_returns must be true — otherwise undeclared upstream fields leak."
    );
  });

  it("redactionValue is a non-empty string", () => {
    assert.ok(
      typeof config.redactionValue === "string" && config.redactionValue.length > 0,
      "redactionValue must be a non-empty string"
    );
  });
});

describe("per-tool redaction coverage", () => {
  for (const tool of config.tools) {
    if (tool.deprecated) continue;
    if (Object.keys(tool.returns).length === 0) continue;

    it(`${tool.tool_name}: redacts PII, preserves non-PII, drops undeclared`, () => {
      const plan = plans.get(tool.tool_name);
      assert.ok(plan, `missing redaction plan for ${tool.tool_name}`);

      const upstream: Record<string, unknown> = {};
      for (const path of Object.keys(tool.returns)) {
        setByPath(upstream, path, `SENTINEL|${tool.tool_name}|${path}`);
      }
      for (const [k, v] of Object.entries(LEAK_FIELDS)) {
        upstream[k] = v;
      }

      const redacted = redact(plan, upstream);

      for (const [path, def] of Object.entries(tool.returns)) {
        const value = getByPath(redacted, path);
        if (def.pii) {
          assert.equal(
            value,
            config.redactionValue,
            `${tool.tool_name}: pii path "${path}" should be redacted, got ${JSON.stringify(value)}`
          );
        } else {
          assert.equal(
            value,
            `SENTINEL|${tool.tool_name}|${path}`,
            `${tool.tool_name}: non-pii path "${path}" should pass through, got ${JSON.stringify(value)}`
          );
        }
      }

      const r = redacted as Record<string, unknown>;
      for (const k of Object.keys(LEAK_FIELDS)) {
        assert.equal(
          r[k],
          undefined,
          `${tool.tool_name}: undeclared field "${k}" leaked through redaction`
        );
      }
    });
  }
});

describe("per-tool collection-shape redaction (array of items)", () => {
  // For any tool whose returns contain `*.items.*` paths, also test the real
  // array shape — this catches bugs where arrays don't route paths correctly.
  for (const tool of config.tools) {
    if (tool.deprecated) continue;
    const itemPaths = Object.entries(tool.returns).filter(([p]) => p.includes(".items."));
    if (itemPaths.length === 0) continue;

    it(`${tool.tool_name}: redacts inside a real data.items array`, () => {
      const plan = plans.get(tool.tool_name);
      assert.ok(plan);

      // Build one item that populates every *.items.* leaf.
      const item: Record<string, unknown> = {};
      for (const [fullPath] of itemPaths) {
        const afterItems = fullPath.split(".items.")[1]!;
        setByPath(item, afterItems, `SENTINEL|${tool.tool_name}|${fullPath}`);
      }
      // Add an undeclared field inside the item — strict mode must drop it.
      item._leak_item = "leaked-inside-array";

      // Build the top-level envelope with the items array.
      const envelope: Record<string, unknown> = {};
      for (const [path] of Object.entries(tool.returns)) {
        if (path.includes(".items.")) continue;
        setByPath(envelope, path, `SENTINEL|${tool.tool_name}|${path}`);
      }
      // Put the items array at the parent of the first `*.items.*` path.
      const parent = itemPaths[0]![0].split(".items.")[0]! + ".items";
      setByPath(envelope, parent, [item, item]);

      const redacted = redact(plan, envelope);

      // Walk into the redacted array and check each item.
      const arr = getByPath(redacted, parent);
      assert.ok(Array.isArray(arr), `${tool.tool_name}: expected array at ${parent}`);
      for (const el of arr as unknown[]) {
        for (const [fullPath, def] of itemPaths) {
          const afterItems = fullPath.split(".items.")[1]!;
          const value = getByPath(el, afterItems);
          if (def.pii) {
            assert.equal(value, config.redactionValue, `${tool.tool_name}: ${fullPath} in-array should be redacted`);
          } else {
            assert.equal(
              value,
              `SENTINEL|${tool.tool_name}|${fullPath}`,
              `${tool.tool_name}: ${fullPath} in-array should pass through`
            );
          }
        }
        const leak = (el as Record<string, unknown>)._leak_item;
        assert.equal(leak, undefined, `${tool.tool_name}: undeclared in-array field leaked`);
      }
    });
  }
});
