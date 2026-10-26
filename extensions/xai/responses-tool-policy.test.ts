import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";
import { requestXaiWebSearch } from "./src/web-search-shared.js";
import { requestXaiXSearch } from "./src/x-search-shared.js";

afterEach(() => vi.unstubAllGlobals());

const connection = { apiKey: "synthetic-tool-fixture", timeoutSeconds: 5 };
const endpoint = "https://api.x.ai/v1/responses";
const search = { ...connection, endpoint, inlineCitations: false };
const callers = [
  {
    name: "web_search",
    grok43Effort: "low",
    run: (model: string) =>
      requestXaiWebSearch({
        ...search,
        model,
        query: "fixture",
      }),
  },
  {
    name: "x_search",
    grok43Effort: "none",
    run: (model: string) =>
      requestXaiXSearch({
        ...search,
        model,
        options: { query: "fixture" },
      }),
  },
  {
    name: "code_execution",
    grok43Effort: "low",
    run: (model: string) => {
      const config = {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: { apiKey: connection.apiKey },
                codeExecution: { model, timeoutSeconds: connection.timeoutSeconds },
              },
            },
          },
        },
      };
      const tool = createCodeExecutionTool({ config, runtimeConfig: config });
      if (!tool) {
        throw new Error("Expected xAI code execution tool");
      }
      return tool.execute("code-execution:policy-fixture", { task: "fixture" });
    },
  },
];

async function capture(run: (model: string) => Promise<unknown>, model: string) {
  const request = vi.fn<typeof fetch>(async () => Response.json({ output_text: "fixture result" }));
  vi.stubGlobal("fetch", withFetchPreconnect(request));
  await run(model);
  expect(request).toHaveBeenCalledOnce();
  const init = request.mock.calls[0]?.[1];
  expect(init).toEqual(expect.objectContaining({ body: expect.any(String) }));
  return new Request(endpoint, init).json();
}

it.each(
  callers.flatMap(({ name, run, grok43Effort }) =>
    [
      { model: "grok-4.7", reasoning: { effort: "low" } },
      { model: "grok-4.8", reasoning: { effort: "low" } },
      { model: "grok-4.5", reasoning: undefined },
      { model: "grok-4.3", reasoning: { effort: grok43Effort } },
    ].map(({ model, reasoning }) => ({ name, run, model, reasoning })),
  ),
)("preserves $name model and reasoning policy for $model", async ({ run, model, reasoning }) => {
  const body = await capture(run, model);
  expect(body).toMatchObject({ model, store: false });
  expect(body.reasoning).toEqual(reasoning);
});
