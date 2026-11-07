import { Agent } from "agents";
import { buildGroupContext, isLiteralSilence, type GroupTurn } from "./decision";
import {
  DEFAULT_DS_PERSONA, MAX_AI_PER_HUMAN, publicAI, readAIInput,
  encryptAPIKey, decryptAPIKey, type AIRecord, type HumanId
} from "./ai";
import { modelWithTools, type ToolTrace, type ModelUsage } from "../toolloop";
import { fastestFirst, estimateTTFT } from "./scheduling";
import { nextWaveSpeakers, isJobSuperseded, MAX_DISCUSSION_ROUNDS } from "./discussion";
import { safeAIError, type DecisionOutcome } from "./observability";
import {
  TASK_DEADLINE_MS,TASK_LEASE_MS,TASK_MAX_ACTIVE_PER_ROUTER,
  taskCreation,taskResult,taskCardContent,parseExecutionConfigs,savedExecutionConfigs,
  isExecutionConfigId,type ExecutionConfig,type TaskRecord,type TaskTerminal
} from "./task-contract";
import type {RouterTaskTool} from "./task-tools";

type Row = {
  id: number; role: string; content: string; created_at: number;
  reasoning: string | null; trace: string | null; usage: string | null;
  kind?:string;task_id?:string|null
};
type SessionState = { member: HumanId };
type Job = {
  message_id:number;ai_id:string;root_message_id:number|null;discussion_round:number
};
const MAX_CHAT_LENGTH = 1200;
const MAX_PER_MINUTE = 10;
const MAX_DAILY_AI_CALLS = 240;

const DECISION_USAGE_JOIN = "(SELECT message_id,ai_id,COUNT(*) AS model_requests,"+
  "SUM(prompt_tokens) AS prompt_tokens,SUM(completion_tokens) AS completion_tokens,"+
  "SUM(reasoning_tokens) AS reasoning_tokens,SUM(cache_hit_tokens) AS cache_hit_tokens,"+
  "SUM(cache_miss_tokens) AS cache_miss_tokens," +
  "MIN(CASE WHEN model_round=1 THEN ttft_ms END) AS first_request_ttft_ms " +
  "FROM model_usage " +
  "WHERE message_id >= (SELECT COALESCE(MIN(message_id),0) FROM " +
  "(SELECT message_id FROM ai_jobs ORDER BY message_id DESC LIMIT 150)) " +
  "GROUP BY message_id,ai_id)";

export class GroupRoom extends Agent<Env> {
  #draining = false;

  onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS messages (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL," +
      "created_at INTEGER NOT NULL, client_id TEXT, reasoning TEXT, trace TEXT, usage TEXT)");
    const columns = sql.exec<{name:string}>("PRAGMA table_info(messages)").toArray();
    if (!columns.some(c=>c.name==="reasoning")) sql.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT");
    if (!columns.some(c=>c.name==="trace")) sql.exec("ALTER TABLE messages ADD COLUMN trace TEXT");
    if (!columns.some(c=>c.name==="usage")) sql.exec("ALTER TABLE messages ADD COLUMN usage TEXT");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_client ON messages(role,client_id)");
    if (!columns.some(c=>c.name==="kind")) sql.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    if (!columns.some(c=>c.name==="task_id")) sql.exec("ALTER TABLE messages ADD COLUMN task_id TEXT");
    sql.exec("CREATE TABLE IF NOT EXISTS task_workers ("+
      "id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',"+
      "owner TEXT NOT NULL,token_hash TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,"+
      "last_seen INTEGER,created_at INTEGER NOT NULL,"+
      "execution_configs TEXT NOT NULL DEFAULT '[]',"+
      "default_config_id TEXT NOT NULL DEFAULT 'default',"+
      "catalog_session_id TEXT)");
    const workerCols=sql.exec<{name:string}>("PRAGMA table_info(task_workers)").toArray();
    if(!workerCols.some(c=>c.name==="description"))
      sql.exec("ALTER TABLE task_workers ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    if(!workerCols.some(c=>c.name==="execution_configs"))
      sql.exec("ALTER TABLE task_workers ADD COLUMN execution_configs TEXT NOT NULL DEFAULT '[]'");
    if(!workerCols.some(c=>c.name==="default_config_id"))
      sql.exec("ALTER TABLE task_workers ADD COLUMN default_config_id TEXT NOT NULL DEFAULT 'default'");
    if(!workerCols.some(c=>c.name==="catalog_session_id"))
      sql.exec("ALTER TABLE task_workers ADD COLUMN catalog_session_id TEXT");
    sql.exec("CREATE TABLE IF NOT EXISTS tasks ("+
      "id TEXT PRIMARY KEY,creator TEXT NOT NULL,worker_id TEXT NOT NULL,"+
      "title TEXT NOT NULL,instructions TEXT NOT NULL,execution_config_id TEXT,"+
      "execution_config_snapshot TEXT,actual_model TEXT,actual_effort TEXT,"+
      "status TEXT NOT NULL,created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,"+
      "claimed_at INTEGER,lease_until INTEGER,claim_id TEXT,finished_at INTEGER,"+
      "result TEXT,result_status TEXT,created_message_id INTEGER,finished_message_id INTEGER,"+
      "source_message_id INTEGER,source_ai_id TEXT,client_request_id TEXT)");
    const taskCols=sql.exec<{name:string}>("PRAGMA table_info(tasks)").toArray();
    if(!taskCols.some(c=>c.name==="client_request_id"))
      sql.exec("ALTER TABLE tasks ADD COLUMN client_request_id TEXT");
    if(!taskCols.some(c=>c.name==="execution_config_id"))
      sql.exec("ALTER TABLE tasks ADD COLUMN execution_config_id TEXT");
    if(!taskCols.some(c=>c.name==="execution_config_snapshot"))
      sql.exec("ALTER TABLE tasks ADD COLUMN execution_config_snapshot TEXT");
    if(!taskCols.some(c=>c.name==="actual_model"))
      sql.exec("ALTER TABLE tasks ADD COLUMN actual_model TEXT");
    if(!taskCols.some(c=>c.name==="actual_effort"))
      sql.exec("ALTER TABLE tasks ADD COLUMN actual_effort TEXT");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_task_request ON tasks(client_request_id)");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_message_id,source_ai_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_worker_state ON tasks(worker_id,status,created_at)");
    sql.exec("CREATE TABLE IF NOT EXISTS task_late_results ("+
      "task_id TEXT NOT NULL,claim_id TEXT NOT NULL,received_at INTEGER NOT NULL,"+
      "status TEXT NOT NULL,output TEXT NOT NULL,PRIMARY KEY(task_id,claim_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS ai_members (" +
      "id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL," +
      "provider TEXT NOT NULL, model_id TEXT NOT NULL, persona TEXT NOT NULL," +
      "encrypted_key TEXT, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    sql.exec(
      "INSERT OR IGNORE INTO ai_members " +
      "(id,owner,name,provider,model_id,persona,encrypted_key,enabled,created_at) " +
      "VALUES ('ds','xiaochi','DS','deepseek',?,?,NULL,1,?)",
      this.env.DEEPSEEK_MODEL, DEFAULT_DS_PERSONA, Date.now()
    );
    sql.exec("CREATE TABLE IF NOT EXISTS ai_jobs (" +
      "message_id INTEGER NOT NULL, ai_id TEXT NOT NULL, status TEXT NOT NULL," +
      "created_at INTEGER NOT NULL, run_order INTEGER NOT NULL DEFAULT 0," +
      "PRIMARY KEY(message_id, ai_id))");
    const jobColumns = sql.exec<{name:string}>("PRAGMA table_info(ai_jobs)").toArray();
    if (!jobColumns.some(c=>c.name==="run_order")) {
      sql.exec("ALTER TABLE ai_jobs ADD COLUMN run_order INTEGER NOT NULL DEFAULT 0");
    }
    // Additive migration: do not change existing messages, AI credentials, or jobs.
    const decisionColumns: Record<string,string> = {
      outcome:"TEXT", started_at:"INTEGER", finished_at:"INTEGER",
      reply_message_id:"INTEGER", error_code:"TEXT", error_detail:"TEXT",
      reasoning:"TEXT", decision_method:"TEXT", ai_name:"TEXT", model_id:"TEXT",
      root_message_id:"INTEGER",discussion_round:"INTEGER NOT NULL DEFAULT 1"
    };
    for (const [name,type] of Object.entries(decisionColumns)) {
      if (!jobColumns.some(c=>c.name===name)) {
        sql.exec("ALTER TABLE ai_jobs ADD COLUMN "+name+" "+type);
      }
    }
    sql.exec("CREATE TABLE IF NOT EXISTS ai_calls (" +
      "message_id INTEGER NOT NULL, ai_id TEXT NOT NULL, created_at INTEGER NOT NULL," +
      "PRIMARY KEY(message_id, ai_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS tool_activity (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, ai_id TEXT NOT NULL," +
      "message_id INTEGER NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL," +
      "ok INTEGER NOT NULL, summary TEXT NOT NULL, duration_ms INTEGER NOT NULL," +
      "created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS model_usage (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, ai_id TEXT NOT NULL, message_id INTEGER NOT NULL," +
      "provider TEXT NOT NULL, model_id TEXT NOT NULL, model_round INTEGER NOT NULL," +
      "http_status INTEGER, success INTEGER NOT NULL," +
      "prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER," +
      "cache_hit_tokens INTEGER, cache_miss_tokens INTEGER," +
      "duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    const modelColumns=sql.exec<{name:string}>("PRAGMA table_info(model_usage)").toArray();
    if(!modelColumns.some(x=>x.name==="ttft_ms"))
      sql.exec("ALTER TABLE model_usage ADD COLUMN ttft_ms INTEGER");
    if(!modelColumns.some(x=>x.name==="first_content_ms"))
      sql.exec("ALTER TABLE model_usage ADD COLUMN first_content_ms INTEGER");
    if(!modelColumns.some(x=>x.name==="finish_reason"))
      sql.exec("ALTER TABLE model_usage ADD COLUMN finish_reason TEXT");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_model_usage_ai_time ON model_usage(ai_id,created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_model_usage_decision ON model_usage(message_id,ai_id)");
    sql.exec("UPDATE ai_jobs SET status='pending',started_at=NULL WHERE status='working'");
    // Preserve any queued requests created by the old one-AI version.
    const old = sql.exec<{name:string}>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_ai'"
    ).toArray();
    if (old.length) {
      sql.exec("INSERT OR IGNORE INTO ai_jobs(message_id,ai_id,status,created_at) " +
        "SELECT message_id,'ds','pending',created_at FROM pending_ai WHERE state!='done'");
      sql.exec("UPDATE pending_ai SET state='done' WHERE state!='done'");
    }
    this.expireOverdueTasks();
    this.ctx.waitUntil(this.drain());
  }

