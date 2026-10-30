import {
  createError,
  getHeader,
  getRequestURL,
  type H3Event,
} from "h3";

/**
 * Local OpenAI-compatible endpoint (vLLM and friends). Kept in the environment
 * so the engine treats it as a deployment endpoint: user-scoped custom
 * endpoints may not point at private addresses, deployment ones may.
 */
export const LOCAL_MODEL = {
  baseUrl: (process.env.LOCAL_MODEL_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, ""),
  modelId: process.env.LOCAL_MODEL_ID || "",
  label: process.env.LOCAL_MODEL_LABEL || "本地 vLLM 模型",
  apiKey: process.env.LOCAL_MODEL_API_KEY || "local-vllm",
};

/** Archived copies of the user's custom (cloud) OpenAI endpoint. */
export const CLOUD_ARCHIVE_KEYS = {
  baseUrl: "CLOUD_OPENAI_BASE_URL",
  apiKey: "CLOUD_OPENAI_API_KEY",
} as const;

/** Which endpoint the openai provider lane currently points at. */
export const ACTIVE_MODEL_SETTING = "studio.active-model";

export const CUSTOM_MODEL_SETTING = "studio.custom-model";

function hostnameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname
      .toLowerCase();
  } catch {
    return null;
  }
}

function allowedOriginHosts(event: H3Event): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    const host = hostnameOf(value);
    if (host) hosts.add(host);
  };
  add(getRequestURL(event).origin);
  add(getHeader(event, "host"));
  add(getHeader(event, "x-forwarded-host"));
  add(process.env.APP_URL);
  add(process.env.STUDIO_PUBLIC_URL);
  return hosts;
}

/**
 * Same-origin guard for credential writes. Some gateways (notebook preview
 * proxies) strip `Origin` while keeping Host/X-Forwarded-*, so the browser's
 * Fetch Metadata and Referer signals stand in for it then.
 */
export function assertSameOrigin(event: H3Event, route: string): void {
  const origin = getHeader(event, "origin");
  const originHost = hostnameOf(origin);
  const allowedHosts = allowedOriginHosts(event);
  const site = (getHeader(event, "sec-fetch-site") ?? "").toLowerCase();
  const refererHost = hostnameOf(getHeader(event, "referer"));
  const sameOrigin = originHost
    ? allowedHosts.has(originHost)
    : site === "cross-site"
      ? false
      : refererHost
        ? allowedHosts.has(refererHost)
        : true;
  if (!sameOrigin || site === "cross-site") {
    console.warn(`[${route}] origin refused`, {
      origin,
      url: getRequestURL(event).origin,
      host: getHeader(event, "host"),
      forwardedHost: getHeader(event, "x-forwarded-host"),
      forwardedProto: getHeader(event, "x-forwarded-proto"),
      secFetchSite: site || null,
      referer: getHeader(event, "referer") ?? null,
    });
    throw createError({
      statusCode: 403,
      statusMessage: "Cross-origin credential save refused",
    });
  }
  if (!originHost)
    console.warn(`[${route}] credential write without Origin header`, {
      secFetchSite: site || null,
      refererHost,
    });
}

export type LocalModelProbe = {
  ok: boolean;
  baseUrl: string;
  models: string[];
  error?: string;
};

/**
 * Point the default chat model at a specific id. The default-model action owns
 * the authority checks, so call it over loopback instead of duplicating the
 * setting format. Failures are logged, never fatal: the caller already switched
 * the endpoint, and the UI repeats this call client-side.
 */
export async function setDefaultModel(
  event: H3Event,
  model: string,
): Promise<boolean> {
  if (!model) return false;
  const port = event.node?.req?.socket?.localPort ?? 8080;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: `http://127.0.0.1:${port}`,
    "sec-fetch-site": "same-origin",
  };
  const cookie = getHeader(event, "cookie");
  if (cookie) headers.cookie = cookie;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/_agent-native/actions/manage-agent-engine`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "set", engine: "ai-sdk:openai", model }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      console.warn("[model-endpoints] default model not saved", {
        status: response.status,
        body: (await response.text().catch(() => "")).slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[model-endpoints] default model request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Ask the local server which models it serves. */
export async function probeLocalModel(): Promise<LocalModelProbe> {
  const baseUrl = LOCAL_MODEL.baseUrl;
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${LOCAL_MODEL.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      return { ok: false, baseUrl, models: [], error: `HTTP ${response.status}` };
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (payload.data ?? [])
      .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
      .filter(Boolean);
    if (models.length === 0 && LOCAL_MODEL.modelId) models.push(LOCAL_MODEL.modelId);
    return { ok: true, baseUrl, models };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type SecretRef = { scope: "user" | "org"; scopeId: string };

/** User credentials first, then the organization's, since either can own them. */
export function secretRefsFor(
  email: string,
  orgId: string | null | undefined,
): SecretRef[] {
  const refs: SecretRef[] = [{ scope: "user", scopeId: email }];
  if (orgId) refs.push({ scope: "org", scopeId: orgId });
  return refs;
}

export function canManageOrgSecrets(
  role: string | null | undefined,
): boolean {
  return role === "owner" || role === "admin";
}
