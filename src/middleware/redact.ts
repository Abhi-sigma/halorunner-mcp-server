import type { ToolDef, ToolsConfig } from "../config/schema.js";

export interface RedactionPlan {
  /** Dotted paths where pii:true, e.g. ["firstName", "patient.name", "data.patient_dob"]. */
  readonly piiPaths: ReadonlySet<string>;
  /** All declared return paths (pii or not). Used to enforce strict_returns. */
  readonly declaredPaths: ReadonlySet<string>;
  readonly strict: boolean;
  readonly redactionValue: string;
}

/**
 * Pre-compile a redaction plan for every tool. Called once at startup.
 */
export function buildRedactionPlans(config: ToolsConfig): Map<string, RedactionPlan> {
  const plans = new Map<string, RedactionPlan>();
  for (const tool of config.tools) {
    plans.set(tool.tool_name, buildPlanForTool(tool, config));
  }
  return plans;
}

function buildPlanForTool(tool: ToolDef, config: ToolsConfig): RedactionPlan {
  const piiPaths = new Set<string>();
  const declaredPaths = new Set<string>();
  for (const [path, def] of Object.entries(tool.returns)) {
    declaredPaths.add(path);
    if (def.pii) piiPaths.add(path);
  }
  return {
    piiPaths,
    declaredPaths,
    strict: config.strict_returns,
    redactionValue: config.redactionValue
  };
}

/**
 * Apply a redaction plan to an arbitrary response body.
 *
 * Rules:
 *   - If a dotted path appears in piiPaths, the value at that key is replaced
 *     with the redaction sentinel (nulls stay null).
 *   - Arrays do NOT extend the path; rules apply to each element at the same
 *     depth. So rule "firstName" matches every element of a top-level array.
 *   - If strict is true, any object key not in declaredPaths is dropped.
 *   - If the plan has no declaredPaths (tool has no `returns`), the response
 *     is returned untouched — treated as opt-out of both redaction and strict.
 */
export function redact(plan: RedactionPlan, body: unknown): unknown {
  if (plan.declaredPaths.size === 0) return body;
  return walk(body, [], plan);
}

function walk(node: unknown, path: string[], plan: RedactionPlan): unknown {
  if (Array.isArray(node)) {
    return node.map(item => walk(item, path, plan));
  }

  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const childPath = [...path, key];
      const dotted = childPath.join(".");
      const value = (node as Record<string, unknown>)[key];

      // strict_returns: drop any field not declared anywhere.
      if (plan.strict && !isDeclaredAtOrBelow(dotted, plan.declaredPaths)) {
        continue;
      }

      if (plan.piiPaths.has(dotted)) {
        out[key] = value === null ? null : plan.redactionValue;
      } else {
        out[key] = walk(value, childPath, plan);
      }
    }
    return out;
  }

  return node;
}

/**
 * A field at path "a.b" is allowed if either "a.b" is declared directly
 * (leaf declaration) or some descendant "a.b.c" is declared (nested parent).
 */
function isDeclaredAtOrBelow(path: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(path)) return true;
  const prefix = path + ".";
  for (const p of declared) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}
