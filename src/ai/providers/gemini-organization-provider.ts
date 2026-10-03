/**
 * OrganizationProvider on Google's Gemini API. The only module that knows
 * about the Gemini SDK or Gemini model names; it maps to and from the
 * provider-agnostic types.
 */
import { ApiError, GoogleGenAI, type GenerateContentResponse, type Part } from "@google/genai";
import {
  AiProviderError,
  type OrganizationProvider,
  type OrganizationRequest,
  type OrganizationResponse,
} from "../organization-provider.ts";

/** Newest stable Flash model (free tier available). Override with AI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** The part of the SDK client this provider uses (injectable for tests). */
export type GeminiModelsClient = {
  models: { generateContent: GoogleGenAI["models"]["generateContent"] };
};

/** Finish reasons meaning the model declined or was stopped by a safety filter. */
const DECLINED_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT",
]);

export class GeminiOrganizationProvider implements OrganizationProvider {
  readonly provider = "gemini";
  readonly model: string;
  /** Gemini image input supports PNG, JPEG, WEBP (and HEIC/HEIF); not GIF. */
  readonly supportedImageTypes = ["image/jpeg", "image/png", "image/webp"] as const;
  private readonly client: GeminiModelsClient | undefined;

  constructor(options: { apiKey?: string; model?: string; client?: GeminiModelsClient } = {}) {
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.client = options.client ?? (options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey }) : undefined);
  }

  async organize(request: OrganizationRequest): Promise<OrganizationResponse> {
    if (!this.client) {
      throw new AiProviderError("authentication", "No Gemini API key configured (set GEMINI_API_KEY)");
    }
    // Google's guidance: text before the image(s). Images keep their order.
    const parts: Part[] = [
      { text: request.content },
      ...request.images.map((image): Part => ({
        inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") },
      })),
    ];

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: request.instructions,
          responseMimeType: "application/json",
          responseJsonSchema: request.outputSchema,
        },
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new AiProviderError("refusal", `Prompt blocked (${blocked})`);
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && DECLINED_FINISH_REASONS.has(finish)) {
      throw new AiProviderError("refusal", `Response stopped (${finish})`);
    }
    if (finish === "MAX_TOKENS") throw new AiProviderError("invalid_output", "Response was cut off (MAX_TOKENS)");

    let output: unknown;
    try {
      output = JSON.parse(response.text ?? "");
    } catch {
      throw new AiProviderError("invalid_output", "Response was not valid JSON");
    }
    const usage = response.usageMetadata;
    return {
      output,
      model: response.modelVersion ?? this.model,
      ...(usage && {
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          // Thinking tokens are billed as output.
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        },
      }),
    };
  }
}

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof ApiError) {
    if (error.status === 429) return new AiProviderError("rate_limited", error.message);
    if (error.status === 401 || error.status === 403) return new AiProviderError("authentication", error.message);
    // Gemini reports a bad key as 400 INVALID_ARGUMENT "API key not valid".
    if (error.status === 400 && /api key/i.test(error.message)) return new AiProviderError("authentication", "Gemini rejected the API key");
    return new AiProviderError("provider_error", `API error ${error.status}: ${error.message}`);
  }
  return new AiProviderError("provider_error", error instanceof Error ? error.message : String(error));
}
