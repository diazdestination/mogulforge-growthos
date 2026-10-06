import { twiml } from "twilio";
import { callieHash } from "./callie-contract";
import { deliveryFingerprint } from "./invoice-delivery-contract";
import { receptionCredentials, receptionDeny } from "./callie-reception-policy";
import { CallieReceptionError, type CallieReceptionSnapshot } from "./callie-reception-contract";

const ELEVEN_ORIGIN = "https://api.elevenlabs.io";
const names = ["callie_initialize", "callie_save_facts", "callie_request_handoff"];
export function assertReceptionDeadline(deadlineAt: number) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) receptionDeny("registration_deadline_elapsed");
}
function registrationSignal(deadlineAt: number, requestLimit: number) {
  assertReceptionDeadline(deadlineAt);
  return AbortSignal.timeout(Math.max(1, Math.min(requestLimit, Math.floor(deadlineAt - Date.now()))));
}
/** Limits apply to the consumed stream, not just a possibly absent Content-Length. */
export async function boundedProviderText(response: Response, max = 64_000) {
  if (Number(response.headers.get("content-length")) > max) throw new Error("provider_response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error("provider_response_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}
/** Stable public configuration fingerprint; credentials and provider metadata never enter it. */
export function receptionConfigurationFingerprint(value: unknown) {
  const agent = record(value);
  if (!agent || !record(agent.conversation_config) || !record(agent.platform_settings)) receptionDeny("provider_configuration_invalid");
  return deliveryFingerprint({ conversation_config: agent.conversation_config, platform_settings: agent.platform_settings, workflow: agent.workflow ?? null, procedures: agent.procedures ?? null, resolved_tools: agent.resolved_tools ?? null });
}
export function assertReceptionProviderConfiguration(value: unknown, snapshot: CallieReceptionSnapshot) {
  const agent = record(value), expected = snapshot.receptionBinding!, voice = snapshot.voiceBinding!;
  if (!agent || agent.agent_id !== expected.agentId || agent.version_id !== expected.agentVersionId ||
      (expected.branchId !== null && agent.branch_id !== expected.branchId) || receptionConfigurationFingerprint(agent) !== expected.configurationSha256) receptionDeny("provider_configuration_changed");
  const config = record(agent.conversation_config), prompt = record(config?.agent?.prompt), platform = record(agent.platform_settings);
  if (config?.asr?.user_input_audio_format !== "ulaw_8000" || config?.tts?.agent_output_audio_format !== "ulaw_8000" ||
      platform?.privacy?.record_voice !== false || platform?.privacy?.delete_audio !== true || platform?.privacy?.delete_transcript_and_pii !== true ||
      !Number.isInteger(platform?.privacy?.retention_days) || platform!.privacy.retention_days < 1 || platform!.privacy.retention_days > snapshot.retentionDays ||
      !Number.isInteger(config?.conversation?.max_duration_seconds) || config!.conversation.max_duration_seconds < 1 || config!.conversation.max_duration_seconds > snapshot.maxConversationSeconds ||
      platform?.overrides?.conversation_config_override?.conversation?.max_duration_seconds !== true ||
      platform?.overrides?.conversation_config_override?.agent?.prompt?.prompt !== true || platform?.overrides?.conversation_config_override?.agent?.first_message !== true ||
      (agent.workflow && Object.keys(agent.workflow).length > 0) || Object.values(prompt?.built_in_tools ?? {}).some(value => value !== null) || Object.keys(agent.procedures ?? {}).length ||
      (prompt?.knowledge_base?.length ?? 0) || prompt?.custom_llm ||
      (prompt?.mcp_server_ids?.length ?? 0) || (prompt?.native_mcp_server_ids?.length ?? 0)) receptionDeny("provider_configuration_unsafe");
  const tools = agent.resolved_tools ?? prompt?.tools;
  if (!Array.isArray(tools) || tools.length !== names.length) receptionDeny("provider_tool_contract_changed");
  for (const name of names) {
    const tool = tools.find((item: any) => item?.name === name);
    const schema = record(tool?.api_schema);
    const body = schema?.request_body_schema?.properties;
    if (!tool || tool.type !== "webhook" || schema?.method !== "POST" || schema?.url !== `${voice.origin}/api/v1/public/callie/reception/{callie_session_id}/tool` ||
      schema?.request_headers?.["X-Callie-Capability"]?.variable_name !== "secret__callie_capability" ||
      schema?.path_params_schema?.callie_session_id?.dynamic_variable !== "callie_session_id" ||
      body?.agentId?.dynamic_variable !== "system__agent_id" || body?.conversationId?.dynamic_variable !== "system__conversation_id" ||
      body?.action?.constant_value !== name.slice("callie_".length)) receptionDeny("provider_tool_contract_changed");
  }
  return true;
}
/** Read-only remote proof; failure never authorizes the later registration POST. */
export async function preflightReception(org: string, snapshot: CallieReceptionSnapshot, deadlineAt = Date.now() + 12_000) {
  const binding = snapshot.receptionBinding!, credentials = receptionCredentials(org, binding);
  const query = binding.branchId ? `?branch_id=${encodeURIComponent(binding.branchId)}` : "";
  const response = await fetch(`${ELEVEN_ORIGIN}/v1/convai/agents/${encodeURIComponent(binding.agentId)}${query}`, {
    headers: { "xi-api-key": credentials.apiKey }, redirect: "error", signal: registrationSignal(deadlineAt, 2000),
  });
  if (!response.ok) receptionDeny("provider_configuration_unavailable");
  const value = JSON.parse(await boundedProviderText(response));
  const ids = value?.conversation_config?.agent?.prompt?.tool_ids;
  if (Array.isArray(ids) && ids.length) {
    if (ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || value.conversation_config.agent.prompt.tools?.length) receptionDeny("provider_tool_contract_changed");
    value.resolved_tools = await Promise.all(ids.map(async id => {
      const tool = await fetch(`${ELEVEN_ORIGIN}/v1/convai/tools/${encodeURIComponent(id)}`, { headers: { "xi-api-key": credentials.apiKey }, redirect: "error", signal: registrationSignal(deadlineAt, 2000) });
      if (!tool.ok) receptionDeny("provider_tool_contract_unavailable");
      const result = JSON.parse(await boundedProviderText(tool, 32_000));
      if (result.id !== id) receptionDeny("provider_tool_contract_changed");
      return result.tool_config;
    }));
  }
  assertReceptionProviderConfiguration(value, snapshot);
}

/** Parse a deliberately small TwiML grammar; never execute arbitrary provider verbs. */
export function validatedReceptionTwiml(raw: unknown, disclosure: string) {
  if (typeof raw !== "string" || raw.length > 12_000 || /<!|<!\[|&#/i.test(raw)) throw new Error("invalid_provider_twiml");
  const xml = raw.replace(/^\s*<\?xml version=["']1\.0["'](?: encoding=["']UTF-8["'])?\?>\s*/i, "");
  const match = /^\s*<Response>\s*<Connect>\s*<Stream\s+url=(["'])([^"'<>]+)\1\s*(?:\/\s*>|>\s*<\/Stream>)\s*<\/Connect>\s*<\/Response>\s*$/.exec(xml);
  if (!match) throw new Error("invalid_provider_twiml");
  const value = match[2]!.replaceAll("&amp;", "&");
  if (/&[A-Za-z#]/.test(value)) throw new Error("invalid_provider_twiml");
  const url = new URL(value);
  if (url.protocol !== "wss:" || url.hostname !== "api.elevenlabs.io" || url.port || url.username || url.password || url.hash || !url.pathname.startsWith("/v1/convai/")) throw new Error("invalid_provider_twiml_destination");
  const result = new twiml.VoiceResponse(); result.say(disclosure); result.connect().stream({ url: url.toString() }); result.hangup();
  return result.toString();
}
export async function registerReception(org: string, snapshot: CallieReceptionSnapshot, data: { sessionId: string; callSid: string; from: string; to: string; capability: string }, deadlineAt = Date.now() + 5000) {
  const binding = snapshot.receptionBinding!, credentials = receptionCredentials(org, binding);
  const response = await fetch(`${ELEVEN_ORIGIN}/v1/convai/twilio/register-call`, { method: "POST", redirect: "error", signal: registrationSignal(deadlineAt, 5000),
    headers: { "Content-Type": "application/json", "xi-api-key": credentials.apiKey }, body: JSON.stringify({
      agent_id: binding.agentId, from_number: data.from, to_number: data.to, direction: "inbound",
      conversation_initiation_client_data: { ...(binding.branchId ? { branch_id: binding.branchId } : {}), environment: binding.environment,
        dynamic_variables: { callie_session_id: data.sessionId, secret__callie_capability: data.capability },
        conversation_config_override: { agent: { prompt: { prompt: snapshot.prompt }, first_message: "I can take a request for the office. How may I help?" },
          conversation: { max_duration_seconds: snapshot.maxConversationSeconds } },
      },
    }),
  });
  if (!response.ok) throw new Error("registration_result_uncertain");
  const raw = await boundedProviderText(response, 16_000);
  const value = response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw;
  return validatedReceptionTwiml(value, snapshot.callerDisclosure);
}
export function receptionConversationMatches(value: unknown, context: { agentId: string; agentVersionId: string; conversationId: string; callSid: string; from: string; to: string; branchId: string | null; environment: string }) {
  const row = record(value), phone = record(row?.metadata?.phone_call);
  return !!row && row.agent_id === context.agentId && row.conversation_id === context.conversationId && row.version_id === context.agentVersionId &&
    (context.branchId === null || row.branch_id === context.branchId) && row.environment === context.environment &&
    phone?.type === "twilio" && phone.direction === "inbound" && phone.call_sid === context.callSid && phone.external_number === context.from && phone.agent_number === context.to;
}
export async function verifyReceptionConversation(org: string, snapshot: CallieReceptionSnapshot, data: { conversationId: string; callSid: string; from: string; to: string }) {
  try {
  const binding = snapshot.receptionBinding!, response = await fetch(`${ELEVEN_ORIGIN}/v1/convai/conversations/${encodeURIComponent(data.conversationId)}`, {
    headers: { "xi-api-key": receptionCredentials(org, binding).apiKey }, redirect: "error", signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) receptionDeny("conversation_identity_unavailable");
  const value = JSON.parse(await boundedProviderText(response));
  if (!receptionConversationMatches(value, { ...binding, ...data })) receptionDeny("conversation_identity_changed");
  } catch (error) {
    if (error instanceof CallieReceptionError) throw error;
    // Provider GET may contain a raw transcript. Never propagate a parser's
    // response snippet or transport diagnostic through request error logging.
    receptionDeny("conversation_identity_unavailable");
  }
}
export function registrationFingerprint(value: unknown) { return callieHash(value); }
