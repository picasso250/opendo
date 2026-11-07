import { readChatStream } from "./group/streaming.ts";
import { WEB_TOOLS, runWebTool, type WebTool } from "./search.ts";
import { SILENCE_TOOL, isLiteralSilence } from "./group/decision.ts";
import { ROUTER_TASK_TOOLS, type RouterTaskTool } from "./group/task-tools.ts";

export type ModelMessage = {
  role: "system" | "assistant" | "user" | "tool";
  content: string | null;
  /** Stable participant identifier; never embed it into content. */
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  reasoning_content?: string | null;
  encrypted_content?: string | null;
};

export type LoopEnv = {
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  DEEPSEEK_API_KEY: string;
  provider?: "deepseek" | "volcengine";
  modelId?: string;
  apiKey?: string;
};

export type ToolTrace = {
  name: "web_search" | "web_fetch";
  input: string;
  ok: boolean;
  summary: string;
  durationMs: number;
  at: number;
};

export type ModelUsage = {
  provider: "deepseek" | "volcengine";
  modelId: string;
  round: number;
  at: number;
  durationMs: number;
  /** Time from HTTP request start until first nonempty SSE output delta. */
  ttftMs: number | null;
  /** Time until first user-visible text delta (thinking may precede it). */
  firstContentMs: number | null;
  httpStatus: number | null;
  /** Safe provider termination category, not raw model text. */
  finishReason: string | null;
  success: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
};

/** Only allowlisted diagnostic labels cross the private upstream error boundary.
 * Provider message text may echo the user's prompt or even credentials, so
 * never broadcast or persist the raw upstream response body.
 */
export function safeUpstreamDiagnostic(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as {error?:unknown}).error;
  if (!error || typeof error !== "object") return null;
  const data = error as {message?:unknown;param?:unknown;type?:unknown;code?:unknown};
  const tags: string[] = [];
  const param = typeof data.param === "string" ? data.param : "";
  const allowedParam = /^(?:model|tools|tool_choice|stream_options|thinking|reasoning_effort|max_tokens|messages(?:\[\d{1,3}\]|\.\d{1,3})?(?:\.(?:role|content|name|reasoning_content|tool_calls|tool_call_id|type|function|arguments)(?:\[\d{1,3}\])?)*)$/;
  if (param.length<=80 && allowedParam.test(param)) tags.push("param:" + param);
  const candidates = [data.message, data.code].filter(x=>typeof x==="string").join(" ");
  const hints: Array<[RegExp,string]> = [
    [/reasoning_content/i,"reasoning_content"],
    [/tool_calls?/i,"tool_calls"],
    [/tool_choice/i,"tool_choice"],
    [/stream_options/i,"stream_options"],
    [/max_tokens/i,"max_tokens"],
    [/context.{0,12}length|too many tokens/i,"context_length"],
    [/messages/i,"messages"],
    [/name/i,"name"],
    [/model/i,"model"],
    [/tools/i,"tools"]
  ];
  const matched=hints.find(([re])=>re.test(candidates));
  if(matched&&!tags.some(x=>x.endsWith(matched[1])))tags.push("hint:"+matched[1]);
  const type=typeof data.type==="string"?data.type:"";
  if(["invalid_request_error","authentication_error","permission_error",
      "rate_limit_error","server_error"].includes(type))tags.push("type:"+type);
  return tags.length?tags.join(" / "):null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

export type ModelOutput =
  { kind: "speak"; text: string; usedTools: string[]; reasoning?: string; traces: ToolTrace[] } |
  { kind: "silence"; usedTools: string[]; traces: ToolTrace[];
    reasoning?: string; via: "silence_tool" | "literal_text" };

export type TraceCallback = (trace: ToolTrace) => void | Promise<void>;

