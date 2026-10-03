import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { AiProviderError, type OrganizationRequest } from "../organization-provider.ts";
import { ORGANIZATION_OUTPUT_SCHEMA } from "../organization-schema.ts";
import { createOrganizationProvider } from "./index.ts";
import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterOrganizationProvider,
  type OpenRouterFetch,
} from "./openrouter-organization-provider.ts";

const API_KEY = "sk-or-test-not-a-real-key";
const REQUEST: OrganizationRequest = {
  instructions: "Organize this.",
  content: "Caption: hello",
  images: [
    { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
    { mimeType: "image/png", bytes: new Uint8Array([1, 2]) },
  ],
  outputSchema: ORGANIZATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};
const OUTPUT = { type: "idea", category: "other", tags: ["a", "b", "c"], summary: "s", usefulFor: ["u"], confidence: 0.5 };

/** A stub fetch: records each call, answers with the given status and body. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: OpenRouterFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}
const completion = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
  model: DEFAULT_OPENROUTER_MODEL,
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(OUTPUT), ...message } }],
  usage: { prompt_tokens: 900, completion_tokens: 420, cost: 0 },
  ...overrides,
});
const provider = (fetch: OpenRouterFetch, model?: string) =>
  new OpenRouterOrganizationProvider({ apiKey: API_KEY, fetch, ...(model && { model }) });
const rejectsWith = (promise: Promise<unknown>, kind: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof AiProviderError && e.kind === kind);

test("sends a JSON-schema chat completion with the text first, then the images, and parses the reply", async () => {
  const { fetch, calls } = stubFetch(200, completion());
  const openrouter = provider(fetch);
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.model, DEFAULT_OPENROUTER_MODEL);

  assert.deepEqual(await openrouter.organize(REQUEST), {
    output: OUTPUT,
    model: DEFAULT_OPENROUTER_MODEL,
    usage: { inputTokens: 900, outputTokens: 420 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    model: DEFAULT_OPENROUTER_MODEL,
    messages: [
      { role: "system", content: "Organize this." },
      {
        role: "user",
        content: [
          { type: "text", text: "Caption: hello" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQI=" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "archive_organization", strict: true, schema: ORGANIZATION_OUTPUT_SCHEMA },
    },
    provider: { require_parameters: true },
  });
});

test("a metadata-only request sends just the text, and the model is configurable", async () => {
  const { fetch, calls } = stubFetch(200, completion({ model: "some-org/other-model" }));
  const result = await provider(fetch, "some-org/other-model").organize({ ...REQUEST, images: [] });
  assert.equal(result.model, "some-org/other-model");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.model, "some-org/other-model");
  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "Caption: hello" }]);
});

test("HTTP errors map to provider-agnostic kinds", async () => {
  const cases: [number, string][] = [
    [429, "rate_limited"],
    [401, "authentication"],
    [403, "authentication"],
    [400, "provider_error"],
    [503, "provider_error"],
  ];
  for (const [status, kind] of cases) {
    await rejectsWith(provider(stubFetch(status, { error: { message: "nope", code: status } }).fetch).organize(REQUEST), kind);
  }
});

test("network failures and upstream errors returned with HTTP 200 are provider errors", async () => {
  await rejectsWith(provider(async () => { throw new Error("fetch failed"); }).organize(REQUEST), "provider_error");
  await rejectsWith(provider(stubFetch(200, { error: { code: 502, message: "upstream down" } }).fetch).organize(REQUEST), "provider_error");
  await rejectsWith(provider(stubFetch(200, "<html>gateway</html>").fetch).organize(REQUEST), "provider_error");
});

test("refusals, truncation and malformed output become typed errors", async () => {
  const cases: [unknown, string][] = [
    [completion({}, { refusal: "I can't help with that." }), "refusal"],
    [completion({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }), "refusal"],
    [completion({ choices: [{ finish_reason: "length", message: { content: "{\"type\":" } }] }), "invalid_output"],
    [completion({}, { content: "Sure! Here is the JSON: {" }), "invalid_output"],
    [completion({}, { content: null }), "invalid_output"],
    [completion({ choices: [] }), "invalid_output"],
  ];
  for (const [reply, kind] of cases) {
    await rejectsWith(provider(stubFetch(200, reply).fetch).organize(REQUEST), kind);
  }
});

test("the API key is sent only in the Authorization header, never in the body or an error", async () => {
  const { fetch, calls } = stubFetch(200, completion());
  await provider(fetch).organize(REQUEST);
  assert.deepEqual(calls[0]?.init.headers, { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });
  assert.ok(!String(calls[0]?.init.body).includes(API_KEY));

  for (const status of [400, 401, 403, 429, 500]) {
    const error = await provider(stubFetch(status, { error: { message: "bad" } }).fetch).organize(REQUEST).catch((e: unknown) => e);
    assert.ok(error instanceof AiProviderError);
    assert.ok(!error.message.includes(API_KEY), `HTTP ${status} error exposes the key`);
    assert.ok(!(error.stack ?? "").includes(API_KEY));
  }
  assert.ok(!JSON.stringify(provider(fetch)).includes(API_KEY), "serializing the provider exposes the key");
  assert.ok(!inspect(provider(fetch), { depth: 5 }).includes(API_KEY), "logging the provider exposes the key");
});

test("without an API key it fails as 'authentication' and never calls the API", async () => {
  const { fetch, calls } = stubFetch(200, completion());
  const openrouter = new OpenRouterOrganizationProvider({ fetch });
  await assert.rejects(openrouter.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === "authentication" && /OPENROUTER_API_KEY/.test(e.message));
  assert.equal(calls.length, 0);
});

test("the factory selects OpenRouter with AI_PROVIDER=openrouter, defaulting to the Dots model", () => {
  const openrouter = createOrganizationProvider({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: API_KEY });
  assert.ok(openrouter instanceof OpenRouterOrganizationProvider);
  assert.deepEqual([openrouter.provider, openrouter.model], ["openrouter", "dots-studio/dots-3-note-preview:free"]);
  assert.equal(createOrganizationProvider({ AI_PROVIDER: "openrouter", AI_MODEL: "some-org/other-model" }).model, "some-org/other-model");
});
