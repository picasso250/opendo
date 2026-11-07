import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {modelWithTools,safeUpstreamDiagnostic} from "../src/toolloop.ts";
import {safeAIError} from "../src/group/observability.ts";

const env = {
  DEEPSEEK_BASE_URL:"https://api.deepseek.com",DEEPSEEK_API_KEY:"test-secret",
  DEEPSEEK_MODEL:"deepseek-flash"
};
const prompt=[{role:"user",content:"[小池] 嗨"}];

test("silence tool preserves actual returned reasoning without broadcasting a chat message",async()=>{
  const snapshots=[];
  const mock=async()=>Response.json({choices:[{message:{
    content:null,reasoning_content:"The others are talking; I should not interrupt.",
    tool_calls:[{id:"tool-1",type:"function",function:{name:"silence",arguments:"{}"}}]
  }}],usage:{prompt_tokens:130,completion_tokens:37}});
  const result=await modelWithTools(env,prompt,mock,undefined,undefined,
    async reasoning=>snapshots.push(reasoning));
  assert.equal(result.kind,"silence");
  assert.equal(result.via,"silence_tool");
  assert.match(result.reasoning,/should not interrupt/);
  assert.deepEqual(snapshots,[result.reasoning]);
  assert.equal(result.traces.length,0);
});

test("multiple tool rounds persist chronological reasoning even if last round fails",async()=>{
  const snapshots=[];
  let count=0;
  const mock=async(url,options)=>{
    if(String(url).endsWith("/v1/tools/search"))
      return Response.json({results:[{title:"OK",url:"https://example.com",summary:"ok"}]});
    count++;
    if(count===1)return Response.json({choices:[{message:{
      content:null,reasoning_content:"I will check a source.",
      tool_calls:[{id:"one",type:"function",function:{name:"web_search",arguments:'{"query":"test"}'}}]
    }}]});
    return Response.json({choices:[{message:{
      content:"",reasoning_content:"The evidence is insufficient."
    }}]});
  };
  await assert.rejects(modelWithTools(env,prompt,mock,undefined,undefined,
    async r=>snapshots.push(r)),/empty model answer/);
  assert.equal(snapshots.length,2);
  assert.match(snapshots[1],/I will check a source/);
  assert.match(snapshots[1],/The evidence is insufficient/);
});

test("diagnostic errors have safe machine-readable categories, never echo secrets",()=>{
  assert.deepEqual(safeAIError(new Error("deepseek HTTP 429")),
    {code:"upstream_http_429",detail:"模型服务商返回 HTTP 429"});
  assert.deepEqual(safeAIError(new Error("volcengine HTTP 400")),
    {code:"upstream_http_400",detail:"模型服务商返回 HTTP 400"});
  assert.equal(safeAIError(new Error("model tool loop exceeded")).code,"model_protocol");
  assert.equal(safeAIError(new Error("AI 凭据不可用")).code,"credential_error");
  const timeout=new Error("request exceeded");timeout.name="TimeoutError";
  assert.equal(safeAIError(timeout).code,"timeout");
  assert.equal(safeAIError(new SyntaxError("bad JSON")).code,"response_parse");
  const apiKey="sk-private-SECRET-should-not-leak";
  const result=safeAIError(new Error("Unexpected upstream response "+apiKey));
  assert.equal(result.code,"request_error");
  assert.ok(!JSON.stringify(result).includes(apiKey));
});

test("structured upstream 400 records safe parameter hints, never raw provider text",async()=>{
  const secret="sk-private-do-not-show";
  const error={error:{type:"invalid_request_error",param:"messages[4].reasoning_content",
    message:"missing reasoning_content; prompt="+secret}};
  assert.equal(safeUpstreamDiagnostic(error),
    "param:messages[4].reasoning_content / type:invalid_request_error");
  const rejected=async()=>Response.json(error,{status:400});
  await assert.rejects(modelWithTools(env,prompt,rejected),e=>{
    const safe=safeAIError(e);
    assert.equal(safe.code,"upstream_http_400");
    assert.match(safe.detail,/messages\[4\]\.reasoning_content/);
    assert.ok(!JSON.stringify(safe).includes(secret));
    assert.ok(!String(e).includes(secret));
    return true;
  });
  assert.equal(safeUpstreamDiagnostic({error:{message:secret}}),null);
});

