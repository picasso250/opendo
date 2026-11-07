const $ = id => document.getElementById(id);
const el = {
  entry:$("entry"),room:$("room"),entryError:$("entry-error"),code:$("invite-code"),
  inviteForm:$("invite-form"),inviteButton:$("invite-button"),
  logout:$("logout"),status:$("connection"),light:$("status-light"),
  scroll:$("scroll"),timeline:$("timeline"),form:$("compose-form"),
  input:$("message-input"),send:$("send"),toast:$("toast"),
  memberList:$("member-list"),addAI:$("add-ai-button"),registerWorker:$("register-worker-button"),activityButton:$("activity-button"),
  aiDialog:$("ai-dialog"),aiForm:$("ai-form"),
  shell:$("shell"),activityView:$("activity-view"),
  closeActivity:$("close-activity"),decisionDetail:$("decision-detail-panel"),
  workerRegisterDialog:$("worker-register-dialog"),workerRegisterForm:$("worker-register-form"),
  workerRegisterName:$("worker-register-name"),workerRegisterDescription:$("worker-register-description"),
  workerRegisterClose:$("worker-register-close"),
  workerRegisterCancel:$("worker-register-cancel"),workerRegisterSubmit:$("worker-register-submit"),
  workerTokenDialog:$("worker-token-dialog"),workerTokenValue:$("worker-token-value"),
  workerTokenCopy:$("worker-token-copy"),workerTokenClose:$("worker-token-close"),
  workerEditDialog:$("worker-edit-dialog"),workerEditForm:$("worker-edit-form"),
  workerEditName:$("worker-edit-name"),workerEditDescription:$("worker-edit-description"),
  workerEditClose:$("worker-edit-close"),workerEditCancel:$("worker-edit-cancel"),
  workerEditSubmit:$("worker-edit-submit"),
  taskDialog:$("task-dialog"),taskDialogTitle:$("task-dialog-title"),
  taskDialogBody:$("task-dialog-body"),taskDialogClose:$("task-dialog-close"),
  activityList:$("activity-list"),usageStats:$("usage-stats"),
  decisionTabs:$("decision-tabs"),decisionList:$("decision-list"),subtitle:$("subtitle")
};
const NAMES = { xiaochi:"小池", xiaolai:"小赖", ds:"DS" };
let member = null, ws = null, reconnectAttempt = 0, reconnectTimer = null;
let manualClose = false, messages = new Set(), toastTimer = null;
let groupMembers=[], toolActivities=[], usageRows=[], onlineMembers=[], editingAI=null, savingAI=false;
let aiDecisions=[], debugAI="all", expandedDecision=null, decisionDetails=new Map();
let pendingDecisionDetails=new Set();
let workerRegistrationPending=false,workers=[],editingWorker=null,workerEditPending=false;
const DEFAULT_PERSONA = "你是群聊里的独立 AI 成员。你有自己的观点和好奇心，认真倾听其他人的讨论，需要时参与，也可以选择沉默。";

