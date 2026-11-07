/** Public task protocol shared by Router, Durable Object and a local Runner.
 * A Task carries instructions and an immutable final result. It carries NO
 * shell argv, executable path, working directory or security policy; those
 * are selected only by the locally configured Worker profile.
 */
export const TASK_DEADLINE_MS = 30 * 60_000;
export const TASK_LEASE_MS = 5 * 60_000;
export const TASK_HEARTBEAT_MS = 2 * 60_000;
export const TASK_POLL_MS = 60_000;
export const TASK_MAX_INSTRUCTIONS = 32_000;
export const TASK_MAX_RESULT = 256_000;
export const TASK_MAX_ACTIVE_PER_ROUTER = 5;
/** An execution config is a named capability of a locally owned harness.
 * Metadata is untrusted: Router may choose only its id, never its shell flags.
 */
export type ExecutionConfig = {
  id:string; label:string; description:string;
  harness:string|null; model:string|null; effort:string|null;
};
export const LEGACY_EXECUTION_CONFIG:ExecutionConfig = {
  id:"default",label:"默认执行配置",description:"使用本机执行器默认设置",
  harness:null,model:null,effort:null
};
export const MAX_EXECUTION_CONFIGS=20;
export function isExecutionConfigId(value:unknown):value is string {
  return typeof value==="string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value);
}
/** Validate an advertised catalog; never treat its prose as instructions. */
export function parseExecutionConfigs(value:unknown):ExecutionConfig[] {
  if(!Array.isArray(value)||value.length<1||value.length>MAX_EXECUTION_CONFIGS)
    throw new Error("执行配置列表必须包含 1～20 项");
  const ids=new Set<string>();
  return value.map(raw=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("执行配置无效");
    const r=raw as Record<string,unknown>;
    const id=r.id;
    if(!isExecutionConfigId(id)||ids.has(id))throw new Error("执行配置 ID 无效或重复");
    ids.add(id);
    if(typeof r.label!=="string"||!r.label.trim()||r.label.length>80)
      throw new Error("配置名称必须在 1～80 字之间");
    const description=r.description??"";
    if(typeof description!=="string"||description.length>500)
      throw new Error("配置描述不能超过 500 字");
    const harness=r.harness??null,model=r.model??null,effort=r.effort??null;
    if(harness!==null && (typeof harness!=="string"||! /^[a-zA-Z0-9_. -]{1,60}$/.test(harness)))
      throw new Error("Harness 标识无效");
    if(model!==null && (typeof model!=="string"||! /^[a-zA-Z0-9_.:/-]{1,120}$/.test(model)))
      throw new Error("模型 ID 无效");
    if(effort!==null && (typeof effort!=="string"||! /^[a-zA-Z0-9_-]{1,40}$/.test(effort)))
      throw new Error("推理等级标识无效");
    return {id,label:r.label.trim(),description:description.trim(),harness,model,effort};
  });
}
export function savedExecutionConfigs(json:string):ExecutionConfig[] {
  try{return parseExecutionConfigs(JSON.parse(json))}
  catch{return [LEGACY_EXECUTION_CONFIG]}
}

export const TASK_TERMINAL = ["completed", "failed", "refused", "timed_out"] as const;
export type TaskTerminal = typeof TASK_TERMINAL[number];
export type TaskStatus = "pending" | "running" | TaskTerminal;
export type TaskRecord = {
  id: string; creator: string; worker_id: string; title: string;
  instructions: string; execution_config_id: string|null;
  execution_config_snapshot: string|null;
  actual_model: string|null; actual_effort: string|null;
  status: TaskStatus; created_at: number;
  deadline_at: number; claimed_at: number | null; lease_until: number | null;
  claim_id: string | null; finished_at: number | null;
  result: string | null; result_status: string | null;
  created_message_id: number | null; finished_message_id: number | null;
};
export function taskCreation(input: unknown): {worker_id:string;title:string;instructions:string;execution_config_id:string|null} {
  if (!input || typeof input!=="object" || Array.isArray(input))throw new Error("任务参数无效");
  const p=input as Record<string,unknown>;
  const worker_id=typeof p.worker_id==="string" ? p.worker_id : "";
  const title=typeof p.title==="string" ? p.title.trim() : "";
  const instructions=typeof p.instructions==="string" ? p.instructions.trim() : "";
  const execution_config_id=p.execution_config_id===undefined?null:p.execution_config_id;
  if(execution_config_id!==null && !isExecutionConfigId(execution_config_id))
    throw new Error("执行配置 ID 无效");
  if(!/^worker_[a-f0-9]{32}$/.test(worker_id))throw new Error("Worker ID 无效");
  if(!title || title.length>100)throw new Error("任务标题必须在 1~100 字之间");
  if(!instructions || instructions.length>TASK_MAX_INSTRUCTIONS)
    throw new Error("任务书必须在 1~32000 字之间");
  return {worker_id,title,instructions,execution_config_id};
}
export function taskResult(input: unknown): {task_id:string;claim_id:string;status:Exclude<TaskTerminal,"timed_out">;output:string} {
  if(!input || typeof input!=="object" || Array.isArray(input))throw new Error("结果参数无效");
  const p=input as Record<string,unknown>;
  if(typeof p.task_id!=="string" || !/^task_[a-f0-9]{32}$/.test(p.task_id) ||
     typeof p.claim_id!=="string" || !/^[a-f0-9-]{36}$/.test(p.claim_id))
    throw new Error("任务或领取凭证无效");
  if(!["completed","failed","refused"].includes(String(p.status)))
    throw new Error("结果状态无效");
  if(typeof p.output!=="string" || p.output.length>TASK_MAX_RESULT)
    throw new Error("任务结果长度无效（最大 256000 字）");
  return {task_id:p.task_id,claim_id:p.claim_id,
    status:p.status as "completed"|"failed"|"refused",output:p.output};
}
export function taskCardContent(phase:"created"|TaskTerminal,
  task:Pick<TaskRecord,"id"|"title"|"worker_id">&Partial<Pick<TaskRecord,"execution_config_id">>):string {
  const statusName:Record<typeof phase,string>={created:"创建",completed:"完成",failed:"失败",refused:"拒绝",timed_out:"超时"};
  const selection=task.execution_config_id?` · 配置 ${task.execution_config_id}`:"";
  return `Task ${task.id} · ${statusName[phase]} · ${task.title} · Worker ${task.worker_id}${selection}。任务书与原始结果请通过任务详情查看。`;
}
export function taskSummary(task: TaskRecord) {
  const {instructions:_,result:__,claim_id:___,...summary}=task;
  return summary;
}
