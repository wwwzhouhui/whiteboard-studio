import { createError, defineEventHandler } from "h3";
import { getSession } from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import {
  deleteAppSecret,
  readAppSecret,
  writeAppSecret,
} from "@agent-native/core/secrets";
import { putUserSetting } from "@agent-native/core/settings";
import modelSelection from "@agent-native/core/agent/actions/manage-provider-models";

import {
  ACTIVE_MODEL_SETTING,
  CLOUD_ARCHIVE_KEYS,
  assertSameOrigin,
  canManageOrgSecrets,
  probeLocalModel,
  secretRefsFor,
  setDefaultModel,
} from "../model-endpoints.js";

/**
 * Point the openai provider lane at the local vLLM server.
 *
 * The engine lets a deployment endpoint resolve to a private address but not a
 * saved one, so the local lane comes from the environment: whichever scope owns
 * the cloud `OPENAI_*` credentials (personal or organization) is archived and
 * cleared, which makes the env defaults apply again.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event, "local-model");
  const session = await getSession(event);
  if (!session?.email) throw createError({ statusCode: 401 });
  const probe = await probeLocalModel();
  if (!probe.ok)
    throw createError({
      statusCode: 409,
      statusMessage: `本地模型服务不可用：${probe.error ?? "unknown error"}`,
    });
  const modelId = probe.models[0];
  if (!modelId)
    throw createError({
      statusCode: 409,
      statusMessage: "本地模型服务没有返回模型 ID",
    });
  const org = await getOrgContext(event);
  const ctx = {
    userEmail: session.email,
    orgId: org.orgId ?? undefined,
    caller: "http" as const,
  };
  const scopes = secretRefsFor(session.email, org.orgId);
  let archivedScope: "user" | "org" | null = null;
  for (const ref of scopes) {
    const [baseUrl, apiKey] = await Promise.all([
      readAppSecret({ ...ref, key: "OPENAI_BASE_URL" }),
      readAppSecret({ ...ref, key: "OPENAI_API_KEY" }),
    ]);
    if (!baseUrl?.value && !apiKey?.value) continue;
    if (ref.scope === "org" && !canManageOrgSecrets(org.role))
      throw createError({
        statusCode: 409,
        statusMessage:
          "组织模型凭据由管理员配置，请联系管理员切换模型来源，或先在“个人提供方”中配置自己的模型",
      });
    if (baseUrl?.value)
      await writeAppSecret({
        ...ref,
        key: CLOUD_ARCHIVE_KEYS.baseUrl,
        value: baseUrl.value,
      });
    if (apiKey?.value)
      await writeAppSecret({
        ...ref,
        key: CLOUD_ARCHIVE_KEYS.apiKey,
        value: apiKey.value,
      });
    await deleteAppSecret({ ...ref, key: "OPENAI_BASE_URL" });
    await deleteAppSecret({ ...ref, key: "OPENAI_API_KEY" });
    archivedScope = ref.scope;
  }
  const selectionScope = archivedScope ?? "user";
  await modelSelection.run(
    {
      action: "set",
      provider: "openai",
      scope: selectionScope,
      models: probe.models,
    },
    ctx,
  );
  await putUserSetting(session.email, ACTIVE_MODEL_SETTING, {
    source: "local",
    modelId,
    label: probe.models.length === 1 ? probe.models[0] : modelId,
    baseUrl: probe.baseUrl,
    models: probe.models,
    credentialScope: selectionScope,
    updatedAt: Date.now(),
  });
  const defaultSaved = await setDefaultModel(event, modelId);
  return {
    ok: true,
    source: "local",
    modelId,
    models: probe.models,
    credentialScope: selectionScope,
    defaultSaved,
  };
});