  /** The only place where Task messages are appended. The original task book
   * and result remain immutable in the tasks table, never in an AI reply. */
  private taskEvent(task:TaskRecord,phase:"created"|TaskTerminal|"late") {
    const sql=this.ctx.storage.sql;
    const now=Date.now();
    const kind=phase==="created"?"task_create":phase==="late"?"task_late":"task_result";
    let content=phase==="late"
      ? `Task ${task.id} 的迟到结果已收到；截止状态不变。点击任务卡片查看原始输出。`
      : taskCardContent(phase,task);
    if(phase==="created") content+="\n任务书开头（原文）：\n"+task.instructions.slice(0,1500);
    else if(phase!=="late"&&task.result!==null)
      content+="\nWorker 原始输出开头：\n"+task.result.slice(0,1500);
    sql.exec("INSERT INTO messages(role,content,created_at,kind,task_id) VALUES ('system',?,?,?,?)",
      content,now,kind,task.id);
    const id=sql.exec<{id:number}>("SELECT last_insert_rowid() AS id").one().id;
    this.broadcast(JSON.stringify({type:"message",message:{id,role:"system",content,
      created_at:now,kind,task_id:task.id,reasoning:null,trace:[],usage:null}}));
    if(kind==="task_result")this.scheduleTaskTriggeredWave(id);
    return id;
  }

  /** P0 human messages supersede every queued older turn elsewhere. P1 task
   * terminal events preempt P2 autonomous continuation, and batch together if
   * another P1 event arrives before its first AI starts. No event is dropped.
   */
  private scheduleTaskTriggeredWave(eventId:number) {
    const sql=this.ctx.storage.sql;
    const rows=sql.exec<{message_id:number;ai_id:string}>(
      "SELECT j.message_id,j.ai_id FROM ai_jobs j " +
      "LEFT JOIN messages m ON m.id=j.root_message_id " +
      "WHERE j.status='pending' AND (j.discussion_round>1 OR m.kind='task_result')"
    ).toArray();
    if(rows.length){
      sql.exec("UPDATE ai_jobs SET status='done',outcome='skipped',finished_at=?,"+
        "error_code='task_event_superseded',"+
        "error_detail='新的 Task 终结事件到达，旧自动续聊合并到新轮次' " +
        "WHERE status='pending' AND (discussion_round>1 OR root_message_id IN " +
        "(SELECT id FROM messages WHERE kind='task_result'))",Date.now());
      for(const row of rows)this.notifyDecision(row.message_id,row.ai_id);
    }
    const participants=this.fastestAIOrder(this.allAI().filter(x=>x.enabled));
    const now=Date.now();
    for(const [order,ai] of participants.entries()){
      sql.exec("INSERT OR IGNORE INTO ai_jobs " +
        "(message_id,ai_id,status,created_at,run_order,ai_name,model_id,root_message_id,discussion_round) " +
        "VALUES (?,?,'pending',?,?,?,?,?,1)",eventId,ai.id,now,order,ai.name,ai.model_id,eventId);
      this.notifyDecision(eventId,ai.id);
    }
    this.ctx.waitUntil(this.drain());
  }

  /** Agent scheduler uses its own shared DO alarm; never setAlarm directly. */
  async expireTask(input:{task_id:string}) {
    const sql=this.ctx.storage.sql;
    const task=sql.exec<TaskRecord>("SELECT * FROM tasks WHERE id=?",input.task_id).toArray()[0];
    if(!task || (task.status!=="pending"&&task.status!=="running") ||
      task.deadline_at>Date.now())return;
    this.markTaskTimedOut(task);
  }

  private markTaskTimedOut(task:TaskRecord) {
    const now=Date.now();
    const sql=this.ctx.storage.sql;
    sql.exec("UPDATE tasks SET status='timed_out',finished_at=? " +
      "WHERE id=? AND status IN ('pending','running')",now,task.id);
    const updated={...task,status:"timed_out" as const,finished_at:now};
    const msgId=this.taskEvent(updated,"timed_out");
    sql.exec("UPDATE tasks SET finished_message_id=? WHERE id=?",msgId,task.id);
  }
  private expireOverdueTasks() {
    const tasks=this.ctx.storage.sql.exec<TaskRecord>(
      "SELECT * FROM tasks WHERE status IN ('pending','running') AND deadline_at<=? " +
      "ORDER BY deadline_at LIMIT 100",Date.now()).toArray();
    for(const task of tasks)this.markTaskTimedOut(task);
  }

