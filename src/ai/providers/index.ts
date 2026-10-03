import type { OrganizationProvider } from "../organization-provider.ts";
import { AnthropicOrganizationProvider } from "./anthropic-organization-provider.ts";
import { GeminiOrganizationProvider } from "./gemini-organization-provider.ts";
import { OpenRouterOrganizationProvider } from "./openrouter-organization-provider.ts";

/**
 * The configured provider: AI_PROVIDER (default "gemini") and an optional
 * AI_MODEL override. Adding a provider means adding a case here.
 */
export function createOrganizationProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrganizationProvider {
  const provider = env.AI_PROVIDER?.trim() || "gemini";
  const model = env.AI_MODEL?.trim() || undefined;
  switch (provider) {
    case "gemini": {
      const apiKey = env.GEMINI_API_KEY?.trim() || undefined;
      return new GeminiOrganizationProvider({ ...(apiKey && { apiKey }), ...(model && { model }) });
    }
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
      return new OpenRouterOrganizationProvider({ ...(apiKey && { apiKey }), ...(model && { model }) });
    }
    case "anthropic":
      return new AnthropicOrganizationProvider(model ? { model } : {});
    default:
      throw new Error(`Unsupported AI_PROVIDER "${provider}"`);
  }
}
