/**
 * OrganizationProvider on Anthropic's Claude API. The only module that knows
 * about the Anthropic SDK; it maps to and from the provider-agnostic types.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  AiProviderError,
  type OrganizationProvider,
  type OrganizationRequest,
  type OrganizationResponse,
} from "../organization-provider.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** The part of the SDK client this provider uses (injectable for tests). */
export type AnthropicMessagesClient = {
  beta: { messages: { create: Anthropic["beta"]["messages"]["create"] } };
};

export class AnthropicOrganizationProvider implements OrganizationProvider {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly client: AnthropicMessagesClient;

  constructor(options: { model?: string; client?: AnthropicMessagesClient } = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    // Credentials are resolved by the SDK (ANTHROPIC_API_KEY, or an `ant auth login` profile).
    this.client = options.client ?? new Anthropic();
  }

  async organize(request: OrganizationRequest): Promise<OrganizationResponse> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...request.images.map((image): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: Buffer.from(image.bytes).toString("base64") },
      })),
      { type: "text", text: request.content },
    ];

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // A safety-classifier decline is retried server-side on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: request.instructions,
        // Classification task: low effort; output constrained to the JSON schema.
        output_config: { effort: "low", format: { type: "json_schema", schema: request.outputSchema } },
        messages: [{ role: "user", content }],
      });
    } catch (error) {
      throw toProviderError(error);
    }

    if (response.stop_reason === "refusal") {
      throw new AiProviderError("refusal", `Model declined (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiProviderError("invalid_output", "Response was cut off at max_tokens");
    }
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AiProviderError("invalid_output", "Response was not valid JSON");
    }
    return {
      output,
      model: response.model,
      usage: {
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof Anthropic.RateLimitError) return new AiProviderError("rate_limited", error.message);
  // No credentials at all: the SDK throws a plain Error while building headers,
  // before any request is sent (there is no typed class for this case).
  if (error instanceof Error && error.message.startsWith("Could not resolve authentication method")) {
    return new AiProviderError("authentication", "No Anthropic credentials configured (set ANTHROPIC_API_KEY)");
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError("authentication", error.message);
  }
  if (error instanceof Anthropic.APIError) return new AiProviderError("provider_error", `API error ${error.status ?? ""}: ${error.message}`);
  return new AiProviderError("provider_error", error instanceof Error ? error.message : String(error));
}