function toast(message) {
  el.toast.textContent=message;
  el.toast.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{el.toast.hidden=true;},5000);
}
function displayStatus(value, connected=false) {
  el.status.textContent=value;
  el.light.classList.toggle("connected",connected);
}
function showEntry(message="") {
  el.activityView.hidden=true;el.shell.hidden=false;
  el.entry.hidden=false;
  el.room.hidden=true;
  el.logout.hidden=true;
  el.addAI.hidden=true;el.registerWorker.hidden=true;el.activityButton.hidden=true;
  el.entryError.textContent=message;
  displayStatus("尚未连接");
}
function showRoom() {
  el.entry.hidden=true;
  el.room.hidden=false;
  el.logout.hidden=false;
  el.addAI.hidden=false;el.registerWorker.hidden=false;el.activityButton.hidden=false;
  el.subtitle.textContent = "小池 · 小赖 · AI　|　你是" + NAMES[member];
}
async function api(path,body) {
  const response=await fetch("/api/group/"+path,{
    method:body?"POST":"GET",headers:body?{"Content-Type":"application/json"}:{},
    body:body?JSON.stringify(body):undefined,credentials:"same-origin",cache:"no-store"
  });
  const json=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(json.error || "连接失败 ("+response.status+")");
  return json;
}
function extractInvite(value) {
  const trimmed=value.trim();
  if(/^[a-f0-9]{64}$/i.test(trimmed))return trimmed.toLowerCase();
  try {
    const url=new URL(trimmed);
    if(url.origin!==location.origin) return null;
    const raw=new URLSearchParams(url.hash.slice(1)).get("invite");
    return raw && /^[a-f0-9]{64}$/i.test(raw)?raw.toLowerCase():null;
  }catch{return null;}
}
async function join(code) {
  el.inviteButton.disabled=true;
  el.entryError.textContent="";
  try {
    const data=await api("auth",{code});
    member=data.member;
    showRoom();
    connect();
  }catch(e){showEntry(e.message);}
  finally{el.inviteButton.disabled=false;}
}
function autoSize() {
  el.input.style.height="auto";
  el.input.style.height=Math.min(150,el.input.scrollHeight)+"px";
  el.send.disabled=!el.input.value.trim() || ws?.readyState!==WebSocket.OPEN;
}
function atBottom(){return el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<140;}
function scrollToEnd(){el.scroll.scrollTop=el.scroll.scrollHeight;}
function memberName(id){
  return groupMembers.find(m=>m.id===id)?.name || NAMES[id] || "已移除的 AI";
}
function isAI(id){return id!=="xiaochi" && id!=="xiaolai";}
function disclosure(label,content,className){
  const details=document.createElement("details");
  details.className=className;
  const summary=document.createElement("summary");
  summary.textContent=label;
  const body=document.createElement("div");
  body.className=className+"-text";
  if(className==="tool-trace")window.MiniMarkdown.render(content,body);
  else body.textContent=content;
  details.append(summary,body);
  return details;
}
function traceLabel(trace){return trace.name==="web_search"?"search":"fetch_url";}
function messageUsage(usage){
  if(!usage||typeof usage!=="object")return null;
  const wrap=document.createElement("div");
  wrap.className="message-usage";
  const inp=usage.prompt_tokens,out=usage.completion_tokens;
  const valid=x=>Number.isSafeInteger(x)&&x>=0;
  const total=valid(inp)&&valid(out)?inp+out:null;
  const hit=usage.cache_hit_tokens,miss=usage.cache_miss_tokens;
  const rate=valid(hit)&&valid(miss)&&hit+miss>0
    ?Math.round(hit/(hit+miss)*100)+"%":"—";
  const val=x=>valid(x)?x.toLocaleString("zh-CN"):"—";
  wrap.textContent="Tokens "+val(total)+" · 缓存 "+rate;
  wrap.title="本次 AI 发言的 "+(usage.requests||0)+" 次模型请求汇总："+
    "输入 "+val(inp)+" / 输出 "+val(out)+
    "（其中推理 "+val(usage.reasoning_tokens)+"） · 命中 "+val(hit)+
    " / 未命中 "+val(miss)+"；未提供的指标显示为 —";
  return wrap;
}
function renderMessage(m) {
  if(!m || !Number.isInteger(m.id) || messages.has(m.id) ||
     typeof m.role!=="string" || typeof m.content!=="string")return;
  if(m.role==="ds" && /^(?:silence|沉默|不回复)[。.!！]*$/iu.test(m.content.trim()))return;
  messages.add(m.id);
  const bottom=atBottom();
  if(m.role==="system" && /^task_(?:create|result|late)$/.test(m.kind||"")){
    const card=document.createElement("article");
    card.className="task-card";
    const title=document.createElement("div");
    title.className="task-card-header";
    const label=m.kind==="task_create"?"任务创建":m.kind==="task_late"?"迟到结果":"任务结束";
    title.append(debugNode("strong","TASK · "+label),
      debugNode("small",new Date(m.created_at).toLocaleString("zh-CN")));
    const summary=debugNode("div",m.content.split("\n")[0],"task-card-summary");
    const view=debugNode("button","展开任务书与 Worker 原始输出","task-card-open");
    view.type="button";
    view.addEventListener("click",()=>{
      el.taskDialogTitle.textContent="Task "+(m.task_id||"");
      el.taskDialogBody.replaceChildren(debugNode("p","正在读取任务详情…"));
      if(!el.taskDialog.open)el.taskDialog.showModal();
      sendWS({type:"task_detail",task_id:m.task_id});
    });
    card.append(title,summary,view);el.timeline.append(card);
    if(bottom)scrollToEnd();
    return;
  }
  if(m.role==="system"){
    const notice=document.createElement("div");
    notice.className="system-event";
    notice.textContent=m.content;
    const date=new Date(m.created_at);
    if(Number.isFinite(date.getTime()))notice.title=
      date.toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",
        hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    el.timeline.append(notice);
    if(bottom)scrollToEnd();
    return;
  }
  const ai=isAI(m.role);
  const article=document.createElement("article");
  article.className="message "+(ai?"ds":m.role)+(m.role===member?" mine":"");
  const av=document.createElement("div");
  av.className="message-avatar "+(ai?"ds":m.role);
  av.textContent=ai?memberName(m.role).slice(0,2):m.role==="xiaochi"?"池":"赖";
  const wrap=document.createElement("div");
  wrap.className="message-content";
  const meta=document.createElement("div");
  meta.className="message-meta";
  const name=document.createElement("span");name.textContent=memberName(m.role);
  const time=document.createElement("time");
  const date=new Date(m.created_at);
  time.textContent=Number.isFinite(date.getTime())?
    date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}):"";
  time.title=Number.isFinite(date.getTime())?
    date.toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"";
  meta.append(name,time);wrap.append(meta);
  const traces=Array.isArray(m.trace)?m.trace:[];
  if(ai && traces.length){
    const text=traces.map(t=>
      traceLabel(t)+" · "+t.input+"\n"+
      (t.ok?"成功":"失败")+" · "+t.summary+" · "+t.durationMs+"ms").join("\n\n");
    wrap.append(disclosure("工具调用 "+traces.length+" 次",text,"tool-trace"));
  }
  if(ai && typeof m.reasoning==="string" && m.reasoning.trim())
    wrap.append(disclosure("查看思考过程",m.reasoning,"reasoning"));
  const bubble=document.createElement("div");
  bubble.className="bubble";window.MiniMarkdown.render(m.content,bubble);
  wrap.append(bubble);
  if(ai){
    const usage=messageUsage(m.usage);
    if(usage)wrap.append(usage);
  }
  article.append(av,wrap);
  el.timeline.append(article);
  if(bottom)scrollToEnd();
}
function updatePresence(online=[]){
  onlineMembers=Array.isArray(online)?online:[];
  renderMembers();
}
function memberMenu(label,items){
  const menu=document.createElement("details");menu.className="member-menu";
  const summary=document.createElement("summary");
  summary.textContent="···";summary.title=label;summary.setAttribute("aria-label",label);
  const content=document.createElement("div");content.className="member-menu-content";
  for(const item of items){
    const button=document.createElement("button");button.type="button";
    button.textContent=item.label;
    if(item.danger)button.className="danger";
    button.addEventListener("click",()=>{menu.open=false;item.action();});
    content.append(button);
  }
  menu.append(summary,content);
  return menu;
}
function memberGroup(label,items,render){
  const section=document.createElement("section");section.className="member-group";
  section.append(debugNode("h2",label,"member-group-title"));
  const list=document.createElement("div");list.className="member-group-list";
  for(const item of items)list.append(render(item));
  if(!items.length&&label==="Worker")list.append(debugNode("p","暂无 Worker","member-empty"));
  section.append(list);
  el.memberList.append(section);
}
function openWorkerEdit(worker){
  editingWorker=worker.id;workerEditPending=false;
  el.workerEditSubmit.disabled=false;
  el.workerEditName.value=worker.name;
  el.workerEditDescription.value=worker.description||"";
  if(!el.workerEditDialog.open)el.workerEditDialog.showModal();
  el.workerEditName.focus();
}
function renderMembers(){
  el.memberList.replaceChildren();
  function renderMember(m){
    const div=document.createElement("div");div.className="member";
    const icon=document.createElement("span");
    icon.className="portrait "+(m.kind==="ai"?"ai":m.id==="xiaochi"?"owner":"guest");
    icon.textContent=m.kind==="ai"?(m.name||"AI").slice(0,2):m.id==="xiaochi"?"池":"赖";
    const info=document.createElement("div");info.className="member-info";
    const title=document.createElement("b");title.textContent=m.name;
    const status=document.createElement("small");
    status.textContent=m.kind==="ai"?
      (m.enabled?m.provider+" · 已启用":m.provider+" · 已暂停") :
      onlineMembers.includes(m.id)?"在线":"离线";
    if(onlineMembers.includes(m.id))status.className="online";
    info.append(title,status);div.append(icon,info);
    if(m.kind==="ai" && m.owner===member){
      const controls=document.createElement("div");controls.className="member-controls";
      const toggle=document.createElement("button");toggle.type="button";
      toggle.textContent=m.enabled?"暂停":"启用";
      toggle.addEventListener("click",()=>sendWS({type:"ai_toggle",id:m.id,enabled:!m.enabled}));
      controls.append(toggle);
      const items=[{label:"编辑",action:()=>openAI(m)}];
      if(!m.builtin)items.push({label:"删除",danger:true,action:()=>{
        if(confirm("删除 AI「"+m.name+"」？它的旧发言仍留在群里。"))
          sendWS({type:"ai_remove",id:m.id});
      }});
      controls.append(memberMenu("管理 AI「"+m.name+"」",items));
      div.append(controls);
    }
    return div;
  }
  function renderWorker(w){
    const div=document.createElement("div");div.className="member worker-member";
    const icon=debugNode("span","W","portrait worker");
    const info=document.createElement("div");info.className="member-info";
    info.append(debugNode("b",w.name));
    const status=document.createElement("small");
    status.textContent=!w.enabled?"已暂停":w.online?"在线":"离线";
    if(w.enabled&&w.online)status.className="online";
    const configs=Array.isArray(w.execution_configs)?w.execution_configs:[];
    if(configs.length){
      status.textContent+=" · "+configs.length+" 种配置";
      status.title=configs.map(c=>c.label+(c.id===w.default_config_id?"（默认）":"")).join("、");
    }
    info.append(status);
    if(w.description){
      const desc=debugNode("small",w.description,"worker-description");
      desc.title=w.description;info.append(desc);
    }
    div.append(icon,info);
    if(w.owner===member){
      const controls=document.createElement("div");controls.className="member-controls";
      const toggle=document.createElement("button");toggle.type="button";
      toggle.textContent=w.enabled?"暂停":"启用";
      toggle.addEventListener("click",()=>sendWS({type:"worker_disable",worker_id:w.id,enabled:!w.enabled}));
      controls.append(toggle);
      controls.append(memberMenu("管理 Worker「"+w.name+"」",[
        {label:"编辑",action:()=>openWorkerEdit(w)},
        {label:"复制 ID",action:async()=>{
          try{await navigator.clipboard.writeText(w.id);toast("Worker ID 已复制");}
          catch{toast("复制失败，Worker ID："+w.id);}
        }},
        {label:"删除",danger:true,action:()=>{
          if(confirm("删除 Worker「"+w.name+"」？本机 Runner 的 Token 会立即失效，历史任务仍保留。"))
            sendWS({type:"worker_remove",worker_id:w.id});
        }}
      ]));
      div.append(controls);
    }
    return div;
  }
  memberGroup("人类",groupMembers.filter(m=>m.kind!=="ai"),renderMember);
  memberGroup("AI",groupMembers.filter(m=>m.kind==="ai"),renderMember);
  memberGroup("Worker",workers,renderWorker);
}
// Menus are native details elements, so they remain keyboard operable.
document.addEventListener("click",event=>{
  for(const menu of document.querySelectorAll(".member-menu[open]")){
    if(!menu.contains(event.target))menu.open=false;
  }
});
function debugKey(d){return d.ai_id+":"+d.message_id;}
function debugTime(ts){
  return Number.isSafeInteger(ts)&&ts>0
    ?new Date(ts).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
}
function debugNum(n){return Number.isSafeInteger(n)&&n>=0?n.toLocaleString("zh-CN"):"—";}
function debugNode(tag,text,css=""){
  const node=document.createElement(tag);
  node.textContent=text;
  if(css)node.className=css;
  return node;
}
function debugState(d){
  if(d.outcome==="replied")return ["已回复","replied"];
  if(d.outcome==="silence")return ["silence","silence"];
  if(d.outcome==="skipped")return ["已跳过","skipped"];
  if(d.outcome==="failed")return ["失败","failed"];
  if(d.status==="pending")return ["排队中","pending"];
  if(d.status==="working")return ["推理中","working"];
  return ["历史未知","unknown"];
}
function renderDecisionTabs(){
  el.decisionTabs.replaceChildren();
  const known=new Map();
  for(const ai of groupMembers.filter(x=>x.kind==="ai"))known.set(ai.id,ai.name);
  for(const d of aiDecisions)if(!known.has(d.ai_id))known.set(d.ai_id,d.ai_name||"已移除的 AI");
  if(debugAI!=="all"&&!known.has(debugAI))debugAI="all";
  for(const [id,name] of [["all","全部"],...known.entries()]){
    const button=debugNode("button",name,"decision-tab");
    button.type="button";
    button.setAttribute("role","tab");
    button.setAttribute("aria-selected",String(debugAI===id));
    button.addEventListener("click",()=>{
      debugAI=id;expandedDecision=null;
      renderDecisionTabs();renderDecisions();renderUsage();
    });
    el.decisionTabs.append(button);
  }
}
function updateDecision(row){
  if(!row||!Number.isSafeInteger(row.message_id)||typeof row.ai_id!=="string")return;
  const key=debugKey(row);
  aiDecisions=aiDecisions.filter(d=>debugKey(d)!==key);
  aiDecisions.unshift(row);
  aiDecisions.sort((a,b)=>b.message_id-a.message_id||b.run_order-a.run_order);
  aiDecisions=aiDecisions.slice(0,150);
  decisionDetails.delete(key);
  pendingDecisionDetails.delete(key);
  renderDecisionTabs();renderDecisions();
}
function debugSection(root,title,lines,open=false){
  const section=document.createElement("details");
  section.className="debug-section";
  section.open=open;
  section.append(debugNode("summary",title));
  for(const text of lines)section.append(debugNode("pre",text,"debug-raw"));
  root.append(section);
}
function renderDecisionDetail(d,root){
  const info=decisionDetails.get(debugKey(d));
  if(!info){
    root.append(debugNode("p","正在从服务器读取这一轮的实际记录…","form-hint"));
    return;
  }
  const reasoning=typeof info.reasoning==="string"&&info.reasoning.trim()
    ?info.reasoning:"模型没有返回可读取的推理文本。";
  debugSection(root,"实际推理内容",[reasoning],true);
  const requests=Array.isArray(info.requests)?info.requests:[];
  const calls=requests.map(r=>{
    const total=Number.isSafeInteger(r.prompt_tokens)&&Number.isSafeInteger(r.completion_tokens)
      ?r.prompt_tokens+r.completion_tokens:null;
    return "第 "+r.model_round+" 次 · "+r.model_id+
      " · HTTP "+(r.http_status??"—")+" · "+(r.success?"有效输出":"无效输出或请求失败")+
      " · "+r.duration_ms+"ms\n"+
      "TTFT "+debugNum(r.ttft_ms)+"ms / 首正文 "+debugNum(r.first_content_ms)+"ms"+
      " / 结束原因 "+(r.finish_reason||"未知")+"\n"+
      "输入 "+debugNum(r.prompt_tokens)+" / 输出 "+debugNum(r.completion_tokens)+
      " / 推理 "+debugNum(r.reasoning_tokens)+" / 合计 "+debugNum(total)+"\n"+
      "Cache Hit "+debugNum(r.cache_hit_tokens)+
      " / Miss "+debugNum(r.cache_miss_tokens);
  });
  debugSection(root,"模型请求 · "+requests.length+" 次",
    calls.length?calls:["未记录到模型请求（跳过或旧版任务）。"]);
  const tools=Array.isArray(info.tools)?info.tools:[];
  const traces=tools.map(t=>t.tool+" · "+(t.ok?"成功":"失败")+
    " · "+t.duration_ms+"ms\n"+t.input+"\n"+t.summary);
  debugSection(root,"联网工具 · "+tools.length+" 次",
    traces.length?traces:["没有调用联网工具；silence 工具不属于联网工具。"]);
}
/** The result of an AI decision is primary; its trigger is secondary. */
function decisionSpeech(d){
  if(d.outcome==="replied")return [d.reply_text||"已回复（旧记录缺少正文摘要）","reply"];
  if(d.outcome==="silence")return ["本轮选择沉默，没有发布群聊消息。","quiet"];
  if(d.outcome==="failed")return ["本轮请求失败，没有产生公开回复。","empty"];
  if(d.outcome==="skipped")return ["这轮任务在开始前被跳过。","empty"];
  if(d.status==="pending")return ["等待模型开始发言判断…","empty"];
  if(d.status==="working")return ["模型正在决定是否参与讨论…","empty"];
  return ["本轮没有可展示的公开回复。","empty"];
}
function debugTrigger(d){
  if(!d.trigger_preview)return null;
  const box=document.createElement("details");
  box.className="debug-trigger-details";
  box.append(debugNode("summary","查看触发消息"),
    debugNode("div",d.trigger_preview,"debug-trigger"));
  return box;
}
function renderSelectedDecision(d){
  const root=el.decisionDetail;
  root.replaceChildren();
  if(!d){
    root.append(debugNode("div","选择左侧的一条决策，查看实际推理与请求详情。","debug-empty"));
    return;
  }
  const title=debugNode("div","","debug-selected-head");
  const label=debugNode("div","","debug-selected-name");
  label.append(debugNode("small","DECISION #"+d.message_id),
    debugNode("h3",d.ai_name||memberName(d.ai_id)));
  const [state,kind]=debugState(d);
  title.append(label,debugNode("span",state,"decision-state "+kind));
  root.append(title);
  const [speech,speechKind]=decisionSpeech(d);
  const speechCard=debugNode("div","","debug-speech "+speechKind);
  speechCard.append(debugNode("small",speechKind==="reply"?"AI 公开回复":"本轮决策"),
    debugNode("p",speech));
  root.append(speechCard);
  const meta=debugNode("div","","debug-facts");
  const wait=Number.isSafeInteger(d.started_at)?Math.max(0,d.started_at-d.created_at)+"ms":"—";
  const duration=Number.isSafeInteger(d.finished_at)&&Number.isSafeInteger(d.started_at)
    ?Math.max(0,d.finished_at-d.started_at)+"ms":"—";
  for(const [key,value] of [
    ["模型",d.model_id||"未记录"],["触发时间",debugTime(d.trigger_time??d.created_at)],
    ["排队",wait],["执行",duration],
    ["讨论轮次",(d.discussion_round??1)+" / 3"],
    ["首 Token",Number.isSafeInteger(d.first_request_ttft_ms)?d.first_request_ttft_ms+"ms":"—"],
    ["执行顺序",String(d.run_order+1)],
    ["关联回复",d.reply_message_id?"#"+d.reply_message_id:"—"]
  ]){
    const card=debugNode("div","","debug-fact");
    card.append(debugNode("small",key),debugNode("span",value));
    meta.append(card);
  }
  root.append(meta);
  const trigger=debugTrigger(d);
  if(trigger)root.append(trigger);
  if(d.error_code)root.append(debugNode("p",
    d.error_code+" · "+(d.error_detail||"没有更多错误信息"),"debug-selected-error"));
  if(d.outcome==="silence")root.append(debugNode("p",
    d.decision_method==="silence_tool"?"通过 silence 工具决定不发言。":
    d.decision_method==="literal_text"?"模型输出 silence 文字（兼容处理）。":
    "未记录具体的沉默途径。","debug-selected-note"));
  const total=Number.isSafeInteger(d.prompt_tokens)&&Number.isSafeInteger(d.completion_tokens)
    ?d.prompt_tokens+d.completion_tokens:null;
  const h=d.cache_hit_tokens,m=d.cache_miss_tokens;
  const hit=Number.isSafeInteger(h)&&Number.isSafeInteger(m)&&h+m>0
    ?Math.round(100*h/(h+m))+"%":"—";
  const metrics=debugNode("div","","debug-metrics");
  for(const [key,value] of [["模型请求",String(d.model_requests??0)],
    ["Tokens",debugNum(total)],["缓存命中",hit]]){
    const metric=debugNode("div","","debug-metric");
    metric.append(debugNode("small",key),debugNode("strong",value));
    metrics.append(metric);
  }
  root.append(metrics);
  root.append(debugNode("h4","实际执行详情","debug-detail-heading"));
  const real=debugNode("div","","debug-detail-content");
  renderDecisionDetail(d,real);
  root.append(real);
  const key=debugKey(d);
  if(!el.activityView.hidden&&
     !decisionDetails.has(key)&&!pendingDecisionDetails.has(key)&&
     ws?.readyState===WebSocket.OPEN&&sendWS({
       type:"decision_detail",message_id:d.message_id,ai_id:d.ai_id
     }))pendingDecisionDetails.add(key);
}
function renderDecisions(){
  el.decisionList.replaceChildren();
  const rows=aiDecisions.filter(x=>debugAI==="all"||x.ai_id===debugAI);
  if(!rows.length){
    el.decisionList.append(debugNode("p","暂无决策记录。旧版聊天未必留有完整诊断。","form-hint"));
    renderSelectedDecision(null);
    return;
  }
  if(!rows.some(d=>debugKey(d)===expandedDecision))
    expandedDecision=debugKey(rows[0]);
  for(const d of rows){
    const item=document.createElement("article");
    item.className="decision-entry";
    if(expandedDecision===debugKey(d))item.classList.add("is-selected");
    const heading=debugNode("div","","decision-heading");
    heading.append(debugNode("b",(d.ai_name||memberName(d.ai_id))+
      " · 消息 #"+d.message_id+" · 顺序 "+(d.run_order+1)));
    const [text,kind]=debugState(d);
    heading.append(debugNode("span",text,"decision-state "+kind));
    item.append(heading);
    const wait=Number.isSafeInteger(d.started_at)
      ?Math.max(0,d.started_at-d.created_at)+"ms":"—";
    const duration=Number.isSafeInteger(d.finished_at)&&Number.isSafeInteger(d.started_at)
      ?Math.max(0,d.finished_at-d.started_at)+"ms":"—";
    item.append(debugNode("div",
      "第 "+(d.discussion_round??1)+"/3 轮 · "+debugTime(d.created_at)+
      " · 排队 "+wait+" · 执行 "+duration,"decision-meta"));
    const [speech,speechKind]=decisionSpeech(d);
    item.append(debugNode("p",speech,"decision-speech "+speechKind));
    if(d.error_code)item.append(debugNode("p",
      d.error_code+" · "+(d.error_detail||"未记录具体错误"),"decision-error"));
    if(d.outcome==="silence")item.append(debugNode("div",
      d.decision_method==="silence_tool"?"途径：silence 工具":
      d.decision_method==="literal_text"?"途径：模型输出 silence 文字（兼容处理）":
      "途径：旧记录未保存","decision-meta"));
    const total=Number.isSafeInteger(d.prompt_tokens)&&Number.isSafeInteger(d.completion_tokens)
      ?d.prompt_tokens+d.completion_tokens:null;
    const h=d.cache_hit_tokens,m=d.cache_miss_tokens;
    const rate=Number.isSafeInteger(h)&&Number.isSafeInteger(m)&&h+m>0
      ?Math.round(100*h/(h+m))+"%":"—";
    item.append(debugNode("div","请求 "+(d.model_requests??0)+
      " 次 · Tokens "+debugNum(total)+" · 缓存 "+rate,"decision-meta"));
    const key=debugKey(d);
    const button=debugNode("button",
      expandedDecision===key?"正在查看":"查看详情","decision-expand");
    button.type="button";
    button.setAttribute("aria-pressed",String(expandedDecision===key));
    button.addEventListener("click",()=>{
      expandedDecision=key;
      renderDecisions();
    });
    item.append(button);
    el.decisionList.append(item);
  }
  renderSelectedDecision(rows.find(d=>debugKey(d)===expandedDecision)||rows[0]);
}
function renderUsage(){
  el.usageStats.replaceChildren();
  const title=document.createElement("strong");
  title.textContent="模型用量 · 最近 24 小时";
  el.usageStats.append(title);
  const visibleUsage=usageRows.filter(u=>debugAI==="all"||u.ai_id===debugAI);
  if(!visibleUsage.length){
    const empty=document.createElement("p");
    empty.className="form-hint";
    empty.textContent="暂无模型调用记录。";
    el.usageStats.append(empty);
    return;
  }
  const num = value => Number.isSafeInteger(value) ? value.toLocaleString("zh-CN") : "—";
  for(const u of visibleUsage){
    const item=document.createElement("div");
    item.className="usage-item";
    const name=document.createElement("b");
    name.textContent=memberName(u.ai_id)+" · "+u.model_id;
    const hit=u.cache_hit_tokens,miss=u.cache_miss_tokens;
    const rate=Number.isSafeInteger(hit)&&Number.isSafeInteger(miss)&&hit+miss>0
      ? Math.round(hit/(hit+miss)*100)+"%" : "—";
    const numbers=document.createElement("small");
    numbers.textContent="请求 "+u.requests+" 次（失败 "+u.failures+"）"+
      " · 输入 "+num(u.prompt_tokens)+" · 输出 "+num(u.completion_tokens)+
      " · 推理 "+num(u.reasoning_tokens)+
      " · 缓存命中 "+num(hit)+" / 未命中 "+num(miss)+"（"+rate+"）";
    item.append(name,numbers);el.usageStats.append(item);
  }
}
function renderActivity(){
  el.activityList.replaceChildren();
  if(!toolActivities.length){
    const empty=document.createElement("p");
    empty.className="form-hint";empty.textContent="暂时没有搜索或网页抓取记录。";
    el.activityList.append(empty);return;
  }
  for(const a of [...toolActivities].reverse()){
    const item=document.createElement("div");item.className="activity-entry";
    const label=document.createElement("b");
    label.textContent=memberName(a.ai_id)+" · "+(a.tool==="web_search"?"search":"fetch_url")+
      " · "+(a.ok?"成功":"失败");
    const detail=document.createElement("div");detail.className="activity-desc";
    detail.textContent=(a.input||"")+"\n"+(a.summary||"")+
      " · "+a.duration_ms+"ms";
    item.append(label,detail);el.activityList.append(item);
  }
}
function openAI(ai){
  editingAI=ai?.id||null;savingAI=false;
  $("ai-dialog-title").textContent=ai?"编辑 "+ai.name:"添加 AI 成员";
  $("ai-name").value=ai?.name||"豆包";
  $("ai-provider").value=ai?.provider||"volcengine";
  $("ai-model").value=ai?.modelId||"";
  $("ai-key").value="";
  $("ai-persona").value=ai?.persona||DEFAULT_PERSONA;
  $("key-hint").textContent=ai?.hasKey?
    "密钥已保存，留空则继续使用原有密钥；不会回显。":
    "填写自己的 API Key。内置 DS 可以继续使用系统原有密钥。";
  el.aiDialog.showModal();
}
function sendWS(data){
  if(!ws||ws.readyState!==WebSocket.OPEN){toast("尚未连接，请稍后再试");return false;}
  ws.send(JSON.stringify(data));return true;
}
function handleEvent(e) {
  let data;
  try{data=JSON.parse(e.data);}catch{return;}
  if(data.type==="hello"){
    reconnectAttempt=0;
    messages=new Set();
    el.timeline.querySelectorAll(".message, .system-event").forEach(node=>node.remove());
    groupMembers=Array.isArray(data.members)?data.members:[];
    workers=Array.isArray(data.workers)?data.workers:[];
    toolActivities=Array.isArray(data.activity)?data.activity:[];
    usageRows=Array.isArray(data.usage)?data.usage:[];
    aiDecisions=Array.isArray(data.decisions)?data.decisions:[];
    decisionDetails.clear();pendingDecisionDetails.clear();expandedDecision=null;
    renderDecisionTabs();renderDecisions();renderUsage();
    for(const m of data.history||[])renderMessage(m);
    updatePresence(data.online||[]);
    renderActivity();
    scrollToEnd();
  }else if(data.type==="message"){
    renderMessage(data.message);
  }else if(data.type==="presence"){
    updatePresence(data.online||[]);
  }else if(data.type==="members"){
    groupMembers=Array.isArray(data.members)?data.members:[];
    renderMembers();renderDecisionTabs();renderDecisions();
    if(savingAI){savingAI=false;el.aiDialog.close();toast("AI 配置已保存");}
  }else if(data.type==="usage"){
    usageRows=Array.isArray(data.usage)?data.usage:[];
    renderUsage();
  }else if(data.type==="decision"){
    updateDecision(data.decision);
  }else if(data.type==="workers"||data.type==="worker_list"){
    workers=Array.isArray(data.workers)?data.workers:[];
    renderMembers();
  }else if(data.type==="worker_updated"){
    workerEditPending=false;
    el.workerEditSubmit.disabled=false;
    editingWorker=null;
    if(el.workerEditDialog.open)el.workerEditDialog.close();
    toast("Worker 信息已保存");
  }else if(data.type==="worker_removed"){
    toast("Worker 已删除，原 Token 失效");
  }else if(data.type==="worker_registered"){
    // No persistent browser storage; credential is visible in this dialog once.
    workerRegistrationPending=false;
    el.workerRegisterSubmit.disabled=false;
    if(el.workerRegisterDialog.open)el.workerRegisterDialog.close();
    el.workerTokenValue.value=data.token;
    if(!el.workerTokenDialog.open)el.workerTokenDialog.showModal();
  }else if(data.type==="task_detail"){
    if(!el.taskDialog.open)return;
    const task=data.task;
    if(!task)return;
    el.taskDialogTitle.textContent=task.title+" · "+task.id;
    el.taskDialogBody.replaceChildren();
    const selected=task.selected_config||null;
    const fields=[["状态",task.status],["负责 Worker",task.worker_id],
      ["执行配置",selected?.label||task.execution_config_id||"旧任务 · 本机默认"],
      ["执行配置 ID",task.execution_config_id||"未指定"],
      ["Harness",selected?.harness||"未声明"],
      ["请求模型",selected?.model||"由本机执行器决定"],
      ["请求思考等级",selected?.effort||"由本机执行器决定"],
      ["Worker 报告模型",task.actual_model||"未指定 / 继承本机设置"],
      ["Worker 报告思考等级",task.actual_effort||"未指定 / 继承本机设置"],
      ["任务书（原文）",task.instructions],
      ["Worker 原始输出",task.result===null?"（尚未提交）":task.result]];
    for(const [name,value] of fields){
      const section=debugNode("section","","task-dialog-section");
      section.append(debugNode("h3",name),debugNode("pre",String(value)));
      el.taskDialogBody.append(section);
    }
    for(const late of data.late_results||[]){
      const section=debugNode("section","","task-dialog-section");
      section.append(debugNode("h3","迟到结果（"+late.status+"）"),
        debugNode("pre",late.output));
      el.taskDialogBody.append(section);
    }
  }else if(data.type==="decision_detail"){
    const key=String(data.ai_id)+":"+String(data.message_id);
    pendingDecisionDetails.delete(key);
    decisionDetails.set(key,data);
    if(expandedDecision===key)renderDecisions();
  }else if(data.type==="activity"){
    if(data.activity && !toolActivities.some(x=>x.id===data.activity.id)){
      toolActivities.push(data.activity);
      toolActivities=toolActivities.slice(-100);
      renderActivity();
    }
  }else if(data.type==="error"){
    savingAI=false;
    if(workerRegistrationPending){
      workerRegistrationPending=false;
      el.workerRegisterSubmit.disabled=false;
    }
    if(workerEditPending){
      workerEditPending=false;
      el.workerEditSubmit.disabled=false;
    }
    toast(data.error||"操作失败");
  }else if(data.type==="ai_error"){
    toast(data.error||"AI 暂时无法连接");
  }
}
function connect(){
  if(!member)return;
  manualClose=false;
  if(ws && [WebSocket.CONNECTING,WebSocket.OPEN].includes(ws.readyState))return;
  displayStatus("正在连接…");
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(protocol+"//"+location.host+"/api/group/ws");
  ws=socket;
  socket.addEventListener("open",()=>{
    if(ws!==socket)return;
    reconnectAttempt=0;displayStatus("已连接",true);
    autoSize();
  });
  socket.addEventListener("message",handleEvent);
  socket.addEventListener("close",event=>{
    if(ws!==socket)return;
    ws=null;displayStatus("连接中断");
    if(workerRegistrationPending){
      workerRegistrationPending=false;
      el.workerRegisterSubmit.disabled=false;
      toast("连接已中断，Worker 注册状态未确认，请重新连接后查看。");
    }
    workerEditPending=false;
    el.workerEditSubmit.disabled=false;
    autoSize();
    if(manualClose)return;
    if([1008,4401].includes(event.code)){
      showEntry("会话已失效，请重新使用邀请链接进入");return;
    }
    const delay=Math.min(15000,1000*2**Math.min(reconnectAttempt++,4));
    clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(connect,delay);
  });
  socket.addEventListener("error",()=>{if(ws===socket)displayStatus("网络连接异常");});
}
function send(){
  const content=el.input.value.trim();
  if(!content || content.length>1200)return;
  if(!ws || ws.readyState!==WebSocket.OPEN){toast("连接未就绪，请稍后再试");return;}
  const id=crypto.randomUUID();
  try{
    ws.send(JSON.stringify({type:"say",id,text:content}));
    el.input.value="";autoSize();
  }catch{toast("发送失败，请重试");}
}
el.addAI.addEventListener("click",()=>openAI(null));
function openActivityWorkspace(){
  el.shell.hidden=true;el.activityView.hidden=false;
  renderDecisionTabs();renderDecisions();renderUsage();renderActivity();
  el.closeActivity.focus();
}
function closeActivityWorkspace(){
  el.activityView.hidden=true;el.shell.hidden=false;
  if(!el.activityButton.hidden)el.activityButton.focus();
}
el.activityButton.addEventListener("click",openActivityWorkspace);
$("close-ai").addEventListener("click",()=>el.aiDialog.close());
el.taskDialogClose.addEventListener("click",()=>el.taskDialog.close());
el.workerEditClose.addEventListener("click",()=>el.workerEditDialog.close());
el.workerEditCancel.addEventListener("click",()=>el.workerEditDialog.close());
el.workerEditForm.addEventListener("submit",event=>{
  event.preventDefault();
  if(workerEditPending||!editingWorker)return;
  const name=el.workerEditName.value.trim();
  const description=el.workerEditDescription.value.trim();
  if(!name||name.length>64||description.length>1000){toast("Worker 名称或描述无效");return;}
  if(sendWS({type:"worker_update",worker_id:editingWorker,name,description})){
    workerEditPending=true;el.workerEditSubmit.disabled=true;
  }
});
// Online status is time-based. Refresh on a timer without reloading the page.
setInterval(()=>{
  if(ws?.readyState===WebSocket.OPEN&&workers.length)sendWS({type:"worker_list"});
},60_000);
el.workerTokenClose.addEventListener("click",()=>el.workerTokenDialog.close());
el.workerTokenDialog.addEventListener("close",()=>{el.workerTokenValue.value=""});
el.workerTokenCopy.addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText(el.workerTokenValue.value);toast("已复制 Worker 密钥");}
  catch{el.workerTokenValue.select();toast("请手动复制已选中的密钥");}
});
el.registerWorker.addEventListener("click",()=>{
  el.workerRegisterName.value="";
  el.workerRegisterDescription.value="";
  if(!el.workerRegisterDialog.open)el.workerRegisterDialog.showModal();
  el.workerRegisterName.focus();
});
const closeWorkerRegister=()=>el.workerRegisterDialog.close();
el.workerRegisterClose.addEventListener("click",closeWorkerRegister);
el.workerRegisterCancel.addEventListener("click",closeWorkerRegister);
el.workerRegisterForm.addEventListener("submit",event=>{
  event.preventDefault();
  if(workerRegistrationPending)return;
  const name=el.workerRegisterName.value.trim();
  const description=el.workerRegisterDescription.value.trim();
  if(!name||name.length>64){toast("请输入 1～64 字的 Worker 名称");return;}
  if(description.length>1000){toast("Worker 能力描述不能超过 1000 字");return;}
  if(sendWS({type:"worker_register",name,description})){
    workerRegistrationPending=true;
    el.workerRegisterSubmit.disabled=true;
  }
});
$("cancel-ai").addEventListener("click",()=>el.aiDialog.close());
el.closeActivity.addEventListener("click",closeActivityWorkspace);
window.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&!el.activityView.hidden&&!el.aiDialog.open){
    e.preventDefault();closeActivityWorkspace();
  }
});
el.aiForm.addEventListener("submit",e=>{
  e.preventDefault();
  const config={
    name:$("ai-name").value.trim(),
    provider:$("ai-provider").value,
    modelId:$("ai-model").value.trim(),
    apiKey:$("ai-key").value.trim(),
    persona:$("ai-persona").value.trim()
  };
  if(!config.name||!config.modelId||!config.persona){
    toast("请填写名称、模型 ID 和人格文字");return;
  }
  if(!editingAI && !config.apiKey){
    toast("添加 AI 必须填写 API Key");return;
  }
  savingAI=sendWS({type:"ai_save",id:editingAI||undefined,config});
  $("ai-key").value=""; // Avoid retaining a submitted secret in the DOM.
});
el.form.addEventListener("submit",e=>{e.preventDefault();send();});
el.input.addEventListener("input",autoSize);
el.input.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}
});
el.inviteForm.addEventListener("submit",e=>{
  e.preventDefault();
  const code=extractInvite(el.code.value);
  if(!code){el.entryError.textContent="请输入有效的专属邀请码或邀请链接";return;}
  join(code);
});
el.logout.addEventListener("click",async()=>{
  manualClose=true;clearTimeout(reconnectTimer);ws?.close();ws=null;
  member=null;messages.clear();groupMembers=[];workers=[];toolActivities=[];usageRows=[];
  aiDecisions=[];debugAI="all";expandedDecision=null;decisionDetails.clear();
  pendingDecisionDetails.clear();
  el.timeline.querySelectorAll(".message, .system-event").forEach(n=>n.remove());
  updatePresence();renderActivity();renderUsage();renderDecisionTabs();renderDecisions();
  try{await api("logout",{});}catch{}
  showEntry();
});
window.addEventListener("beforeunload",()=>{manualClose=true;clearTimeout(reconnectTimer);});
async function init(){
  const hash=new URLSearchParams(location.hash.slice(1)).get("invite");
  if(hash){
    history.replaceState(null,"",location.pathname+location.search);
    const code=extractInvite(hash);
    if(code){join(code);return;}
    showEntry("邀请链接格式不正确");return;
  }
  try{
    const session=await api("me");
    member=session.member;
    showRoom();connect();
  }catch{showEntry();}
}
showEntry();autoSize();init();
