/**
 * Database-free core of the CRM AI Assistant: system prompt, tool contracts,
 * and the bounded OpenAI function-calling loop.
 *
 * `assistant.ts` binds the read-only, organization-scoped tool implementations
 * to these contracts. Keeping the loop free of database imports lets the
 * opt-in contractor eval harness drive the exact production prompt, tool
 * definitions, model and loop with canned tool fixtures.
 */
import { logger } from "../lib/logger";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const ASSISTANT_MODEL = "gpt-4o-mini";
export const MAX_TOOL_ROUNDS = 5;

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantToolSpec {
  description: string;
  parameters: Record<string, unknown>;
}

export interface AssistantLoopTool extends AssistantToolSpec {
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Tool contracts shown to the model. Order is preserved in every request. */
export const ASSISTANT_TOOL_SPECS: Record<string, AssistantToolSpec> = {
  get_pipeline_snapshot: {
    description:
      "Current lead pipeline: lead counts by status and by source, plus how many new leads arrived in the last N days.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 30)" } },
    },
  },
  get_conversion_insights: {
    description:
      "Won vs lost breakdown over the last N days, grouped by lead source and service type. Use for close rates, what's working vs not, and missed opportunities.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 90)" } },
    },
  },
  get_appointments_stats: {
    description:
      "Appointment counts by status (completed, cancelled, no_show...) and type over the last N days, plus upcoming scheduled count.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 30)" } },
    },
  },
  get_team_workload: {
    description:
      "Per-teammate workload: open and overdue tasks, active leads, and upcoming appointments. Use for workload balance and employee engagement questions.",
    parameters: { type: "object", properties: {} },
  },
  get_revenue_summary: {
    description:
      "Estimate totals by status (draft/sent/accepted/declined) in dollars, project counts by status, and booked project value over the last N days.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 90)" } },
    },
  },
  get_stale_leads: {
    description:
      "Open leads with no activity in N days, highest score first — likely missed opportunities worth chasing.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "Days without updates to count as stale (default 14)" },
        limit: { type: "number", description: "Max leads to return (default 10, max 25)" },
      },
    },
  },
};

/**
 * Build the system prompt from the org's name.
 * Falls back to a neutral description when the org record is not found or has
 * no name, so the assistant never claims a hardcoded company identity.
 */
export function buildSystemPrompt(orgName: string | null | undefined): string {
  const identity = orgName?.trim() ? `${orgName.trim()}'s CRM` : "this organization's CRM";
  return `You are the built-in business analyst for ${identity}. You answer questions from the company's own team about THEIR live CRM data using the provided tools.

Guidelines:
- Always call the relevant tools to get real numbers before answering. Never invent figures.
- Be concise, direct, and actionable. Lead with the answer, then the supporting numbers.
- Use markdown: short paragraphs, bullet lists, and tables when comparing things. Money in $ with commas.
- When asked "what's working vs not", compare conversion by source/service and call out the best and worst with numbers.
- Proactively flag one useful insight or next step when it's clearly supported by the data (e.g. stale high-score leads, overloaded teammates, high no-show rates).
- Material orders for jobs are not tracked in this CRM yet — say so honestly if asked, and suggest what is trackable (estimates, project statuses).
- If a question is about a specific person's performance, stick to neutral workload/pipeline facts; don't speculate about attitude or engagement beyond the numbers.
- Dates: "today" is the server date. Default lookback windows are fine unless the user asks for a period.`;
}

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function callOpenAi(
  messages: OpenAiMessage[],
  tools: Record<string, AssistantToolSpec>,
  options: { stream: boolean; tools: boolean },
): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: ASSISTANT_MODEL,
      max_tokens: 1200,
      messages,
      stream: options.stream,
      ...(options.tools
        ? {
            tools: Object.entries(tools).map(([name, t]) => ({
              type: "function",
              function: { name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/**
 * Run one assistant turn. Resolves tool calls (up to MAX_TOOL_ROUNDS), then
 * streams the final answer through onDelta. Returns the full answer text.
 */
export async function runAssistantToolLoop(params: {
  systemPrompt: string;
  messages: AssistantChatMessage[];
  tools: Record<string, AssistantLoopTool>;
  onDelta: (text: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown> | null) => void;
}): Promise<string> {
  const history: OpenAiMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callOpenAi(history, params.tools, { stream: false, tools: true });
    const data = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
      }[];
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI returned no message");

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Final answer arrived without streaming; emit it in one delta.
      const text = message.content?.trim() ?? "";
      params.onDelta(text);
      return text;
    }

    history.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    });
    for (const call of toolCalls) {
      const tool = params.tools[call.function.name];
      let args: Record<string, unknown> | null = null;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = null;
      }
      params.onToolCall?.(call.function.name, args);
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool: ${call.function.name}` };
      } else {
        try {
          if (args === null) throw new Error("Tool arguments were not valid JSON.");
          result = await tool.run(args);
        } catch (err) {
          logger.error({ err, tool: call.function.name }, "assistant tool failed");
          result = { error: "This data lookup failed; answer with what you have and mention the gap." };
        }
      }
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Tool budget exhausted — force a final answer without tools, streamed.
  const res = await callOpenAi(history, params.tools, { stream: true, tools: false });
  let full = "";
  const reader = res.body?.getReader();
  if (!reader) throw new Error("OpenAI stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          params.onDelta(delta);
        }
      } catch {
        // Ignore malformed keep-alive lines.
      }
    }
  }
  return full;
}
