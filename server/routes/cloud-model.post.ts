import { createError, defineEventHandler } from "h3";
import { getSession } from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import {
  deleteAppSecret,
  readAppSecret,
  writeAppSecret,
} from "@agent-native/core/secrets";
import {
  getOrgSetting,
  getUserSetting,
  putUserSetting,
} from "@agent-native/core/settings";
import modelSelection from "@agent-native/core/agent/actions/manage-provider-models";

import {
  ACTIVE_MODEL_SETTING,
  CLOUD_ARCHIVE_KEYS,
  CUSTOM_MODEL_SETTING,
  assertSameOrigin,
  secretRefsFor,
  setDefaultModel,
} from "../model-endpoints.js";

/** Put the archived custom (cloud) OpenAI endpoint back on the provider lane. */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event, "cloud-model");
  const session = await getSession(event);
  if (!session?.email) throw createError({ statusCode: 401 });
  const org = await getOrgContext(event);
  const ctx = {
    userEmail: session.email,
    orgId: org.orgId ?? undefined,
    caller: "http" as const,
  };
  const [active, userMeta, orgMeta] = await Promise.all([
    getUserSetting(session.email, ACTIVE_MODEL_SETTING),
    getUserSetting(session.email, CUSTOM_MODEL_SETTING),
    org.orgId ? getOrgSetting(org.orgId, CUSTOM_MODEL_SETTING) : null,
  ]);
  const preferred = active?.credentialScope === "org" ? "org" : "user";
  const ordered = secretRefsFor(session.email, org.orgId).sort((a, b) =>
    a.scope === preferred ? -1 : b.scope === preferred ? 1 : 0,
  );
  let restore =
    null as { ref: (typeof ordered)[number]; baseUrl: string; apiKey?: string } | null;
  for (const ref of ordered) {
    const [baseUrl, apiKey] = await Promise.all([
      readAppSecret({ ...ref, key: CLOUD_ARCHIVE_KEYS.baseUrl }),
      readAppSecret({ ...ref, key: CLOUD_ARCHIVE_KEYS.apiKey }),
    ]);
    if (baseUrl?.value) {
      restore = { ref, baseUrl: baseUrl.value, apiKey: apiKey?.value };
      break;
    }
  }
  if (!restore)
    throw createError({
      statusCode: 409,
      statusMessage: "还没有保存过自定义模型，请先在“添加提供商”里配置",
    });
  await writeAppSecret({
    ...restore.ref,
    key: "OPENAI_BASE_URL",
    value: restore.baseUrl,
  });
  if (restore.apiKey)
    await writeAppSecret({
      ...restore.ref,
      key: "OPENAI_API_KEY",
      value: restore.apiKey,
    });
  await deleteAppSecret({ ...restore.ref, key: CLOUD_ARCHIVE_KEYS.baseUrl });
  await deleteAppSecret({ ...restore.ref, key: CLOUD_ARCHIVE_KEYS.apiKey });
  const meta = restore.ref.scope === "org" ? orgMeta : userMeta;
  const modelId = typeof meta?.modelId === "string" ? meta.modelId : "";
  const knownModels = Array.isArray(meta?.models)
    ? meta.models.filter((value): value is string => typeof value === "string")
    : [];
  const models = knownModels.length ? knownModels : modelId ? [modelId] : [];
  if (models.length) {
    await modelSelection.run(
      {
        action: "set",
        provider: "openai",
        scope: restore.ref.scope,
        models,
      },
      ctx,
    );
  }
  await putUserSetting(session.email, ACTIVE_MODEL_SETTING, {
    source: "cloud",
    modelId,
    label: typeof meta?.label === "string" ? meta.label : modelId,
    baseUrl: restore.baseUrl,
    models,
    credentialScope: restore.ref.scope,
    updatedAt: Date.now(),
  });
  const defaultSaved = await setDefaultModel(event, modelId);
  return {
    ok: true,
    source: "cloud",
    modelId,
    models,
    credentialScope: restore.ref.scope,
    defaultSaved,
  };
});
