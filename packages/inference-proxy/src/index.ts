/** Env vars that must not reach an ACP child when hosted inference proxying is on. */
export const MODEL_PROVIDER_SECRET_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export interface HostedInferenceCapability {
  gatewayBaseUrl: string;
  sessionsToken: string;
}

export interface ResolvedSessionModelUpstream {
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
}

export interface StoredModelCardProviderConfig {
  model: string;
  provider: string;
  base_url: string | null;
  custom_headers: Record<string, string> | null;
}

export function bindStoredModelCardCredentials(
  fallback: ResolvedSessionModelUpstream,
  card: StoredModelCardProviderConfig,
  apiKey: string,
): ResolvedSessionModelUpstream {
  return {
    wireModel: card.model,
    apiKey,
    baseURL: card.base_url ?? undefined,
    provider: card.provider,
    customHeaders: card.custom_headers ?? undefined,
  };
}

const DEFAULT_PROVIDER_BASES: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

/** OpenMA gateway base for Harbor-style hosted inference (no trailing slash). */
export function buildHostedInferenceBaseUrl(
  gatewayBaseUrl: string,
  sessionId: string,
): string {
  const gateway = new URL(gatewayBaseUrl);
  gateway.username = "";
  gateway.password = "";
  gateway.search = "";
  gateway.hash = "";
  gateway.pathname = [
    "v1",
    "oma",
    "inference-proxy",
    encodeURIComponent(sessionId),
  ].join("/");
  return gateway.toString().replace(/\/$/, "");
}

export function projectHostedInferenceEnv(
  sessionId: string,
  capability: HostedInferenceCapability,
): {
  HOSTED_INFERENCE_URL: string;
  HOSTED_INFERENCE_TOKEN: string;
} {
  return {
    HOSTED_INFERENCE_URL: buildHostedInferenceBaseUrl(
      capability.gatewayBaseUrl,
      sessionId,
    ),
    HOSTED_INFERENCE_TOKEN: capability.sessionsToken,
  };
}

/** Strip provider API keys and apply hosted inference env when proxying is enabled. */
export function applyHostedInferenceToAgentEnv(input: {
  sessionId: string;
  env: Record<string, string | undefined>;
  capability: HostedInferenceCapability | null;
  enableProxy?: boolean;
}): Record<string, string | undefined> {
  const enable = input.enableProxy !== false && input.capability !== null;
  const next = { ...input.env };
  if (!enable) return next;
  for (const key of MODEL_PROVIDER_SECRET_ENV_KEYS) {
    delete next[key];
  }
  delete next.OPENAI_BASE_URL;
  return {
    ...next,
    ...projectHostedInferenceEnv(input.sessionId, input.capability!),
  };
}

/** Join model-card base URL with the OpenAI-compatible subpath from the sandbox client. */
export function resolveUpstreamInferenceUrl(input: {
  subPath: string;
  baseURL?: string;
  provider?: string;
}): string | null {
  const sub = input.subPath.replace(/^\//, "");
  if (!sub || sub.includes("..")) return null;
  const trimmedBase = input.baseURL?.replace(/\/$/, "");
  const root = trimmedBase
    ?? (input.provider ? DEFAULT_PROVIDER_BASES[input.provider] : undefined);
  if (!root) return null;
  if (root.endsWith("/v1") && sub.startsWith("v1/")) {
    return `${root}/${sub.slice("v1/".length)}`;
  }
  return `${root}/${sub}`;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Forward an OpenAI-compatible inference call using host-resolved credentials. */
export async function forwardHostedInferenceRequest(input: {
  upstream: ResolvedSessionModelUpstream;
  method: string;
  subPath: string;
  inboundHeaders: Headers;
  body: ArrayBuffer | null;
  fetcher?: typeof fetch;
}): Promise<Response> {
  const upstreamUrl = resolveUpstreamInferenceUrl({
    subPath: input.subPath,
    baseURL: input.upstream.baseURL,
    provider: input.upstream.provider,
  });
  if (!upstreamUrl) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const outbound = new Headers();
  for (const [name, value] of input.inboundHeaders.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "authorization") continue;
    outbound.set(name, value);
  }
  outbound.set("authorization", `Bearer ${input.upstream.apiKey}`);
  if (input.upstream.customHeaders) {
    for (const [name, value] of Object.entries(input.upstream.customHeaders)) {
      outbound.set(name, value);
    }
  }
  const fetcher = input.fetcher ?? fetch;
  const init: RequestInit = {
    method: input.method,
    headers: outbound,
    redirect: "manual",
  };
  if (input.body !== null && !["GET", "HEAD"].includes(input.method.toUpperCase())) {
    init.body = input.body;
  }
  return fetcher(upstreamUrl, init);
}