test("debug decisions show each AI's own speech before collapsible triggering context",()=>{
  const server=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  const js=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.equal((server.match(/AS reply_text/g)||[]).length,2);
  assert.equal((server.match(/LEFT JOIN messages r ON r.id=j.reply_message_id/g)||[]).length,2);
  assert.match(js,/function decisionSpeech\(d\)/);
  assert.match(js,/d\.reply_text/);
  assert.match(js,/decision-speech/);
  assert.match(js,/debug-speech/);
  assert.match(js,/box\.className="debug-trigger-details"/);
  assert.doesNotMatch(js,/item\.append\(debugNode\("p","触发："/);
});

test("Room tracks one terminal decision outcome and migrates previous jobs additively",()=>{
  const src=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  assert.match(src,/ALTER TABLE ai_jobs ADD COLUMN/);
  assert.match(src,/ALTER TABLE messages ADD COLUMN usage TEXT/);
  assert.match(src,/outcome:"TEXT"/);
  assert.match(src,/decision_method:"TEXT"/);
  assert.match(src,/started_at:"INTEGER"/);
  assert.match(src,/finished_at:"INTEGER"/);
  assert.match(src,/reply_message_id:"INTEGER"/);
  assert.match(src,/this\.completeDecision\(job\.message_id,job\.ai_id,"silence",/);
  assert.match(src,/this\.completeDecision\(job\.message_id,job\.ai_id,"replied"/);
  assert.match(src,/this\.completeDecision\(job\.message_id,job\.ai_id,"failed"/);
  assert.match(src,/ALTER TABLE model_usage ADD COLUMN finish_reason TEXT/);
  assert.match(src,/usage.finishReason/);
  const browser=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(browser,/结束原因/);
  assert.match(src,/errorCode:"daily_limit"/);
  assert.match(src,/errorCode:ai\?"ai_paused":"ai_removed"/);
  assert.match(src,/WHERE message_id=\? AND ai_id=\?/);
});

test("Private authenticated websocket returns summaries and on-demand details, without raw keys",()=>{
  const src=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  assert.match(src,/case "decision_detail": this\.sendDecisionDetail\(connection,body\)/);
  assert.match(src,/decisions:this\.decisions\(\)/);
  assert.match(src,/this\.broadcast\(JSON\.stringify\(\{type:"decision",decision\}\)\)/);
  assert.match(src,/type:"decision_detail"/);
  assert.match(src,/SELECT reasoning,status,outcome FROM ai_jobs/);
  assert.match(src,/FROM model_usage/);
  assert.match(src,/WHERE message_id=\? AND ai_id=\?/);
  assert.match(src,/FROM tool_activity/);
  const detailMethod=src.slice(src.indexOf("private sendDecisionDetail("),
    src.indexOf("private serialize("));
  assert.ok(!detailMethod.includes("encrypted_key"));
  assert.ok(!detailMethod.includes("apiKey"));
});

test("debug panel has tabs, readable outcome labels, and renders only text nodes",()=>{
  const js=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.match(html,/id="decision-tabs"/);
  assert.match(html,/id="decision-list"/);
  assert.match(html,/id="usage-stats"/);
  assert.match(js,/renderDecisionTabs/);
  assert.match(js,/function renderDecisions/);
  assert.match(js,/function renderDecisionDetail/);
  assert.match(js,/type:"decision_detail"/);
  assert.match(js,/node\.textContent=text/);
  assert.match(js,/模型没有返回可读取的推理文本/);
});

test("observability opens as a full-screen workspace rather than a modal dialog",()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const css=readFileSync(new URL("../public/style.css",import.meta.url),"utf8");
  assert.match(html,/<section id="activity-view" class="activity-workspace" hidden/);
  assert.match(html,/id="decision-detail-panel"/);
  assert.match(html,/id="close-activity" class="debug-back"/);
  assert.doesNotMatch(html,/<dialog id="activity-dialog"/);
  assert.match(js,/function openActivityWorkspace\(\)/);
  assert.match(js,/el\.shell\.hidden=true;el\.activityView\.hidden=false/);
  assert.match(js,/function closeActivityWorkspace\(\)/);
  assert.match(js,/el\.activityView\.hidden=true;el\.shell\.hidden=false/);
  assert.match(js,/el\.activityButton\.addEventListener\("click",openActivityWorkspace\)/);
  assert.doesNotMatch(js,/el\.activityDialog\.showModal\(\)/);
  assert.match(css,/\.activity-workspace\{[\s\S]*?height:100dvh/);
  assert.match(css,/\.debug-layout\{[\s\S]*?grid-template-columns/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(css,/\.debug-inspector\{[\s\S]*?overflow-y:auto/);
});

test("full-screen inspector provides separate navigation and selected decision detail",()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(html,/class="debug-sidebar"/);
  assert.match(html,/class="debug-inspector"/);
  assert.match(html,/id="decision-list"/);
  assert.match(html,/id="decision-detail-panel"/);
  assert.match(js,/function renderSelectedDecision\(d\)/);
  assert.match(js,/renderSelectedDecision\(rows\.find/);
  assert.match(js,/function renderDecisionDetail\(d,root\)/);
  assert.match(js,/if\(!el\.activityView\.hidden&&/);
  assert.match(js,/if\(e\.key==="Escape"&&!el\.activityView\.hidden/);
});
