import { describe, expect, test } from "vitest";
import { scrub } from "../scrub.js";
import { CENSOR } from "../rules.js";

/** Wraps `{ [leafKey]: leafValue }` `depth` levels deep under `nested` keys. depth 0 puts the leaf at the root. */
function buildNested(depth: number, leafKey: string, leafValue: unknown): unknown {
  let node: unknown = { [leafKey]: leafValue };
  for (let i = 0; i < depth; i++) {
    node = { nested: node };
  }
  return node;
}

function digDepth(value: unknown, depth: number): unknown {
  let node = value as Record<string, unknown>;
  for (let i = 0; i < depth; i++) {
    node = node.nested as Record<string, unknown>;
  }
  return node;
}

describe("scrub", () => {
  test("Test 1: a provider-key-shaped value at depth one is redacted", () => {
    const input = buildNested(1, "value", "SG.aaaaaaaaaa.bbbbbbbbbb");
    const output = scrub(input) as Record<string, unknown>;
    const leaf = digDepth(output, 1) as Record<string, unknown>;
    expect(leaf.value).toBe(CENSOR);
  });

  test("Test 2 (backstop probe): a provider-key-shaped value at depth SEVEN, inside nested plain objects, is redacted -- a depth PINO_REDACT_OPTIONS's 3-level path list provably cannot reach", () => {
    const DEPTH = 7;
    const input = buildNested(DEPTH, "value", "SG.cccccccccc.dddddddddd");
    const output = scrub(input);
    const leaf = digDepth(output, DEPTH) as Record<string, unknown>;
    expect(leaf.value).toBe(CENSOR);
  });

  test("Test 3: a value inside an array of objects nested inside another array is redacted", () => {
    const input = {
      data: [[{ contact: "person@example.com" }, { contact: "harmless" }]],
    };
    const output = scrub(input) as { data: Array<Array<Record<string, unknown>>> };
    expect(output.data[0][0].contact).toBe(CENSOR);
    expect(output.data[0][1].contact).toBe("harmless");
  });

  test("Test 4: an email address and a phone number in value position, under a key name that matches no rule, are redacted by value pattern", () => {
    const input = {
      note: "jane.doe@example.com",
      reachAt: "+1 415-555-0199",
    };
    const output = scrub(input) as Record<string, unknown>;
    expect(output.note).toBe(CENSOR);
    expect(output.reachAt).toBe(CENSOR);
  });

  test("Test 5: a key whose name matches a secret rule is redacted regardless of its value's shape", () => {
    const input = { password: { weird: "shape", count: 42 } };
    const output = scrub(input) as Record<string, unknown>;
    expect(output.password).toBe(CENSOR);
  });

  test("Test 6: a non-matching string, number, null and undefined pass through unchanged, and the input object is not mutated", () => {
    const input = {
      plainString: "hello world",
      num: 42,
      isNull: null,
      isUndefined: undefined,
    };
    const snapshotKeys = Object.keys(input);
    const snapshotValues = { ...input };

    const output = scrub(input) as Record<string, unknown>;

    expect(output.plainString).toBe("hello world");
    expect(output.num).toBe(42);
    expect(output.isNull).toBeNull();
    expect(output.isUndefined).toBeUndefined();

    // Not mutated: the input's own keys/values are unchanged after the call.
    expect(Object.keys(input)).toEqual(snapshotKeys);
    expect(input).toEqual(snapshotValues);
  });

  test("Test 7: a self-referencing object does not cause infinite recursion", () => {
    const input: Record<string, unknown> = { name: "cycle" };
    input.self = input;

    const output = scrub(input) as Record<string, unknown>;

    expect(output.name).toBe("cycle");
    // The cycle must have been broken -- JSON.stringify throws on a
    // circular structure, so a successful stringify proves scrub() did not
    // just copy the reference back into the output tree.
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  test("Error instances preserve name/message/stack (message scrubbed by value pattern) and scrub their own enumerable properties -- console.error(msg, err) must not collapse to {}", () => {
    const err = new Error("failed for user@example.com") as Error & { sendgridKey?: string };
    err.sendgridKey = "SG.eeeeeeeeee.ffffffffff";

    const output = scrub(err) as { name: string; message: string; stack: string; sendgridKey: string };

    expect(output.name).toBe("Error");
    expect(output.message).toBe(CENSOR);
    expect(output.stack).toBe(err.stack);
    expect(output.sendgridKey).toBe(CENSOR);
  });
});
