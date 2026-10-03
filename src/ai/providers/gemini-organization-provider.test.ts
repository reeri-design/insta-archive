import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "@google/genai";
import { AiProviderError, type OrganizationRequest } from "../organization-provider.ts";
import { ORGANIZATION_OUTPUT_SCHEMA } from "../organization-schema.ts";
import { DEFAULT_GEMINI_MODEL, GeminiOrganizationProvider, type GeminiModelsClient } from "./gemini-organization-provider.ts";
import { createOrganizationProvider } from "./index.ts";

const REQUEST: OrganizationRequest = {
  instructions: "Organize this.",
  content: "Caption: hello",
  images: [{ mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }],
  outputSchema: ORGANIZATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};
const OUTPUT = { type: "idea", category: "other", tags: ["a", "b", "c"], summary: "s", usefulFor: ["u"], confidence: 0.5 };

/** A stub SDK client: records the request, returns the given response (or throws). */
function stubClient(reply: () => unknown) {
  const calls: unknown[] = [];
  const client = {
    models: { generateContent: async (params: unknown) => { calls.push(params); return reply(); } },
  } as unknown as GeminiModelsClient;
  return { client, calls };
}
const response = (overrides: Record<string, unknown> = {}) => ({
  text: JSON.stringify(OUTPUT),
  modelVersion: "gemini-3.8-flash-001",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, thoughtsTokenCount: 300 },
  ...overrides,
});

test("sends a JSON-schema request with the text first, then the images, and parses the reply", async () => {
  const { client, calls } = stubClient(() => response());
  const provider = new GeminiOrganizationProvider({ client });
  assert.equal(provider.provider, "gemini");
  assert.equal(provider.model, DEFAULT_GEMINI_MODEL);

  assert.deepEqual(await provider.organize(REQUEST), {
    output: OUTPUT,
    model: "gemini-3.8-flash-001",
    usage: { inputTokens: 900, outputTokens: 420 }, // thinking counted as output
  });
  assert.deepEqual(calls[0], {
    model: DEFAULT_GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: "Caption: hello" }, { inlineData: { mimeType: "image/jpeg", data: "AQID" } }] }],
    config: { systemInstruction: "Organize this.", responseMimeType: "application/json", responseJsonSchema: REQUEST.outputSchema },
  });
});

test("blocked prompts, safety stops, truncation and non-JSON become typed errors", async () => {
  const cases: [unknown, string][] = [
    [response({ promptFeedback: { blockReason: "SAFETY" }, candidates: [], text: undefined }), "refusal"],
    [response({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }), "refusal"],
    [response({ candidates: [{ finishReason: "MAX_TOKENS" }] }), "invalid_output"],
    [response({ text: "Sure! Here is the JSON: {" }), "invalid_output"],
    [response({ text: undefined }), "invalid_output"],
  ];
  for (const [reply, kind] of cases) {
    const provider = new GeminiOrganizationProvider({ client: stubClient(() => reply).client });
    await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === kind, JSON.stringify(reply));
  }
});

test("API errors map to provider-agnostic kinds", async () => {
  const cases: [Error, string][] = [
    [new ApiError({ status: 429, message: "Resource exhausted" }), "rate_limited"],
    [new ApiError({ status: 403, message: "Permission denied" }), "authentication"],
    [new ApiError({ status: 400, message: "API key not valid. Please pass a valid API key." }), "authentication"],
    [new ApiError({ status: 400, message: "Invalid JSON schema" }), "provider_error"],
    [new ApiError({ status: 503, message: "Unavailable" }), "provider_error"],
    [new Error("fetch failed"), "provider_error"],
  ];
  for (const [error, kind] of cases) {
    const provider = new GeminiOrganizationProvider({ client: stubClient(() => { throw error; }).client });
    await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === kind, error.message);
  }
});

test("declares only the image types Gemini accepts (no GIF)", () => {
  assert.deepEqual([...new GeminiOrganizationProvider({}).supportedImageTypes], ["image/jpeg", "image/png", "image/webp"]);
});

test("without an API key it fails as 'authentication' and never calls the API", async () => {
  const provider = new GeminiOrganizationProvider({});
  await assert.rejects(provider.organize(REQUEST), (e: unknown) => e instanceof AiProviderError && e.kind === "authentication" && /GEMINI_API_KEY/.test(e.message));
});

test("the factory defaults to Gemini and reads its key and model from the environment", () => {
  const gemini = createOrganizationProvider({});
  assert.deepEqual([gemini.provider, gemini.model], ["gemini", DEFAULT_GEMINI_MODEL]);
  assert.equal(createOrganizationProvider({ AI_PROVIDER: "gemini", AI_MODEL: "gemini-3.5-flash-lite", GEMINI_API_KEY: "not-a-real-key" }).model, "gemini-3.5-flash-lite");
});
