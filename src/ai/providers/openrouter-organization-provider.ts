/**
 * OrganizationProvider on OpenRouter's chat completions API (plain HTTP, no
 * SDK). The only module that knows about OpenRouter's request and response
 * format or OpenRouter model names; it maps to and from the provider-agnostic
 * types.
 */
import {
  AiProviderError,
  type OrganizationProvider,
  type OrganizationRequest,
  type OrganizationResponse,
} from "../organization-provider.ts";

/** Free Dots model used in the provider comparison. Override with AI_MODEL. */
export const DEFAULT_OPENROUTER_MODEL = "dots-studio/dots-3-note-preview:free";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** The fetch function this provider uses (injectable for tests). */
export type OpenRouterFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The parts of a chat completion response this provider reads. */
type ChatCompletion = {
  model?: string;
  error?: unknown;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenRouterOrganizationProvider implements OrganizationProvider {
  readonly provider = "openrouter";
  readonly model: string;
  /** The image types used with Gemini, so both providers see the same images. */
  readonly supportedImageTypes = ["image/jpeg", "image/png", "image/webp"] as const;
  /** A #private field, so logging or serializing the provider never shows it. */
  readonly #apiKey: string | undefined;
  private readonly fetchImpl: OpenRouterFetch;

  constructor(options: { apiKey?: string; model?: string; fetch?: OpenRouterFetch } = {}) {
    this.model = options.model ?? DEFAULT_OPENROUTER_MODEL;
    this.#apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async organize(request: OrganizationRequest): Promise<OrganizationResponse> {
    if (!this.#apiKey) {
      throw new AiProviderError("authentication", "No OpenRouter API key configured (set OPENROUTER_API_KEY)");
    }
    // Text first, then the images in order (same placement as Gemini).
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.instructions },
        {
          role: "user",
          content: [
            { type: "text", text: request.content },
            ...request.images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
            })),
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "archive_organization", strict: true, schema: request.outputSchema },
      },
      // Only route to upstream providers that support structured output.
      provider: { require_parameters: true },
    };

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      text = await response.text();
    } catch (error) {
      throw new AiProviderError("provider_error", error instanceof Error ? error.message : String(error), { network: true });
    }
    if (!response.ok) throw httpError(response.status, text);

    let data: ChatCompletion;
    try {
      data = JSON.parse(text) as ChatCompletion;
    } catch {
      throw new AiProviderError("provider_error", "OpenRouter returned a non-JSON response");
    }
    // Upstream failures can arrive with HTTP 200 and an error object.
    if (data.error) throw new AiProviderError("provider_error", `Upstream error: ${excerpt(JSON.stringify(data.error))}`, upstreamDetails(data.error));

    const choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new AiProviderError("refusal", `Model refused: ${excerpt(choice.message.refusal)}`);
    if (choice?.finish_reason === "content_filter") throw new AiProviderError("refusal", "Response stopped (content_filter)");
    if (choice?.finish_reason === "length") throw new AiProviderError("invalid_output", "Response was cut off (length)");

    let output: unknown;
    try {
      output = JSON.parse(choice?.message?.content ?? "");
    } catch {
      throw new AiProviderError("invalid_output", "Response was not valid JSON");
    }
    return {
      output,
      model: data.model ?? this.model,
      ...(data.usage && {
        usage: {
          inputTokens: data.usage.prompt_tokens ?? 0,
          // Includes reasoning tokens, which are billed as output.
          outputTokens: data.usage.completion_tokens ?? 0,
        },
      }),
    };
  }
}

function httpError(status: number, body: string): AiProviderError {
  const message = `OpenRouter HTTP ${status}: ${excerpt(body)}`;
  let upstream: string | undefined;
  try {
    upstream = providerName((JSON.parse(body) as { error?: unknown }).error);
  } catch {
    // Not JSON: no upstream provider to name.
  }
  const details = { status, ...(upstream && { upstreamProvider: upstream }) };
  if (status === 429) return new AiProviderError("rate_limited", message, details);
  if (status === 401 || status === 403) return new AiProviderError("authentication", `OpenRouter rejected the API key (HTTP ${status})`, details);
  return new AiProviderError("provider_error", message, details);
}

/** Details of an error object OpenRouter passed on with HTTP 200: its numeric code and the upstream provider. */
function upstreamDetails(error: unknown): { status?: number; upstreamProvider?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const upstream = providerName(error);
  return { ...(typeof code === "number" && { status: code }), ...(upstream && { upstreamProvider: upstream }) };
}

/** OpenRouter names the upstream provider in error.metadata.provider_name. */
function providerName(error: unknown): string | undefined {
  const name = (error as { metadata?: { provider_name?: unknown } } | null)?.metadata?.provider_name;
  return typeof name === "string" ? name : undefined;
}

/** A short excerpt of a provider message for error reports. */
function excerpt(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
