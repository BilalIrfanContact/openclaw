import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { assert, describe, expect, it } from "vitest";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const rejected = (toolName: string, violation: string) => ({
  tools: [],
  diagnostics: [{ toolName, toolIndex: 0, violations: [violation] }],
});
function expectInvalid(schema: unknown, path: string) {
  expect(projectRuntimeToolInputSchema(schema)).toEqual({
    schema: {},
    violations: [`parameters.${path} is not JSON-serializable`],
  });
}
function expectFiniteDefault(value: unknown) {
  expect(projectRuntimeToolInputSchema(objectSchema({ score: { default: value } }))).toEqual({
    schema: objectSchema({ score: { default: { value: "finite" } } }),
    violations: [],
  });
}

describe("runtime tool input schema projection", () => {
  it("reports dynamic JSON Schema keywords in traversal order with exact paths", () => {
    const schema = {
      type: "object",
      $dynamicAnchor: "root",
      $dynamicRef: "#root",
      anyOf: [{ $dynamicAnchor: "branch" }, { properties: { "": { $dynamicRef: "#empty" } } }],
      $defs: { $dynamicAnchor: { type: "string" } },
      properties: {
        $dynamicRef: { type: "string" },
        target: { $dynamicRef: "#target" },
        "literal.dot[0]": { $dynamicAnchor: "literal" },
      },
    };
    const expectedSchema = structuredClone(schema);
    expect(projectRuntimeToolInputSchema(schema)).toEqual({
      schema: expectedSchema,
      violations: [
        "parameters.$dynamicRef",
        "parameters.$dynamicAnchor",
        "parameters.anyOf[0].$dynamicAnchor",
        "parameters.anyOf[1].properties..$dynamicRef",
        "parameters.properties.target.$dynamicRef",
        "parameters.properties.literal.dot[0].$dynamicAnchor",
      ],
    });
    expect(schema).toEqual(expectedSchema);
  });

  it.each<[string, unknown, string]>([
    ["", Infinity, "properties..maximum"],
    ["score", Object(Infinity), "properties.score.maximum"],
  ])("reports non-finite limits at %s", (name, maximum, path) => {
    expectInvalid(objectSchema({ [name]: { type: "number", maximum } }), path);
  });

  it("tracks repeated descendants through each toJSON replacement without rereading getters", () => {
    const reads: string[] = [];
    let count = 0;
    const shared = {
      type: "number",
      get maximum() {
        reads.push("maximum");
        return count++ === 0 ? 1 : Number.POSITIVE_INFINITY;
      },
    };
    const replacement = {
      toJSON(key: string) {
        reads.push(key);
        return { type: "array", items: [shared] };
      },
    };

    expectInvalid(
      objectSchema({ first: replacement, second: replacement }),
      "properties.second.items[0].maximum",
    );
    expect(reads).toEqual(["first", "maximum", "second", "maximum"]);
  });

  it.each([
    { [Symbol.toStringTag]: "Number", value: "finite" },
    {
      get [Symbol.toStringTag](): string {
        throw new Error("unreadable tag");
      },
      value: "finite",
    },
  ])("ignores non-JSON Number tags (%#)", expectFiniteDefault);

  it("reuses published inspection facts without copying their empty diagnostics across attempts", () => {
    const projection = publishRuntimeToolInputSchema(objectSchema({ query: { type: "string" } }));
    assert(projection.schema !== null && typeof projection.schema === "object");
    const tool = { name: "search", parameters: projection.schema };
    const iterator = Array.prototype[Symbol.iterator];
    let diagnosticCopies = 0;
    // eslint-disable-next-line no-extend-native -- Count copies without a spy recursively iterating its own call arguments.
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this === projection.violations) {
        diagnosticCopies++;
      }
      return iterator.call(this);
    };
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        filterRuntimeCompatibleTools([tool]);
      }
    } finally {
      // eslint-disable-next-line no-extend-native -- Restore synchronous work-count instrumentation even on failure.
      Array.prototype[Symbol.iterator] = iterator;
    }
    expect(diagnosticCopies).toBe(0);
  });

  it("rechecks current descriptors and mutable schemas across filter modes and recovery", () => {
    const parameters = { type: "object", $dynamicRef: "#node" };
    let unreadableName = false;
    let unreadableParameters = false;
    const tool = {
      get name() {
        if (unreadableName) {
          throw new Error("unreadable name");
        }
        return "mutable";
      },
      get parameters() {
        if (unreadableParameters) {
          throw new Error("unreadable parameters");
        }
        return parameters;
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(filterProviderNormalizableTools([tool])).toEqual({ tools: [tool], diagnostics: [] });
      expect(filterRuntimeCompatibleTools([tool])).toEqual(
        rejected("mutable", "mutable.parameters.$dynamicRef"),
      );
    }
    Reflect.deleteProperty(parameters, "$dynamicRef");
    expect(filterRuntimeCompatibleTools([tool])).toEqual({ tools: [tool], diagnostics: [] });
    unreadableName = true;
    unreadableParameters = true;
    expect(filterRuntimeCompatibleTools([tool])).toEqual({
      tools: [],
      diagnostics: [
        {
          toolName: "tool[0]",
          toolIndex: 0,
          violations: ["tool[0].name is unreadable", "tool[0].parameters is unreadable"],
        },
      ],
    });
    unreadableParameters = false;
    expect(filterRuntimeCompatibleTools([tool])).toEqual(
      rejected("tool[0]", "tool[0].name is unreadable"),
    );
    unreadableName = false;
    expect(filterRuntimeCompatibleTools([tool])).toEqual({ tools: [tool], diagnostics: [] });
  });
});
