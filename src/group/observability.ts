/** Public, deliberately bounded diagnosis for one model decision.
 * Never store or broadcast raw exception text: providers/proxies sometimes
 * echo request data and credential-bearing URLs in their error messages.
 */
export type DecisionOutcome = "replied" | "silence" | "skipped" | "failed";

export function safeAIError(error: unknown): { code: string; detail: string } {
  const message = error instanceof Error ? error.message : "";
  const http = /^(?:deepseek|volcengine) HTTP (4\d\d|5\d\d)$/.exec(message);
  if (http) {
    const hint = error && typeof error === "object" && "safeDiagnostic" in error
      && typeof error.safeDiagnostic === "string"
      && /^[a-zA-Z0-9_:\[\]. \/-]{1,180}$/.test(error.safeDiagnostic)
      ? error.safeDiagnostic : "";
    return {code:"upstream_http_"+http[1],
      detail:"模型服务商返回 HTTP "+http[1]+(hint?"（"+hint+"）":"")};
  }
  if (message === "AI 凭据不可用" || message === "AI 加密密钥尚未配置" ||
      message === "AI 加密密钥无效" || message.includes("密钥损坏") ||
      message.includes("不支持的密钥格式")) {
    return { code: "credential_error", detail: "模型凭据不可用或无法解密" };
  }
  if (message === "empty model answer") {
    const reason=error && typeof error==="object" && "finishReason" in error
      && typeof error.finishReason==="string"
      && ["stop","length","content_filter","tool_calls","function_call"].includes(error.finishReason)
      ? error.finishReason : null;
    if(reason==="content_filter")return {code:"model_content_filter",
      detail:"模型输出被服务商的内容审核拦截（finish_reason=content_filter）"};
    if(reason==="length")return {code:"model_output_truncated",
      detail:"模型因长度限制停止，且没有生成可用的正文或工具调用（finish_reason=length）"};
    return {code:"model_empty_output",
      detail:"模型接口返回 HTTP 200，但没有生成正文或工具调用"+
        (reason?"（finish_reason="+reason+"）":"（结束原因未返回）")};
  }
  if (message === "missing model response" ||
      message === "unexpected model tool call" || message === "silence cannot combine with tools" ||
      message === "model tool loop exceeded") {
    return { code: "model_protocol", detail: "模型返回内容不符合预期的工具或消息协议" };
  }
  if (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError" ||
       /timeout|timed out/i.test(message))) {
    return { code: "timeout", detail: "模型请求超时" };
  }
  if (error instanceof SyntaxError) {
    return { code: "response_parse", detail: "无法解析模型返回的数据" };
  }
  if (message.includes("decrypt") || message.includes("Decrypt")) {
    return { code: "credential_error", detail: "模型凭据无法解密" };
  }
  return { code: "request_error", detail: "模型请求或处理过程发生异常（详细信息仅保留在服务器日志中）" };
}
