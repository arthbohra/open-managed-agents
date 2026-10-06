import type { InferenceTargetDescriptor } from "./types.js";

export function inferProviderFromWireModel(wireModel: string): string {
  const lower = wireModel.toLowerCase();
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  return "openai";
}

export function inferenceTargetFromWireModel(
  wireModel: string,
  overrides?: Partial<Pick<InferenceTargetDescriptor, "provider" | "baseUrl" | "protocolEndpoints">>,
): InferenceTargetDescriptor {
  return {
    wireModel,
    provider: overrides?.provider ?? inferProviderFromWireModel(wireModel),
    baseUrl: overrides?.baseUrl ?? null,
    protocolEndpoints: overrides?.protocolEndpoints,
  };
}
