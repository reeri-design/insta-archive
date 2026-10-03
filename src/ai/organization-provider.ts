/**
 * Provider-agnostic contract for structured AI organization. Implementations
 * live in ./providers and are the only place vendor SDKs or types appear.
 */

/** An image given to the model, as stored bytes. */
export type AiImageInput = {
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: Uint8Array;
};

export type OrganizationRequest = {
  /** Stable task instructions (the system prompt). */
  instructions: string;
  /** The item-specific text (original metadata, media notes). */
  content: string;
  /** Images in the order the model should see them; may be empty. */
  images: AiImageInput[];
  /** JSON schema the output must follow. */
  outputSchema: Record<string, unknown>;
};

export type OrganizationResponse = {
  /** The parsed JSON output; validated by the caller, not the provider. */
  output: unknown;
  /** The model that actually answered (may differ after a fallback). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export interface OrganizationProvider {
  /** Plain identifier recorded on AiOrganization, e.g. "anthropic". */
  readonly provider: string;
  /** The configured model identifier. */
  readonly model: string;
  /**
   * Image types this provider accepts. Images of other types are left out
   * before the request is built. Omitted: every AiImageInput type.
   */
  readonly supportedImageTypes?: readonly AiImageInput["mimeType"][];
  organize(request: OrganizationRequest): Promise<OrganizationResponse>;
}

export type AiProviderErrorKind =
  | "rate_limited"
  | "refusal"
  /** The response could not be read as the requested JSON. */
  | "invalid_output"
  | "authentication"
  | "provider_error";

export class AiProviderError extends Error {
  override name = "AiProviderError";
  readonly kind: AiProviderErrorKind;
  constructor(kind: AiProviderErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
