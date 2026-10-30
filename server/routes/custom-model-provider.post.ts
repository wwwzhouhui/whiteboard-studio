import {
  defineEventHandler,
  readBody,
  createError,
} from "h3";
import { z } from "zod";
import { getSession } from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import { readAppSecret, writeAppSecret } from "@agent-native/core/secrets";
import { putUserSetting, putOrgSetting } from "@agent-native/core/settings";
import keyPolicy from "@agent-native/core/agent/actions/manage-provider-key-policy";
import modelSelection from "@agent-native/core/agent/actions/manage-provider-models";
import readModels from "@agent-native/core/agent/actions/get-provider-models";
import {
  ACTIVE_MODEL_SETTING,
  CLOUD_ARCHIVE_KEYS,
  assertSameOrigin,
} from "../model-endpoints.js";
const schema = z
  .object({
    scope: z.enum(["user", "org"]),
    apiKey: z.string().max(8192).optional(),
    baseUrl: z.string().url().max(2048),
    modelId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\s,]+$/),
    label: z.string().trim().max(100),
    models: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();
export default defineEventHandler(async (event) => {
  assertSameOrigin(event, "custom-model-provider");
  const session = await getSession(event);
  if (!session?.email) throw createError({ statusCode: 401 });
  const org = await getOrgContext(event);
  const input = schema.safeParse(await readBody(event));
  if (!input.success)
    throw createError({
      statusCode: 400,
      statusMessage: "请检查接口地址和模型 ID",
    });
  const b = input.data,
    ctx = {
      userEmail: session.email,
      orgId: org.orgId ?? undefined,
      caller: "http" as const,
    };
  if (
    b.scope === "org" &&
    (!org.orgId || !["owner", "admin"].includes(org.role || ""))
  )
    throw createError({
      statusCode: 403,
      statusMessage: "仅组织管理员可修改组织模型",
    });
  if (b.scope === "user" && org.orgId && org.role === "member") {
    const policy = await keyPolicy.run({}, ctx);
    if (policy.restricted)
      throw createError({
        statusCode: 403,
        statusMessage: "组织已限制个人模型密钥",
      });
  }
  const url = new URL(b.baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw createError({
      statusCode: 400,
      statusMessage: "接口地址不能包含认证信息、查询参数或片段",
    });
  // Saving performs no outbound request. Core validates the endpoint again before inference.
  const scopeId = b.scope === "org" ? org.orgId! : session.email;
  const ref = { scope: b.scope, scopeId };
  const key = b.apiKey?.trim();
  if (!key && !(await readAppSecret({ ...ref, key: "OPENAI_API_KEY" })))
    throw createError({ statusCode: 400, statusMessage: "请填写 API Key" });
  const before = await readModels.run(
    { provider: "openai", scope: b.scope },
    ctx,
  );
  const existing = before.providers[0]?.rows[b.scope]?.models ?? [];
  if (key) await writeAppSecret({ ...ref, key: "OPENAI_API_KEY", value: key });
  await writeAppSecret({
    ...ref,
    key: "OPENAI_BASE_URL",
    value: url.toString().replace(/\/$/, ""),
  });
  const selectedModels = [
    ...new Set([...existing, ...(b.models || []), b.modelId]),
  ];
  await modelSelection.run(
    {
      action: "set",
      provider: "openai",
      scope: b.scope,
      models: selectedModels,
    },
    ctx,
  );
  // Keep a copy the local-model switch can restore: activating the local vLLM
  // lane removes the live OPENAI_* secrets so the environment endpoint applies.
  await writeAppSecret({
    ...ref,
    key: CLOUD_ARCHIVE_KEYS.baseUrl,
    value: url.toString().replace(/\/$/, ""),
  });
  if (key)
    await writeAppSecret({
      ...ref,
      key: CLOUD_ARCHIVE_KEYS.apiKey,
      value: key,
    });
  const meta = {
    modelId: b.modelId,
    label: b.label || b.modelId,
    models: selectedModels,
    updatedAt: Date.now(),
    validation: "not-tested",
  };
  if (b.scope === "org")
    await putOrgSetting(scopeId, "studio.custom-model", meta);
  else await putUserSetting(scopeId, "studio.custom-model", meta);
  if (b.scope === "user")
    await putUserSetting(scopeId, ACTIVE_MODEL_SETTING, {
      source: "cloud",
      modelId: b.modelId,
      label: meta.label,
      baseUrl: url.toString().replace(/\/$/, ""),
      models: selectedModels,
      credentialScope: b.scope,
      updatedAt: Date.now(),
    });
  return {
    ok: true,
    scope: b.scope,
    modelId: b.modelId,
    label: meta.label,
    models: selectedModels,
    validation: "not-tested",
  };
});