export async function modelWithTools(
  env: LoopEnv,
  history: ModelMessage[],
  fetcher: typeof fetch = fetch,
  onTrace?: TraceCallback,
  onUsage?: (usage: ModelUsage) => void | Promise<void>,
  onReasoning?: (reasoning: string) => void | Promise<void>,
  onTaskTool?: (name: RouterTaskTool,args:Record<string,unknown>|null) => Promise<string>
): Promise<ModelOutput> {
  const provider = env.provider ?? "deepseek";
  const model = env.modelId ?? env.DEEPSEEK_MODEL;
  const key = env.apiKey ?? env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("模型 API Key 未配置");
  const endpoint = provider === "volcengine"
    ? "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    : "https://api.deepseek.com/chat/completions";
  const tools = [SILENCE_TOOL, ...WEB_TOOLS, ...(onTaskTool ? ROUTER_TASK_TOOLS : [])];
  const turns = [...history];
  const usedTools: string[] = [];
  const traces: ToolTrace[] = [];
  let webCalls = 0;
  let taskCreates = 0;
  const reasoningParts: string[] = [];
  for (let round = 0; round < 5; round++) {
    const request: Record<string, unknown> = {
      model,
      messages: turns,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8192,
      reasoning_effort: "high"
    };
    if (provider === "deepseek") {
      request.thinking = { type: "enabled" };
    }
    const at = Date.now();
    const start = performance.now();
    let upstream: Response;
    let ttftMs: number | null = null;
    let firstContentMs: number | null = null;
    let finishReason: string | null = null;
    const report = async (status: number | null, success: boolean, usage?: any) => {
      if (!onUsage) return;
      await onUsage({
        provider, modelId: model, round: round + 1, at,
        durationMs: Math.max(0, Math.round(performance.now() - start)),
        ttftMs, firstContentMs,
        httpStatus: status, finishReason, success,
        promptTokens: countOrNull(usage?.prompt_tokens),
        completionTokens: countOrNull(usage?.completion_tokens),
        reasoningTokens: countOrNull(usage?.completion_tokens_details?.reasoning_tokens),
        cacheHitTokens: countOrNull(usage?.prompt_cache_hit_tokens ??
          usage?.prompt_tokens_details?.cached_tokens),
        cacheMissTokens: countOrNull(usage?.prompt_cache_miss_tokens)
      });
    };
    try {
      upstream = await fetcher(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(90_000)
      });
    } catch (error) {
      await report(null, false);
      throw error;
    }
    if (!upstream.ok) {
      // The body is never stored or shown; only safe parameter/category hints.
      let diagnostic: string | null = null;
      try {
        const text = (await upstream.text()).slice(0, 8192);
        diagnostic=safeUpstreamDiagnostic(JSON.parse(text));
      } catch { /* not all providers return structured JSON errors */ }
      await report(upstream.status, false);
      const error = new Error(provider + " HTTP " + upstream.status) as Error &
        {safeDiagnostic?:string};
      if(diagnostic)error.safeDiagnostic=diagnostic;
      throw error;
    }
    let payload: any;
    try {
      if(upstream.headers.get("content-type")?.includes("text/event-stream")) {
        if(!upstream.body)throw new Error("empty streamed model response");
        payload=await readChatStream(upstream.body,(kind)=>{
          const elapsed=Math.max(0,Math.round(performance.now()-start));
          if(kind==="first_token" && ttftMs===null)ttftMs=elapsed;
          if(kind==="first_content" && firstContentMs===null)firstContentMs=elapsed;
        });
      }else{
        // Compatibility with providers or mocks responding with JSON despite
        // stream:true. There is no honest TTFT measurement in this branch.
        payload=await upstream.json();
      }
    } catch (error) {
      await report(upstream.status, false);
      throw error;
    }
    const rawFinish = payload.choices?.[0]?.finish_reason;
    finishReason = typeof rawFinish==="string" &&
      ["stop","length","content_filter","tool_calls","function_call"].includes(rawFinish)
      ? rawFinish : null;
    // A successful HTTP response can still contain no generated output.
    // Preserve this distinction in model_usage and in the decision's error.
    const msg = payload.choices?.[0]?.message;
    if (!msg || typeof msg !== "object") {
      await report(upstream.status, false, payload?.usage);
      throw new Error("missing model response");
    }
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      reasoningParts.push(msg.reasoning_content.trim());
      if (onReasoning) {
        await onReasoning(reasoningParts.join("\n\n———\n\n").slice(0, 24000));
      }
    }
    const calls = msg.tool_calls;
    if (!Array.isArray(calls) || !calls.length) {
      if (typeof msg.content !== "string" || !msg.content.trim()) {
        await report(upstream.status, false, payload?.usage);
        const error=new Error("empty model answer") as Error & {finishReason?:string};
        if(finishReason)error.finishReason=finishReason;
        throw error;
      }
      const text = msg.content.trim();
      await report(upstream.status, true, payload?.usage);
      if (isLiteralSilence(text)) return {
        kind: "silence", usedTools, traces, via: "literal_text",
        ...(reasoningParts.length ? { reasoning: reasoningParts.join("\n\n———\n\n").slice(0, 24000) } : {})
      };
      const reasoning = reasoningParts.join("\n\n———\n\n").slice(0, 24000);
      return {
        kind: "speak", text: text.slice(0, 1600), usedTools, traces,
        ...(reasoning ? { reasoning } : {})
      };
    }
    const permitted=onTaskTool
      ? ["silence","web_search","web_fetch","list_workers","create_task","get_task"]
      : ["silence","web_search","web_fetch"];
    if (calls.some((call: any) => !call || call.type !== "function" ||
      !permitted.includes(call.function?.name))) {
      await report(upstream.status, false, payload?.usage);
      throw new Error("unexpected model tool call");
    }
    if (calls.some((call: any) => call.function.name === "silence")) {
      if (calls.length !== 1) {
        await report(upstream.status, false, payload?.usage);
        throw new Error("silence cannot combine with tools");
      }
      await report(upstream.status, true, payload?.usage);
      return {
        kind: "silence", usedTools, traces, via: "silence_tool",
        ...(reasoningParts.length ? { reasoning: reasoningParts.join("\n\n———\n\n").slice(0, 24000) } : {})
      };
    }
    await report(upstream.status, true, payload?.usage);
    turns.push({
      role: "assistant", content: typeof msg.content === "string" ? msg.content : null,
      tool_calls: calls,
      ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
      // Some Doubao models return encrypted thinking; pass it back unchanged.
      ...(typeof msg.encrypted_content === "string" ? { encrypted_content: msg.encrypted_content } : {})
    });
    for (const call of calls) {
      let args: Record<string, unknown> | null;
      try {
        const parsed = JSON.parse(call.function.arguments);
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch { args = null; }
      const name = call.function.name as WebTool|RouterTaskTool;
      if(name==="list_workers" || name==="create_task" || name==="get_task") {
        // One task creation per Router decision; no recursion or self-spawning.
        const output=name==="create_task" && taskCreates++>=1
          ? "本次 AI 决策已创建过任务；如需第二个任务请等待下一次人类触发。"
          : await onTaskTool!(name,args);
        turns.push({role:"tool",tool_call_id:call.id,content:output});
        continue;
      }
      const input = String(name === "web_search" ? args?.query ?? "" : args?.url ?? "").slice(0, 400);
      const at = Date.now();
      const start = performance.now();
      let output: string;
      if (webCalls >= 3) {
        output = "本轮联网次数已达到上限（3 次），请根据已获得的资料回答。";
      } else {
        webCalls++;
        usedTools.push(name);
        // DeepSeek AIs use their own key for Search/Fetch. Volcengine AIs
        // temporarily use the room's DeepSeek tool credential; unlike the
        // model request, these tool costs are paid by the room owner.
        const searchKey = provider === "deepseek" ? key : env.DEEPSEEK_API_KEY;
        output = await runWebTool(name as WebTool, args, {
          DEEPSEEK_API_KEY: searchKey,
          DEEPSEEK_BASE_URL: "https://api.deepseek.com"
        }, fetcher);
      }
      const ok = webCalls <= 3 && output.startsWith("以下内容来自外部网页");
      const trace: ToolTrace = {
        name: name as WebTool, input, ok,
        summary: ok ? (name === "web_search" ? "已获取搜索结果" : "已读取网页") :
          output.slice(0, 120),
        durationMs: Math.round(performance.now() - start), at
      };
      traces.push(trace);
      if (onTrace) await onTrace(trace);
      turns.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
  throw new Error("model tool loop exceeded");
}
