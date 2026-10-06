import type {
  InferenceProtocolEndpoint,
  InferenceTargetDescriptor,
  InferenceWireProtocol,
} from "./types.js";

export interface InferenceEndpointContributor {
  readonly providerIds: readonly string[];
  endpoints(input: {
    provider: string;
    baseUrl: string | null;
  }): readonly InferenceProtocolEndpoint[];
}

export class InferenceEndpointResolver {
  private readonly byProvider = new Map<string, InferenceEndpointContributor>();

  register(contributor: InferenceEndpointContributor): void {
    for (const id of contributor.providerIds) {
      this.byProvider.set(normalizeProviderId(id), contributor);
    }
  }

  resolve(target: InferenceTargetDescriptor): readonly InferenceProtocolEndpoint[] {
    if (target.protocolEndpoints && target.protocolEndpoints.length > 0) {
      return target.protocolEndpoints;
    }
    const contributor = this.byProvider.get(normalizeProviderId(target.provider));
    if (!contributor) return [];
    return contributor.endpoints({
      provider: target.provider,
      baseUrl: target.baseUrl,
    });
  }

  availableProtocols(
    target: InferenceTargetDescriptor,
  ): readonly InferenceWireProtocol[] {
    return this.resolve(target).map((endpoint) => endpoint.protocol);
  }
}

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "ant-compatible") return "anthropic";
  if (normalized === "oai-compatible") return "openai";
  return normalized;
}

export function joinHostedInferenceUrl(
  proxyBaseUrl: string,
  proxyPathSegment: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const segment = proxyPathSegment.replace(/^\//, "");
  return segment.length === 0 ? base : `${base}/${segment}`;
}
