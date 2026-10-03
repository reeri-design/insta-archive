import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AiProviderError, type OrganizationRequest } from "../organization-provider.ts";
import { ORGANIZATION_OUTPUT_SCHEMA } from "../organization-schema.ts";
import { AnthropicOrganizationProvider, DEFAULT_ANTHROPIC_MODEL, type AnthropicMessagesClient } from "./anthropic-organization-provider.ts";
import { createOrganizationProvider } from "./index.ts";

const REQUEST: OrganizationRequest = {
  instructions: "Organize this.",
  content: "Caption: hello",
  images: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
  outputSchema: ORGANIZATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

/** A stub SDK client: records the request, returns the given message (or throws). */
function stubClient(reply: () => unknown) {
  const calls: unknown[] = [];
  const client = {
    beta: { messages: { create: async (params: unknown) => { calls.push(params); return reply(); } } },
  } as unknown as AnthropicMessagesClient;
  return { client, calls };
}
const message = (overrides: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"type":"idea","category":"other","tags":["a","b","c"],"summary":"s","usefulFor":["u"],"confidence":0.5}' }],
  usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...overrides,
});

test("builds a structured-output request with images first and parses the JSON reply", async () => {
  const { client, calls } = stubClient(() => message());
  const provider = new AnthropicOrganizationProvider({ client });
  assert.equal(provider.provider, "anthropic");
  assert.equal(provider.model, DEFAULT_ANTHROPIC_MODEL);

  const response = await provider.organize(REQUEST);
  assert.deepEqual(response, {
    output: { type: "idea", category: "other", tags: ["a", "b", "c"], summary: "s", usefulFor: ["u"], confidence: 0.5 },
    model: "claude-opus-5-5",
    usage: { inputTokens: 1200, outputTokens: 80 },
  });
  const params = calls[0] as Record<string, unknown>;
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.system, "Organize this.");
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(params.output_config, { effort: "low", format: { type: "json_schema", schema: REQUEST.outputSchema } });
  assert.deepEqual(params.messages, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "text", text: "Caption: hello" },
    ],
  }]);
});

test("refusals, truncation and non-JSON replies become typed provider errors", async () => {
  const cases: [unknown, string][] = [
    [message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] }), "refusal"],
    [message({ stop_reason: "max_tokens" }), "invalid_output"],
    [message({ content: [{ type: "text", text: "not json" }] }), "invalid_output"],
  ];
  for (const [reply, kind] of cases) {
    const provider = new AnthropicOrganizationProvider({ client: stubClient(() => reply).client });
    await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === kind);
  }
});

test("SDK errors are mapped without leaking SDK types", async () => {
  const headers = new Headers();
  const cases: [Error, string][] = [
    [new Anthropic.RateLimitError(429, undefined, "rate limited", headers), "rate_limited"],
    [new Anthropic.AuthenticationError(401, undefined, "bad key", headers), "authentication"],
    [new Anthropic.InternalServerError(500, undefined, "boom", headers), "provider_error"],
    [new Error("socket hang up"), "provider_error"],
  ];
  for (const [error, kind] of cases) {
    const provider = new AnthropicOrganizationProvider({ client: stubClient(() => { throw error; }).client });
    await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === kind);
  }
});

test("missing credentials fail as 'authentication' before any request is sent", async () => {
  let fetched = false;
  const client = new Anthropic({
    apiKey: null,
    authToken: null,
    maxRetries: 0,
    fetch: async () => {
      fetched = true;
      throw new Error("network must not be used");
    },
  });
  const provider = new AnthropicOrganizationProvider({ client });
  await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === "authentication");
  assert.equal(fetched, false);
});

test("the factory picks the configured provider and model", () => {
  assert.equal(createOrganizationProvider({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test" }).model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(createOrganizationProvider({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "test" }).model, "claude-sonnet-5-5");
  assert.throws(() => createOrganizationProvider({ AI_PROVIDER: "other" }), /Unsupported AI_PROVIDER "other"/);
});
