import { createError, defineEventHandler } from "h3";
import { getSession } from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import { readAppSecret } from "@agent-native/core/secrets";
import {
  getOrgSetting,
  getUserSetting,
} from "@agent-native/core/settings";

import {
  ACTIVE_MODEL_SETTING,
  CLOUD_ARCHIVE_KEYS,
  CUSTOM_MODEL_SETTING,
  LOCAL_MODEL,
  probeLocalModel,
  secretRefsFor,
} from "../model-endpoints.js";

/**
 * Report which lane is really live. Saved `OPENAI_*` credentials win over the
 * environment inside the engine, so their presence — not the last button press
 * — decides whether the openai provider is on the cloud or local endpoint.
 */
export default defineEventHandler(async (event) => {
  const session = await getSession(event);
  if (!session?.email) throw createError({ statusCode: 401 });
  const org = await getOrgContext(event);
  const refs = secretRefsFor(session.email, org.orgId);
  const [probe, active, userMeta, orgMeta, ...credentials] = await Promise.all([
    probeLocalModel(),
    getUserSetting(session.email, ACTIVE_MODEL_SETTING),
    getUserSetting(session.email, CUSTOM_MODEL_SETTING),
    org.orgId ? getOrgSetting(org.orgId, CUSTOM_MODEL_SETTING) : null,
    ...refs.flatMap((ref) => [
      readAppSecret({ ...ref, key: "OPENAI_BASE_URL" }),
      readAppSecret({ ...ref, key: CLOUD_ARCHIVE_KEYS.baseUrl }),
    ]),
  ]);
  const entries = refs.map((ref, index) => ({
    scope: ref.scope,
    live: Boolean(credentials[index * 2]?.value),
    archived: Boolean(credentials[index * 2 + 1]?.value),
  }));
  const liveEntry = entries.find((entry) => entry.live);
  const archivedEntry = entries.find((entry) => entry.archived);
  const source: "local" | "cloud" = liveEntry ? "cloud" : "local";
  const credentialScope = (liveEntry ?? archivedEntry)?.scope;
  const meta = credentialScope === "org" ? orgMeta : userMeta;
  return {
    source,
    local: {
      label: LOCAL_MODEL.label,
      baseUrl: probe.baseUrl,
      modelId: LOCAL_MODEL.modelId || probe.models[0] || "",
      reachable: probe.ok,
      models: probe.models,
      error: probe.error ?? null,
    },
    canRestoreCloud: Boolean(archivedEntry),
    cloudModelId:
      typeof meta?.modelId === "string"
        ? meta.modelId
        : active?.source === "cloud" && typeof active.modelId === "string"
          ? active.modelId
          : "",
  };
});