  private publicWorkers() {
    return this.ctx.storage.sql.exec<{
      id:string;name:string;description:string;execution_configs:string;
      default_config_id:string;enabled:number;owner:string;last_seen:number|null
    }>("SELECT id,name,description,execution_configs,default_config_id,"+
      "enabled,owner,last_seen FROM task_workers ORDER BY created_at,id")
      .toArray().map(w=>({...w,execution_configs:savedExecutionConfigs(w.execution_configs),
        enabled:!!w.enabled,online:!!w.last_seen && Date.now()-w.last_seen<10*60_000}));
  }
  private async tokenHash(token:string) {
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("dsgo-worker-v1:"+token));
    return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
  }
  private async registerTaskWorker(connection:any,owner:HumanId,body:Record<string,unknown>) {
    const name=typeof body.name==="string"?body.name.trim():"";
    const description=typeof body.description==="string"?body.description.trim():"";
    if(!name||name.length>64)throw new Error("Worker 名称无效");
    if(body.description!==undefined && typeof body.description!=="string")
      throw new Error("Worker 能力描述必须是文字");
    if(description.length>1000)throw new Error("Worker 能力描述不能超过 1000 字");
    if(this.publicWorkers().length>=12)throw new Error("Worker 数量已达上限");
    const id="worker_"+crypto.randomUUID().replace(/-/g,"");
    const secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),
      b=>b.toString(16).padStart(2,"0")).join("");
    const token=id+"."+secret;
    const hash=await this.tokenHash(token);
    this.ctx.storage.sql.exec("INSERT INTO task_workers " +
      "(id,name,description,owner,token_hash,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
      id,name,description,owner,hash,Date.now());
    // Credential is returned once, only to the registering human's WS.
    connection.send(JSON.stringify({type:"worker_registered",worker_id:id,name,token}));
    this.broadcast(JSON.stringify({type:"workers",workers:this.publicWorkers()}));
  }
  private disableTaskWorker(owner:HumanId,body:Record<string,unknown>) {
    if(typeof body.worker_id!=="string"||typeof body.enabled!=="boolean")
      throw new Error("Worker 设置无效");
    const w=this.ctx.storage.sql.exec<{owner:string}>(
      "SELECT owner FROM task_workers WHERE id=?",body.worker_id).toArray()[0];
    if(!w || w.owner!==owner)throw new Error("不能管理其他成员创建的 Worker");
    // Do not invalidate a running Runner's credential before it can return a
    // result. Idle or pending Workers may still be paused.
    if(!body.enabled){
      const running=this.ctx.storage.sql.exec<{n:number}>(
        "SELECT COUNT(*) AS n FROM tasks WHERE worker_id=? AND status='running'",
        body.worker_id).one().n;
      if(running)throw new Error("Worker 正在执行任务，请等待任务结束后再暂停");
    }
    this.ctx.storage.sql.exec("UPDATE task_workers SET enabled=? WHERE id=?",
      body.enabled?1:0,body.worker_id);
    this.broadcast(JSON.stringify({type:"workers",workers:this.publicWorkers()}));
  }
  private updateTaskWorker(connection:any,owner:HumanId,body:Record<string,unknown>) {
    if(typeof body.worker_id!=="string"||!/^worker_[a-f0-9]{32}$/.test(body.worker_id))
      throw new Error("Worker ID 无效");
    const w=this.ctx.storage.sql.exec<{id:string;owner:string}>(
      "SELECT id,owner FROM task_workers WHERE id=?",body.worker_id).toArray()[0];
    if(!w||w.owner!==owner)throw new Error("只能编辑自己的 Worker");
    const name=typeof body.name==="string"?body.name.trim():"";
    const description=typeof body.description==="string"?body.description.trim():"";
    if(!name||name.length>64)throw new Error("Worker 名称无效");
    if(typeof body.description!=="string"||description.length>1000)
      throw new Error("Worker 能力描述无效（最多 1000 字）");
    this.ctx.storage.sql.exec("UPDATE task_workers SET name=?,description=? WHERE id=?",
      name,description,w.id);
    connection.send(JSON.stringify({type:"worker_updated",worker_id:w.id}));
    this.broadcast(JSON.stringify({type:"workers",workers:this.publicWorkers()}));
  }
  private removeTaskWorker(connection:any,owner:HumanId,body:Record<string,unknown>) {
    if(typeof body.worker_id!=="string"||!/^worker_[a-f0-9]{32}$/.test(body.worker_id))
      throw new Error("Worker ID 无效");
    const sql=this.ctx.storage.sql;
    const w=sql.exec<{id:string;owner:string}>(
      "SELECT id,owner FROM task_workers WHERE id=?",body.worker_id).toArray()[0];
    if(!w||w.owner!==owner)throw new Error("只能删除自己的 Worker");
    const active=sql.exec<{n:number}>(
      "SELECT COUNT(*) AS n FROM tasks WHERE worker_id=? AND status IN ('pending','running')",
      w.id).one().n;
    if(active)throw new Error("此 Worker 仍有待处理或执行中的任务，请先完成或等待任务结束");
    // Historical Task rows and original results are preserved for audit.
    // Deleting the Worker invalidates its bearer token immediately.
    sql.exec("DELETE FROM task_workers WHERE id=?",w.id);
    connection.send(JSON.stringify({type:"worker_removed",worker_id:w.id}));
    this.broadcast(JSON.stringify({type:"workers",workers:this.publicWorkers()}));
  }
  private sendTaskDetail(connection:any,body:Record<string,unknown>) {
    if(typeof body.task_id!=="string"||!/^task_[a-f0-9]{32}$/.test(body.task_id))
      throw new Error("Task ID 无效");
    const task=this.ctx.storage.sql.exec<TaskRecord>(
      "SELECT * FROM tasks WHERE id=?",body.task_id).toArray()[0];
    if(!task)throw new Error("Task 不存在");
    const late=this.ctx.storage.sql.exec<{status:string;output:string;received_at:number}>(
      "SELECT status,output,received_at FROM task_late_results WHERE task_id=? ORDER BY received_at",
      task.id).toArray();
    const {claim_id:_claim,execution_config_snapshot:_snapshot,...visible}=task;
    let selected_config:ExecutionConfig|null=null;
    if(task.execution_config_snapshot){
      try{selected_config=parseExecutionConfigs([JSON.parse(task.execution_config_snapshot)])[0]}
      catch{/* old/malformed record: the stable ID is still available */}
    }
    connection.send(JSON.stringify({type:"task_detail",task:{...visible,selected_config},late_results:late}));
  }
  private async createHumanTask(connection:any,owner:HumanId,body:Record<string,unknown>) {
    if(typeof body.request_id!=="string"||!/^[a-f0-9-]{36}$/.test(body.request_id))
      throw new Error("任务请求 ID 无效");
    const result=await this.createTask(owner,null,body,body.request_id);
    connection.send(JSON.stringify({type:"task_create_ack",result}));
  }
  private async createTask(creator:string,sourceId:number|null,args:unknown,requestId:string|null=null):Promise<string> {
    const params=taskCreation(args);
    const sql=this.ctx.storage.sql;
    const previous=requestId
      ?sql.exec<{id:string}>("SELECT id FROM tasks WHERE client_request_id=?",requestId).toArray()[0]
      :sql.exec<{id:string}>(
        "SELECT id FROM tasks WHERE source_ai_id=? AND source_message_id=?",
        creator,sourceId).toArray()[0];
    if(previous)return `Task ${previous.id} 已经创建；本轮重试不会重复派发。`;
    const w=sql.exec<{id:string;enabled:number;name:string;execution_configs:string;default_config_id:string}>(
      "SELECT id,enabled,name,execution_configs,default_config_id FROM task_workers WHERE id=?",
      params.worker_id).toArray()[0];
    if(!w||!w.enabled)return "目标 Worker 不存在或已暂停。请先使用 list_workers。";
    const execution_config_id=params.execution_config_id??w.default_config_id;
    const available=savedExecutionConfigs(w.execution_configs);
    const selected=available.find(c=>c.id===execution_config_id);
    if(!selected)
      return `Worker ${w.name} 未公布配置 ${execution_config_id}；请先用 list_workers 查看可用配置。`;
    const n=sql.exec<{n:number}>(
      "SELECT COUNT(*) AS n FROM tasks WHERE creator=? AND status IN ('pending','running')",
      creator).one().n;
    if(n>=TASK_MAX_ACTIVE_PER_ROUTER)return "该 Router 已有太多运行中的任务，暂不能新建。";
    const now=Date.now(),deadline=now+TASK_DEADLINE_MS;
    const id="task_"+crypto.randomUUID().replace(/-/g,"");
    sql.exec("INSERT INTO tasks " +
      "(id,creator,worker_id,title,instructions,execution_config_id,execution_config_snapshot,"+
      "status,created_at,deadline_at,source_message_id,source_ai_id,client_request_id) " +
      "VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)",id,creator,params.worker_id,
      params.title,params.instructions,execution_config_id,JSON.stringify(selected),
      now,deadline,sourceId,creator,requestId);
    try {
      await this.schedule(new Date(deadline),"expireTask",{task_id:id});
    }catch(e){
      sql.exec("DELETE FROM tasks WHERE id=? AND status='pending'",id);
      throw e;
    }
    const task=sql.exec<TaskRecord>("SELECT * FROM tasks WHERE id=?",id).one();
    const msgId=this.taskEvent(task,"created");
    sql.exec("UPDATE tasks SET created_message_id=? WHERE id=?",msgId,id);
    return `已创建 Task ${id}，分配给 ${w.name}，配置 ${execution_config_id}。任务书已进入群聊，截止时间为 30 分钟后。`;
  }
  private async handleTaskTool(creator:string,sourceId:number,name:RouterTaskTool,args:Record<string,unknown>|null):Promise<string> {
    if(name==="list_workers"){
      const workers=this.publicWorkers().filter(w=>w.enabled);
      return workers.length?JSON.stringify(workers):"当前没有可用 Worker，请由真人先注册本机 Worker。";
    }
    if(name==="create_task")return this.createTask(creator,sourceId,args);
    if(!args || typeof args.task_id!=="string"||
      !/^task_[a-f0-9]{32}$/.test(args.task_id) ||
      !["instructions","result"].includes(String(args.field)))return "Task 读取参数无效";
    const task=this.ctx.storage.sql.exec<TaskRecord>(
      "SELECT * FROM tasks WHERE id=?",args.task_id).toArray()[0];
    if(!task)return "Task 不存在";
    const value=args.field==="instructions"?task.instructions:task.result;
    if(value===null)return `Task ${task.id} 当前状态 ${task.status}，没有结果。`;
    const offset=typeof args.offset==="number"&&Number.isSafeInteger(args.offset)&&args.offset>=0
      ?Math.min(args.offset,value.length):0;
    const limit=typeof args.limit==="number"&&Number.isSafeInteger(args.limit)
      ?Math.max(1,Math.min(6000,args.limit)):6000;
    return JSON.stringify({id:task.id,title:task.title,status:task.status,
      field:args.field,total:value.length,offset,next_offset:Math.min(value.length,offset+limit),
      text:value.slice(offset,offset+limit)});
  }
  /** HTTPS Worker API. A Worker receives only the Task it owns, no chat history. */
  async onRequest(request:Request):Promise<Response> {
    const answer=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,
      headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
    const url=new URL(request.url);
    if(!url.pathname.startsWith("/api/worker/")||request.method!=="POST")
      return answer({error:"not_found"},404);
    const token=request.headers.get("Authorization")?.replace(/^Bearer /i,"")??"";
    const match=/^(worker_[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
    if(!match)return answer({error:"unauthorized"},401);
    const hashed=await this.tokenHash(token);
    const w=this.ctx.storage.sql.exec<{
      id:string;enabled:number;execution_configs:string;default_config_id:string;
      catalog_session_id:string|null
    }>("SELECT id,enabled,execution_configs,default_config_id,catalog_session_id FROM task_workers " +
      "WHERE id=? AND token_hash=?",match[1],hashed).toArray()[0];
    if(!w||!w.enabled)return answer({error:"unauthorized"},401);
    if(Number(request.headers.get("content-length")||0)>1_200_000)
      return answer({error:"payload_too_large"},413);
    let body:Record<string,unknown>;
    try{
      const raw=await request.text();
      if(raw.length>300_000)return answer({error:"payload_too_large"},413);
      const parsed=raw?JSON.parse(raw):{};
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("bad body");
      body=parsed;
    }catch{return answer({error:"invalid_json"},400);}
    this.ctx.storage.sql.exec("UPDATE task_workers SET last_seen=? WHERE id=?",Date.now(),w.id);
    this.expireOverdueTasks();
    const sql=this.ctx.storage.sql;
    if(url.pathname==="/api/worker/configs"){
      let configs:ExecutionConfig[];
      try{configs=parseExecutionConfigs(body.configs)}catch{
        return answer({error:"invalid_execution_configs"},400);
      }
      const defaultId=body.default_config_id;
      if(!isExecutionConfigId(defaultId)||!configs.some(c=>c.id===defaultId))
        return answer({error:"invalid_default_config_id"},400);
      // A pending/running task must not silently change its model or effort.
      const oldConfigs=savedExecutionConfigs(w.execution_configs);
      const active=sql.exec<{execution_config_id:string|null}>(
        "SELECT execution_config_id FROM tasks WHERE worker_id=? " +
        "AND status IN ('pending','running')",w.id).toArray();
      const signature=(c:ExecutionConfig)=>JSON.stringify([c.harness,c.model,c.effort]);
      for(const task of active){
        const id=task.execution_config_id??w.default_config_id;
        const before=oldConfigs.find(c=>c.id===id);
        const after=configs.find(c=>c.id===id);
        if(!after || (before && signature(before)!==signature(after)))
          return answer({error:"active_task_config_changed",config_id:id},409);
      }
      // Session-bound claims prevent a stale pre-catalog Runner (or a
      // second process sharing the bearer) from ignoring the chosen model.
      const catalogSession=crypto.randomUUID();
      sql.exec("UPDATE task_workers SET execution_configs=?,default_config_id=?,catalog_session_id=? " +
        "WHERE id=?",JSON.stringify(configs),defaultId,catalogSession,w.id);
      this.broadcast(JSON.stringify({type:"workers",workers:this.publicWorkers()}));
      return answer({ok:true,default_config_id:defaultId,configs:configs.map(c=>c.id),
        catalog_session_id:catalogSession});
    }
    if(url.pathname==="/api/worker/claim"){
      // Old Runners can keep claiming legacy workers until the first
      // catalog advertisement; after that every claim needs this session.
      if(w.catalog_session_id && body.catalog_session_id!==w.catalog_session_id)
        return answer({error:"catalog_session_mismatch"},409);
      const busy=sql.exec<{id:string}>(
        "SELECT id FROM tasks WHERE worker_id=? AND status='running' LIMIT 1",w.id).toArray()[0];
      if(busy)return answer({task:null,busy:true});
      const permitted=new Set(savedExecutionConfigs(w.execution_configs).map(c=>c.id));
      const task=sql.exec<TaskRecord>(
        "SELECT * FROM tasks WHERE worker_id=? AND status='pending' " +
        "ORDER BY created_at LIMIT 100",w.id).toArray()
        .find(t=>t.execution_config_id===null||permitted.has(t.execution_config_id));
      if(!task)return answer({task:null,busy:false});
      const claim=crypto.randomUUID();
      sql.exec("UPDATE tasks SET status='running',claim_id=?,claimed_at=?,lease_until=? " +
        "WHERE id=? AND status='pending'",claim,Date.now(),Date.now()+TASK_LEASE_MS,task.id);
      return answer({task:{id:task.id,title:task.title,instructions:task.instructions,
        execution_config_id:task.execution_config_id,
        deadline_at:task.deadline_at,claim_id:claim}});
    }
    if(url.pathname==="/api/worker/heartbeat"){
      const task=sql.exec<TaskRecord>("SELECT * FROM tasks WHERE id=? AND worker_id=?",
        body.task_id??"",w.id).toArray()[0];
      if(!task||task.status!=="running"||task.claim_id!==body.claim_id)
        return answer({error:"claim_not_active"},409);
      sql.exec("UPDATE tasks SET lease_until=? WHERE id=? AND claim_id=? AND status='running'",
        Date.now()+TASK_LEASE_MS,task.id,task.claim_id);
      return answer({ok:true,deadline_at:task.deadline_at});
    }
    if(url.pathname==="/api/worker/complete"){
      let result:ReturnType<typeof taskResult>;
      try{result=taskResult(body);}catch{return answer({error:"invalid_result"},400);}
      const task=sql.exec<TaskRecord>("SELECT * FROM tasks WHERE id=? AND worker_id=?",
        result.task_id,w.id).toArray()[0];
      if(!task || task.claim_id!==result.claim_id)
        return answer({error:"invalid_claim"},403);
      if(task.status==="timed_out"){
        sql.exec("INSERT OR IGNORE INTO task_late_results(task_id,claim_id,received_at,status,output) " +
          "VALUES (?,?,?,?,?)",task.id,result.claim_id,Date.now(),result.status,result.output);
        const prior=sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM messages " +
          "WHERE kind='task_late' AND task_id=?",task.id).one().n;
        if(!prior)this.taskEvent(task,"late");
        return answer({ok:true,status:"timed_out",late:true});
      }
      if(task.status!=="running")return answer({error:"already_finished",status:task.status},409);
      // An authenticated Runner reports its effective model settings; the
      // Router cannot write these fields or change them in the task book.
      const model=typeof body.actual_model==="string" &&
        /^[a-zA-Z0-9_.:/-]{1,120}$/.test(body.actual_model)
        ?body.actual_model:null;
      const effort=typeof body.actual_effort==="string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(body.actual_effort)
        ?body.actual_effort:null;
      const now=Date.now();
      sql.exec("UPDATE tasks SET status=?,result_status=?,result=?,finished_at=?,"+
        "actual_model=?,actual_effort=? WHERE id=? AND status='running' AND claim_id=?",
        result.status,result.status,result.output,now,model,effort,task.id,result.claim_id);
      const updated={...task,status:result.status as TaskTerminal,
        result_status:result.status,result:result.output,finished_at:now,
        actual_model:model,actual_effort:effort};
      const msgId=this.taskEvent(updated,result.status);
      sql.exec("UPDATE tasks SET finished_message_id=? WHERE id=?",msgId,task.id);
      return answer({ok:true,status:result.status,task_id:task.id});
    }
    return answer({error:"not_found"},404);
  }

  private allAI(): AIRecord[] {
    return this.ctx.storage.sql.exec<AIRecord>(
      "SELECT * FROM ai_members ORDER BY created_at,id"
    ).toArray();
  }

  private members() {
    return [
      {id:"xiaochi",kind:"human",name:"小池"},
      {id:"xiaolai",kind:"human",name:"小赖"},
      ...this.allAI().map(publicAI)
    ];
  }

  private activity() {
    return this.ctx.storage.sql.exec<{
      id:number;ai_id:string;message_id:number;tool:string;input:string;
      ok:number;summary:string;duration_ms:number;created_at:number
    }>("SELECT * FROM tool_activity ORDER BY id DESC LIMIT 100")
      .toArray().reverse().map(x=>({...x,ok:!!x.ok}));
  }

  private usageSummary() {
    // Aggregate by member and model, without ever exposing prompts or keys.
    // SQL SUM remains null if the provider did not supply that metric.
    return this.ctx.storage.sql.exec<{
      ai_id:string; provider:string; model_id:string; requests:number; failures:number;
      prompt_tokens:number|null; completion_tokens:number|null; reasoning_tokens:number|null;
      cache_hit_tokens:number|null; cache_miss_tokens:number|null
    }>(
      "SELECT ai_id,provider,model_id,COUNT(*) AS requests," +
      "SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures," +
      "SUM(prompt_tokens) AS prompt_tokens," +
      "SUM(completion_tokens) AS completion_tokens," +
      "SUM(reasoning_tokens) AS reasoning_tokens," +
      "SUM(cache_hit_tokens) AS cache_hit_tokens," +
      "SUM(cache_miss_tokens) AS cache_miss_tokens " +
      "FROM model_usage WHERE created_at>=? " +
      "GROUP BY ai_id,provider,model_id ORDER BY ai_id,model_id",
      Date.now()-86400_000
    ).toArray();
  }

  private usageForDecision(aiId: string, triggerId: number) {
    // Sum every successful request made for a single AI decision.
    // Reasoning tokens are a subset of completion tokens, not additive.
    return this.ctx.storage.sql.exec<{
      requests:number; prompt_tokens:number|null; completion_tokens:number|null;
      reasoning_tokens:number|null; cache_hit_tokens:number|null; cache_miss_tokens:number|null
    }>(
      "SELECT COUNT(*) AS requests," +
      "SUM(prompt_tokens) AS prompt_tokens," +
      "SUM(completion_tokens) AS completion_tokens," +
      "SUM(reasoning_tokens) AS reasoning_tokens," +
      "SUM(cache_hit_tokens) AS cache_hit_tokens," +
      "SUM(cache_miss_tokens) AS cache_miss_tokens " +
      "FROM model_usage WHERE ai_id=? AND message_id=? AND success=1",
      aiId,triggerId
    ).one();
  }

  /** Summaries intentionally exclude raw reasoning, prompts, keys, and tool outputs. */
  private decisions() {
    return this.ctx.storage.sql.exec<{
      message_id:number; ai_id:string; ai_name:string; model_id:string|null;
      root_message_id:number|null; discussion_round:number;
      status:string; outcome:string|null; decision_method:string|null; run_order:number; created_at:number;
      started_at:number|null; finished_at:number|null;
      reply_message_id:number|null; error_code:string|null; error_detail:string|null;
      trigger_preview:string|null; reply_text:string|null; trigger_time:number|null;
      model_requests:number|null;prompt_tokens:number|null;completion_tokens:number|null;
      reasoning_tokens:number|null;cache_hit_tokens:number|null;cache_miss_tokens:number|null;
      first_request_ttft_ms:number|null
    }>(
      "SELECT j.message_id,j.ai_id,COALESCE(j.ai_name,a.name,'已移除的 AI') AS ai_name," +
      "j.model_id,j.root_message_id,j.discussion_round,"+
      "j.status,j.outcome,j.decision_method,j.run_order,j.created_at,j.started_at," +
      "j.finished_at,j.reply_message_id,j.error_code,j.error_detail," +
      "substr(m.content,1,120) AS trigger_preview," +
      "r.content AS reply_text,m.created_at AS trigger_time," +
      "u.model_requests,u.prompt_tokens,u.completion_tokens,u.reasoning_tokens," +
      "u.cache_hit_tokens,u.cache_miss_tokens,u.first_request_ttft_ms " +
      "FROM ai_jobs j LEFT JOIN ai_members a ON a.id=j.ai_id " +
      "LEFT JOIN messages m ON m.id=j.message_id " +
      "LEFT JOIN messages r ON r.id=j.reply_message_id " +
      "LEFT JOIN " + DECISION_USAGE_JOIN + " u ON u.message_id=j.message_id AND u.ai_id=j.ai_id " +
      "ORDER BY j.message_id DESC,j.run_order DESC LIMIT 150"
    ).toArray();
  }

  private decisionSummary(messageId:number,aiId:string) {
    return this.ctx.storage.sql.exec<{
      message_id:number;ai_id:string;ai_name:string;model_id:string|null;
      root_message_id:number|null;discussion_round:number;
      status:string;outcome:string|null;decision_method:string|null;run_order:number;created_at:number;
      started_at:number|null;finished_at:number|null;reply_message_id:number|null;
      error_code:string|null;error_detail:string|null;
      trigger_preview:string|null;reply_text:string|null;trigger_time:number|null;
      model_requests:number|null;prompt_tokens:number|null;completion_tokens:number|null;
      reasoning_tokens:number|null;cache_hit_tokens:number|null;cache_miss_tokens:number|null;
      first_request_ttft_ms:number|null
    }>(
      "SELECT j.message_id,j.ai_id,COALESCE(j.ai_name,a.name,'已移除的 AI') AS ai_name," +
      "j.model_id,j.root_message_id,j.discussion_round,"+
      "j.status,j.outcome,j.decision_method,j.run_order,j.created_at,j.started_at," +
      "j.finished_at,j.reply_message_id,j.error_code,j.error_detail," +
      "substr(m.content,1,120) AS trigger_preview," +
      "r.content AS reply_text,m.created_at AS trigger_time," +
      "u.model_requests,u.prompt_tokens,u.completion_tokens,u.reasoning_tokens," +
      "u.cache_hit_tokens,u.cache_miss_tokens,u.first_request_ttft_ms " +
      "FROM ai_jobs j LEFT JOIN ai_members a ON a.id=j.ai_id " +
      "LEFT JOIN messages m ON m.id=j.message_id " +
      "LEFT JOIN messages r ON r.id=j.reply_message_id " +
      "LEFT JOIN " + DECISION_USAGE_JOIN + " u ON u.message_id=j.message_id AND u.ai_id=j.ai_id " +
      "WHERE j.message_id=? AND j.ai_id=?",messageId,aiId
    ).toArray()[0];
  }

  private notifyDecision(messageId:number,aiId:string) {
    const decision=this.decisionSummary(messageId,aiId);
    if(decision)this.broadcast(JSON.stringify({type:"decision",decision}));
  }

  /**
   * Sort by observed model-generation latency, not queue wait. Use an
   * exponentially weighted average of up to six latest successful first
   * request TTFT samples. Unmeasured models participate normally, last.
   */
  private fastestAIOrder(members:AIRecord[]):AIRecord[] {
    const scores=new Map<string,number|null>();
    for(const ai of members) {
      const times=this.ctx.storage.sql.exec<{ttft_ms:number}>(
        "SELECT ttft_ms FROM model_usage WHERE ai_id=? AND model_id=? " +
        "AND model_round=1 AND success=1 AND ttft_ms IS NOT NULL " +
        "ORDER BY id DESC LIMIT 6",ai.id,ai.model_id
      ).toArray();
      scores.set(ai.id,estimateTTFT(times.map(item=>item.ttft_ms)));
    }
    return fastestFirst(members,ai=>scores.get(ai.id)??null);
  }

  /**
   * A wave only advances once *all* its AI decisions have finished.
   * Retain members who spoke, drop silence/failed/skipped members, and stop
   * if fewer than two remain. An intervening human turn supersedes all
   * autonomous continuation of this thread, but still starts its own wave 1.
   */
  private scheduleNextWave(messageId:number,aiId:string) {
    const sql=this.ctx.storage.sql;
    const job=sql.exec<{root_message_id:number|null;discussion_round:number}>(
      "SELECT root_message_id,discussion_round FROM ai_jobs WHERE message_id=? AND ai_id=?",
      messageId,aiId
    ).toArray()[0];
    if(!job || job.root_message_id===null ||
       job.discussion_round>=MAX_DISCUSSION_ROUNDS)return;
    const root=job.root_message_id,round=job.discussion_round;
    const wave=sql.exec<{
      ai_id:string;status:string;outcome:string|null;reply_message_id:number|null
    }>(
      "SELECT ai_id,status,outcome,reply_message_id FROM ai_jobs " +
      "WHERE root_message_id=? AND discussion_round=? ORDER BY run_order",
      root,round
    ).toArray();
    const latestInterrupt=sql.exec<{id:number|null}>(
      "SELECT MAX(id) AS id FROM messages " +
      "WHERE role IN ('xiaochi','xiaolai') OR kind='task_result'"
    ).one().id;
    const speakers=nextWaveSpeakers(wave,root,round,latestInterrupt);
    if(speakers.length<2)return;
    const participantIds=new Set(speakers.map(x=>x.ai_id));
    const candidates=this.allAI().filter(ai=>ai.enabled && participantIds.has(ai.id));
    if(candidates.length<2)return;
    const sourceId=Math.max(...speakers.map(x=>x.reply_message_id));
    const ordered=this.fastestAIOrder(candidates);
    const createdAt=Date.now();
    for(const [runOrder,ai] of ordered.entries()){
      sql.exec(
        "INSERT OR IGNORE INTO ai_jobs " +
        "(message_id,ai_id,status,created_at,run_order,ai_name,model_id," +
        "root_message_id,discussion_round) " +
        "VALUES (?,?,'pending',?,?,?,?,?,?)",
        sourceId,ai.id,createdAt,runOrder,ai.name,ai.model_id,root,round+1
      );
      this.notifyDecision(sourceId,ai.id);
    }
    // When scheduled from a member-management event outside drain(), start
    // processing immediately; if already draining, its existing loop picks
    // up these pending jobs on the next iteration.
    this.ctx.waitUntil(this.drain());
  }

  private completeDecision(
    messageId:number,aiId:string,outcome:DecisionOutcome,
    details:{replyMessageId?:number;errorCode?:string;errorDetail?:string;method?:string}={}
  ) {
    this.ctx.storage.sql.exec(
      "UPDATE ai_jobs SET status='done',outcome=?,finished_at=?," +
      "reply_message_id=?,error_code=?,error_detail=?,decision_method=? "+
      "WHERE message_id=? AND ai_id=?",
      outcome,Date.now(),details.replyMessageId??null,details.errorCode??null,
      details.errorDetail??null,details.method??null,messageId,aiId
    );
    this.notifyDecision(messageId,aiId);
    this.scheduleNextWave(messageId,aiId);
  }

  private sendDecisionDetail(connection:any,body:Record<string,unknown>) {
    const messageId=body.message_id,aiId=body.ai_id;
    if(!Number.isSafeInteger(messageId) || (messageId as number)<=0 ||
       typeof aiId!=="string" || !/^(?:ds|ai_[a-f0-9]{32})$/.test(aiId)) {
      throw new Error("无效的决策查询");
    }
    const row=this.ctx.storage.sql.exec<{
      reasoning:string|null;status:string;outcome:string|null
    }>(
      "SELECT reasoning,status,outcome FROM ai_jobs WHERE message_id=? AND ai_id=?",
      messageId,aiId
    ).toArray()[0];
    if(!row)throw new Error("决策记录不存在");
    const tools=this.ctx.storage.sql.exec<{
      tool:string;input:string;ok:number;summary:string;duration_ms:number;created_at:number
    }>(
      "SELECT tool,input,ok,summary,duration_ms,created_at FROM tool_activity " +
      "WHERE message_id=? AND ai_id=? ORDER BY id LIMIT 30",
      messageId,aiId
    ).toArray().map(x=>({...x,ok:!!x.ok}));
    const requests=this.ctx.storage.sql.exec<{
      model_id:string;model_round:number;http_status:number|null;success:number;
      ttft_ms:number|null;first_content_ms:number|null;finish_reason:string|null;
      prompt_tokens:number|null;completion_tokens:number|null;reasoning_tokens:number|null;
      cache_hit_tokens:number|null;cache_miss_tokens:number|null;
      duration_ms:number;created_at:number
    }>(
      "SELECT model_id,model_round,http_status,success,prompt_tokens," +
      "completion_tokens,reasoning_tokens,cache_hit_tokens,cache_miss_tokens," +
      "duration_ms,ttft_ms,first_content_ms,finish_reason,created_at FROM model_usage " +
      "WHERE message_id=? AND ai_id=? " +
      "ORDER BY id LIMIT 30",messageId,aiId
    ).toArray().map(x=>({...x,success:!!x.success}));
    connection.send(JSON.stringify({type:"decision_detail",message_id:messageId,ai_id:aiId,
      reasoning:row.reasoning,tools,requests}));
  }

  private serialize(row: Row) {
    let trace: ToolTrace[] = [];
    let usage: ReturnType<GroupRoom["usageForDecision"]> | null = null;
    try { const parsed=JSON.parse(row.trace || "[]");
      if(Array.isArray(parsed)) trace=parsed; } catch {}
    try { const parsed=JSON.parse(row.usage || "null");
      if(parsed && typeof parsed==="object" && !Array.isArray(parsed)) usage=parsed;
    } catch {}
    const {trace:_rawTrace,usage:_rawUsage,...safe}=row;
    return {...safe,trace,usage};
  }

  private history() {
    return this.ctx.storage.sql.exec<Row>(
      "SELECT id,role,content,created_at,reasoning,trace,usage,kind,task_id FROM messages ORDER BY id DESC LIMIT 150"
    ).toArray().reverse()
      .filter(m=>!(m.role==="ds" && isLiteralSilence(m.content)))
      .map(m=>this.serialize(m));
  }

  onConnect(connection: any, ctx: {request: Request}) {
    const member = ctx.request.headers.get("x-group-member");
    if (member !== "xiaochi" && member !== "xiaolai") {
      connection.close(1008,"Unauthorized"); return;
    }
    connection.setState({member} satisfies SessionState);
    connection.send(JSON.stringify({
      type:"hello",you:member,history:this.history(),members:this.members(),
      activity:this.activity(),usage:this.usageSummary(),
      decisions:this.decisions(),online:this.onlineNames(),workers:this.publicWorkers()
    }));
    this.broadcast(JSON.stringify({type:"presence",online:this.onlineNames()}));
  }

  onClose() {
    this.broadcast(JSON.stringify({type:"presence",online:this.onlineNames()}));
  }

  async onMessage(connection: any, raw: unknown) {
    const state = connection.state as SessionState | null;
    if (!state || (state.member!=="xiaochi" && state.member!=="xiaolai")) {
      connection.close(1008,"Unauthorized");return;
    }
    if(typeof raw!=="string" || raw.length>24000) {
      connection.send(JSON.stringify({type:"error",error:"请求过长"}));return;
    }
    let body: Record<string, unknown>;
    try {const v=JSON.parse(raw);
      if (!v||typeof v!=="object"||Array.isArray(v)) return; body=v;
    } catch {return;}
    try {
      switch(body.type) {
        case "say": this.say(connection,state.member,body); break;
        case "ai_save": await this.saveAI(state.member,body); break;
        case "ai_toggle": this.toggleAI(state.member,body); break;
        case "ai_remove": this.removeAI(state.member,body); break;
        case "decision_detail": this.sendDecisionDetail(connection,body); break;
        case "worker_register": await this.registerTaskWorker(connection,state.member,body); break;
        case "worker_disable": this.disableTaskWorker(state.member,body); break;
        case "worker_update": this.updateTaskWorker(connection,state.member,body); break;
        case "worker_remove": this.removeTaskWorker(connection,state.member,body); break;
        case "worker_list": connection.send(JSON.stringify({type:"worker_list",workers:this.publicWorkers()})); break;
        case "task_detail": this.sendTaskDetail(connection,body); break;
        case "task_create": await this.createHumanTask(connection,state.member,body); break;
        default: return;
      }
    } catch(e) {
      connection.send(JSON.stringify({type:"error",
        error:e instanceof Error ? e.message : "操作失败"}));
    }
  }

  private saveMembers() {
    this.broadcast(JSON.stringify({type:"members",members:this.members()}));
  }

  private memberEvent(content: string) {
    // Events are server-authored timeline entries, not human input.
    // Deliberately do NOT enqueue new AI jobs here.
    const now=Date.now();
    const sql=this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO messages(role,content,created_at) VALUES ('system',?,?)",
      content,now
    );
    const id=sql.exec<{id:number}>("SELECT last_insert_rowid() AS id").one().id;
    this.broadcast(JSON.stringify({type:"message",message:{
      id,role:"system",content,created_at:now,
      reasoning:null,trace:[],usage:null
    }}));
  }

  private humanName(id: HumanId) {
    return id==="xiaochi" ? "小池" : "小赖";
  }

  private async saveAI(owner: HumanId, body: Record<string,unknown>) {
    const id=typeof body.id==="string" ? body.id : "";
    const previous=id ? this.allAI().find(x=>x.id===id) : undefined;
    if(id && !previous) throw new Error("AI 不存在");
    if(previous && previous.owner!==owner) throw new Error("只能修改自己创建的 AI");
    const value=readAIInput(body.config,!!previous);
    let encrypted=previous?.encrypted_key ?? null;
    if(value.apiKey) encrypted=await encryptAPIKey(
      value.apiKey,this.env.AI_KEY_ENCRYPTION_SECRET
    );
    if (!encrypted && !(previous?.id==="ds" && value.provider==="deepseek"))
      throw new Error("请填写 API Key");
    let notice = "";
    if(previous) {
      this.ctx.storage.sql.exec(
        "UPDATE ai_members SET name=?,provider=?,model_id=?,persona=?,encrypted_key=? WHERE id=?",
        value.name,value.provider,value.model_id,value.persona,encrypted,id
      );
      const publicChanged = previous.name!==value.name ||
        previous.provider!==value.provider || previous.model_id!==value.model_id ||
        previous.persona!==value.persona;
      if(publicChanged) {
        notice=this.humanName(owner)+" 更新了 AI「"+value.name+"」的模型或人格配置";
      }
    } else {
      const total=this.ctx.storage.sql.exec<{n:number}>(
        "SELECT COUNT(*) AS n FROM ai_members WHERE owner=?",owner
      ).one().n;
      if(total>=MAX_AI_PER_HUMAN) throw new Error("每位真人最多创建 3 个 AI（包含 DS）");
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_members(id,owner,name,provider,model_id,persona,encrypted_key,enabled,created_at)" +
        " VALUES (?,?,?,?,?,?,?,1,?)",
        "ai_"+crypto.randomUUID().replace(/-/g,""),owner,
        value.name,value.provider,value.model_id,value.persona,encrypted,Date.now()
      );
      notice=this.humanName(owner)+" 添加了 AI「"+value.name+"」（"+
        value.provider+" / "+value.model_id+"）";
    }
    this.saveMembers();
    if(notice) this.memberEvent(notice);
  }

  private toggleAI(owner: HumanId, body:Record<string,unknown>) {
    const ai=this.allAI().find(x=>x.id===body.id);
    if(!ai || ai.owner!==owner) throw new Error("只能管理自己的 AI");
    if(typeof body.enabled!=="boolean") throw new Error("状态无效");
    if(Boolean(ai.enabled)===body.enabled) return;
    this.ctx.storage.sql.exec(
      "UPDATE ai_members SET enabled=? WHERE id=?",body.enabled?1:0,ai.id
    );
    this.saveMembers();
    this.memberEvent(this.humanName(owner)+(body.enabled?" 启用了":" 暂停了")+
      " AI「"+ai.name+"」");
  }

  private removeAI(owner: HumanId, body:Record<string,unknown>) {
    const ai=this.allAI().find(x=>x.id===body.id);
    if(!ai || ai.owner!==owner) throw new Error("只能移除自己的 AI");
    if(ai.id==="ds") throw new Error("内置 DS 不能删除，可以暂停");
    this.ctx.storage.sql.exec("DELETE FROM ai_members WHERE id=?",ai.id);
    const orphaned=this.ctx.storage.sql.exec<{message_id:number}>(
      "SELECT message_id FROM ai_jobs WHERE ai_id=? AND status='pending'",ai.id
    ).toArray();
    for(const job of orphaned) {
      this.completeDecision(job.message_id,ai.id,"skipped",{
        errorCode:"ai_removed",errorDetail:"AI 成员在执行前被移除"
      });
    }
    this.saveMembers();
    this.memberEvent(this.humanName(owner)+" 移除了 AI「"+ai.name+"」");
  }

  /** A human turn supersedes all queued work from older triggers, including
   * first-round AI decisions. Working calls are never cancelled or erased.
   */
  private supersedePendingJobs(newHumanMessageId:number) {
    const sql=this.ctx.storage.sql;
    const queued=sql.exec<{message_id:number;ai_id:string}>(
      "SELECT message_id,ai_id FROM ai_jobs WHERE status='pending' " +
      "AND COALESCE(root_message_id,message_id) < ?",newHumanMessageId
    ).toArray();
    if(!queued.length)return;
    sql.exec(
      "UPDATE ai_jobs SET status='done',outcome='skipped',finished_at=?," +
      "error_code='discussion_superseded'," +
      "error_detail='真人发送了更新的消息，尚未开始的旧任务取消' " +
      "WHERE status='pending' AND COALESCE(root_message_id,message_id) < ?",
      Date.now(),newHumanMessageId
    );
    for(const job of queued)this.notifyDecision(job.message_id,job.ai_id);
  }

  private say(connection:any, owner:HumanId, body:Record<string,unknown>) {
    const content=typeof body.text==="string"?body.text.trim():"";
    if(!content||content.length>MAX_CHAT_LENGTH)throw new Error("请输入 1–1200 字");
    const clientId=body.id;
    if(typeof clientId!=="string" || !/^[a-f0-9-]{36}$/.test(clientId))
      throw new Error("无效的消息 ID");
    const sql=this.ctx.storage.sql;
    if(sql.exec("SELECT id FROM messages WHERE role=? AND client_id=?",owner,clientId).toArray().length)
      return;
    const now=Date.now();
    const n=sql.exec<{n:number}>(
      "SELECT COUNT(*) AS n FROM messages WHERE role=? AND created_at>=?",
      owner,now-60000).one().n;
    if(n>=MAX_PER_MINUTE) throw new Error("每分钟最多发送 10 条消息");
    sql.exec(
      "INSERT INTO messages(role,content,created_at,client_id) VALUES (?,?,?,?)",
      owner,content,now,clientId
    );
    const id=sql.exec<{id:number}>("SELECT last_insert_rowid() AS id").one().id;
    // Human messages are preserved; stale queued AI decisions are not.
    // In-flight model calls finish normally, but no older pending work runs.
    this.supersedePendingJobs(id);
    // The new human message receives a fresh latency-prioritized first wave.
    const participants=this.fastestAIOrder(this.allAI().filter(x=>x.enabled));
    for(const [runOrder, ai] of participants.entries()) {
      sql.exec(
        "INSERT OR IGNORE INTO ai_jobs " +
        "(message_id,ai_id,status,created_at,run_order,ai_name,model_id," +
        "root_message_id,discussion_round) VALUES (?,?,'pending',?,?,?,?,?,?)",
        id,ai.id,now,runOrder,ai.name,ai.model_id,id,1
      );
    }
    for(const ai of participants)this.notifyDecision(id,ai.id);
    this.broadcast(JSON.stringify({type:"message",
      message:{id,role:owner,content,created_at:now,reasoning:null,trace:[],usage:null}}));
    this.ctx.waitUntil(this.drain());
  }

  private onlineNames(): HumanId[] {
    const names=new Set<HumanId>();
    for(const c of this.getConnections()) {
      const state=c.state as SessionState|null;
      if(state?.member==="xiaochi"||state?.member==="xiaolai")names.add(state.member);
    }
    return [...names];
  }

  private async drain() {
    if(this.#draining)return;
    this.#draining=true;
    try {
      for(;;) {
        const sql=this.ctx.storage.sql;
        const job=sql.exec<Job>(
          "SELECT message_id,ai_id,root_message_id,discussion_round " +
          "FROM ai_jobs WHERE status='pending' "+
          "ORDER BY message_id,run_order,ai_id LIMIT 1"
        ).toArray()[0];
        if(!job)break;
        // Also cover legacy and resumed jobs after a Durable Object restart.
        // Only pending jobs are selected here; once a call starts, its reply is kept.
        const newest=sql.exec<{id:number|null}>(
          "SELECT MAX(id) AS id FROM messages WHERE role IN ('xiaochi','xiaolai')"
        ).one().id;
        if(isJobSuperseded(job,newest)){
          this.completeDecision(job.message_id,job.ai_id,"skipped",{
            errorCode:"discussion_superseded",
            errorDetail:"真人已发送更新的消息，本次尚未开始的 AI 任务取消"
          });
          continue;
        }
        sql.exec("UPDATE ai_jobs SET status='working',started_at=? WHERE message_id=? AND ai_id=?",
          Date.now(),job.message_id,job.ai_id);
        this.notifyDecision(job.message_id,job.ai_id);
        const ai=this.allAI().find(x=>x.id===job.ai_id);
        if(!ai || !ai.enabled) {
          this.completeDecision(job.message_id,job.ai_id,"skipped",{
            errorCode:ai?"ai_paused":"ai_removed",
            errorDetail:ai?"AI 在轮到它时已暂停":"AI 在轮到它时已被移除"
          });
          continue;
        }
        const calls=sql.exec<{n:number}>(
          "SELECT COUNT(*) AS n FROM ai_calls WHERE created_at >= ?",Date.now()-86400000
        ).one().n;
        if(calls>=MAX_DAILY_AI_CALLS) {
          this.completeDecision(job.message_id,job.ai_id,"skipped",{
            errorCode:"daily_limit",errorDetail:"已达到群聊每日 AI 调用上限"
          });
          continue;
        }
        sql.exec("INSERT OR IGNORE INTO ai_calls(message_id,ai_id,created_at) VALUES (?,?,?)",
          job.message_id,job.ai_id,Date.now());
        const names:Record<string,string>={};
        for(const a of this.allAI())names[a.id]=a.name;
        try {
          const key=ai.encrypted_key ?
            await decryptAPIKey(ai.encrypted_key,this.env.AI_KEY_ENCRYPTION_SECRET) :
            ai.id==="ds"&&ai.provider==="deepseek" ? this.env.DEEPSEEK_API_KEY : "";
          if(!key) throw new Error("AI 凭据不可用");
          // See latest transcript, including earlier AI replies from this round.
          const context: GroupTurn[] = sql.exec<Row>(
            "SELECT id,role,content,created_at,reasoning,trace,usage,kind,task_id FROM messages " +
            "ORDER BY id DESC LIMIT 60"
          ).toArray().reverse()
            .filter(x=>!(x.role==="ds" && isLiteralSilence(x.content)))
            .map(x=>({id:x.id,role:x.role,content:x.content,created_at:x.created_at,
              reasoning:x.reasoning}));
          const decision=await modelWithTools({
            DEEPSEEK_BASE_URL:this.env.DEEPSEEK_BASE_URL,
            DEEPSEEK_MODEL:this.env.DEEPSEEK_MODEL,
            DEEPSEEK_API_KEY:this.env.DEEPSEEK_API_KEY,
            provider:ai.provider,modelId:ai.model_id,apiKey:key
          },buildGroupContext(context,{
            id:ai.id,name:ai.name,persona:ai.persona,
            provider:ai.provider,modelId:ai.model_id,owner:ai.owner
          },names,{
            now:Date.now(),
            discussionRound:job.root_message_id===null?undefined:job.discussion_round,
            maxDiscussionRounds:MAX_DISCUSSION_ROUNDS
          }),fetch,async(trace:ToolTrace)=>{
            sql.exec(
              "INSERT INTO tool_activity(ai_id,message_id,tool,input,ok,summary,duration_ms,created_at) "+
              "VALUES (?,?,?,?,?,?,?,?)",
              ai.id,job.message_id,trace.name,trace.input,trace.ok?1:0,
              trace.summary,trace.durationMs,trace.at
            );
            const tid=sql.exec<{id:number}>("SELECT last_insert_rowid() AS id").one().id;
            this.broadcast(JSON.stringify({type:"activity",activity:{
              id:tid,ai_id:ai.id,message_id:job.message_id,tool:trace.name,
              input:trace.input,ok:trace.ok,summary:trace.summary,
              duration_ms:trace.durationMs,created_at:trace.at
            }}));
          },async(usage: ModelUsage)=>{
            sql.exec(
              "INSERT INTO model_usage " +
              "(ai_id,message_id,provider,model_id,model_round,http_status,success," +
              "prompt_tokens,completion_tokens,reasoning_tokens,cache_hit_tokens," +
              "cache_miss_tokens,duration_ms,ttft_ms,first_content_ms,finish_reason,created_at) " +
              "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              ai.id,job.message_id,usage.provider,usage.modelId,usage.round,
              usage.httpStatus,usage.success?1:0,usage.promptTokens,
              usage.completionTokens,usage.reasoningTokens,usage.cacheHitTokens,
              usage.cacheMissTokens,usage.durationMs,usage.ttftMs,
              usage.firstContentMs,usage.finishReason,usage.at
            );
            this.broadcast(JSON.stringify({type:"usage",usage:this.usageSummary()}));
          },async(reasoning:string)=>{
            // Persist the actual provider-supplied reasoning even if the
            // eventual outcome is silence or a later protocol failure.
            sql.exec(
              "UPDATE ai_jobs SET reasoning=? WHERE message_id=? AND ai_id=?",
              reasoning,job.message_id,job.ai_id
            );
          },async(name,args)=>this.handleTaskTool(ai.id,job.message_id,name,args));
          if(decision.kind==="speak") {
            const now=Date.now();
            const usage=this.usageForDecision(ai.id,job.message_id);
            sql.exec(
              "INSERT INTO messages(role,content,created_at,reasoning,trace,usage) " +
              "VALUES (?,?,?,?,?,?)",ai.id,decision.text,now,
              decision.reasoning??null,JSON.stringify(decision.traces),JSON.stringify(usage)
            );
            const id=sql.exec<{id:number}>("SELECT last_insert_rowid() AS id").one().id;
            this.broadcast(JSON.stringify({type:"message",message:{
              id,role:ai.id,content:decision.text,created_at:now,
              reasoning:decision.reasoning??null,trace:decision.traces,usage
            }}));
            this.completeDecision(job.message_id,job.ai_id,"replied",
              {replyMessageId:id,method:"model_message"});
          } else {
            this.completeDecision(job.message_id,job.ai_id,"silence",
              {method:decision.via});
          }
        } catch(e) {
          const safe=safeAIError(e);
          console.error("AI turn failed",ai.id,safe.code);
          this.completeDecision(job.message_id,job.ai_id,"failed",{
            errorCode:safe.code,errorDetail:safe.detail
          });
          this.broadcast(JSON.stringify({type:"ai_error",id:ai.id,
            error:ai.name+" 本轮请求失败"}));
        } finally {
          // A completed job must never remain status=working with no outcome.
          // Preserve a specific outcome when already recorded above.
          sql.exec(
            "UPDATE ai_jobs SET status='done',outcome='failed',finished_at=?,"+
            "error_code='internal_error',error_detail='执行意外中断' "+
            "WHERE message_id=? AND ai_id=? AND status='working'",
            Date.now(),job.message_id,job.ai_id
          );
        }
      }
    } finally {this.#draining=false;}
  }
}
