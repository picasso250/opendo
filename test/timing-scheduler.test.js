import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {randomizedAIOrder} from "../src/group/scheduling.ts";
import {buildGroupContext} from "../src/group/decision.ts";
import {modelWithTools} from "../src/toolloop.ts";

const ai={id:"ai_cat",name:"豆小喵",persona:"独立、有趣的群友。",
  provider:"volcengine",modelId:"doubao-seed-2-1-lite-260915",owner:"xiaolai"};
const env={DEEPSEEK_API_KEY:"test-ds",DEEPSEEK_BASE_URL:"https://api.deepseek.com",
  DEEPSEEK_MODEL:"deepseek-flash"};

test("random serial ordering preserves every active AI exactly once",()=>{
  const members=["大肥鱼","豆小喵","DS"];
  const reversed=randomizedAIOrder(members,()=>0);
  assert.deepEqual(reversed,["豆小喵","DS","大肥鱼"]);
  assert.deepEqual(members,["大肥鱼","豆小喵","DS"]);
  const unchanged=randomizedAIOrder(members,max=>max-1);
  assert.deepEqual(unchanged,members);
  for(let i=0;i<24;i++){
    const shuffled=randomizedAIOrder(members);
    assert.deepEqual([...shuffled].sort(),[...members].sort());
  }
  assert.deepEqual(randomizedAIOrder([]),[]);
  assert.deepEqual(randomizedAIOrder(["A"]),["A"]);
  assert.throws(()=>randomizedAIOrder(members,()=>100),/shuffle/);
});

test("context includes true model metadata while timestamps stay outside LLM content",()=>{
  const t1=Date.UTC(2026,10,7,6,30,1),t2=Date.UTC(2026,10,7,6,31,45);
  const turns=[
    {id:1,role:"xiaolai",content:"你是什么模型？",created_at:t1},
    {id:2,role:"ds",content:"我是一条大肥鱼。",created_at:t2}
  ];
  const context=buildGroupContext(turns,ai,{ds:"大肥鱼"});
  assert.match(context[0].content,/豆小喵/);
  assert.match(context[0].content,/火山方舟|volcengine/);
  assert.match(context[0].content,/doubao-seed-2-1-lite-260915/);
  assert.match(context[0].content,/创建者：小赖/);
  assert.deepEqual(context[1],{role:"user",name:"xiaolai",content:"你是什么模型？"});
  assert.deepEqual(context[2],{role:"user",name:"ds",content:"我是一条大肥鱼。"});
  assert.match(context[0].content,/ds = 大肥鱼/);
  assert.equal(context.some(m=>m.content.includes("2026-11-07T")),false);
  assert.equal(context.some(m=>m.content.includes("运行时钟")),false);
});

test("no synthesized clock or inline speaker label: stable context ends with actual content",()=>{
  const turns=[{id:1,role:"xiaochi",content:"你好",created_at:Date.UTC(2026,10,7)}];
  const context=buildGroupContext(turns,ai);
  assert.equal(context.length,2);
  assert.deepEqual(context.at(-1),{role:"user",name:"xiaochi",content:"你好"});
  assert.ok(!context.some(m=>m.content.includes("运行时钟")));
});

test("system member changes are visible in AI context as server-generated events",()=>{
  const turns=[
    {id:1,role:"xiaochi",content:"介绍一下",created_at:Date.UTC(2026,10,7)},
    {id:2,role:"system",content:"小赖 暂停了 AI「豆小喵」",created_at:Date.UTC(2026,10,7,0,1)}
  ];
  const context=buildGroupContext(turns,ai);
  assert.equal(context.length,3);
  assert.equal(context[2].role,"user");
  assert.equal(context[2].name,"group_system");
  assert.equal(context[2].content,"小赖 暂停了 AI「豆小喵」");
  assert.doesNotMatch(context[2].content,/2026-11-07T/);
});

test("later AI sees earlier AI's answer within the same human-triggered round",()=>{
  const turns=[
    {id:10,role:"xiaochi",content:"讨论一下编译器",created_at:1762490000000},
    {id:11,role:"ds",content:"先关注类型系统",created_at:1762490001000}
  ];
  const context=buildGroupContext(turns,ai,{ds:"大肥鱼"},1762490003000);
  assert.deepEqual(context[2],{role:"user",name:"ds",content:"先关注类型系统"});
});

test("room persists latency-ranked run_order and never coalesces human messages",()=>{
  const source=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  assert.match(source,/this.fastestAIOrder\(this.allAI\(\).filter\(x=>x.enabled\)\)/);
  assert.match(source,/discussion_round/);
  assert.match(source,/root_message_id/);
  assert.match(source,/ORDER BY message_id,run_order,ai_id/);
  assert.match(source,/run_order INTEGER NOT NULL DEFAULT 0/);
  assert.match(source,/PRAGMA table_info\(ai_jobs\)/);
  assert.match(source,/ORDER BY id DESC LIMIT 60/);
  assert.doesNotMatch(source,/WHERE id\s*<=\s*\?/);
  assert.match(source,/this\.ctx\.waitUntil\(this\.drain\(\)\)/);
});

test("every API round reports prompt/completion/reasoning and cache hit/miss",async()=>{
  const reports=[];
  let count=0;
  const mock=async(url,options)=>{
    if(String(url).endsWith("/v1/tools/search"))return Response.json({results:[
      {title:"结果",url:"https://example.com",summary:"ok"}]});
    assert.equal(options.headers.Authorization,"Bearer test-ds");
    const req=JSON.parse(options.body);
    assert.equal(req.reasoning_effort,"high");
    count++;
    if(count===1) return Response.json({choices:[{message:{
      role:"assistant",content:null,
      tool_calls:[{id:"search-1",type:"function",function:{
        name:"web_search",arguments:JSON.stringify({query:"example"})}}]
    }}],usage:{prompt_tokens:100,completion_tokens:25,prompt_cache_hit_tokens:60,
      prompt_cache_miss_tokens:40,completion_tokens_details:{reasoning_tokens:10}}});
    return Response.json({choices:[{message:{role:"assistant",content:"搜索完成"}}],
      usage:{prompt_tokens:120,completion_tokens:32,prompt_cache_hit_tokens:90,
        prompt_cache_miss_tokens:30,completion_tokens_details:{reasoning_tokens:18}}});
  };
  const out=await modelWithTools(env,[{role:"user",content:"[小赖] 请查"}],
    mock,undefined,r=>reports.push(r));
  assert.equal(out.kind,"speak");
  assert.equal(reports.length,2);
  assert.deepEqual(reports.map(r=>[r.promptTokens,r.completionTokens,r.reasoningTokens,
    r.cacheHitTokens,r.cacheMissTokens]),[[100,25,10,60,40],[120,32,18,90,30]]);
  assert.deepEqual(reports.map(r=>r.round),[1,2]);
  assert.ok(reports.every(r=>r.success&&r.httpStatus===200&&r.durationMs>=0));
});

test("absent provider usage stays null, never misreported as cache misses",async()=>{
  const reports=[];
  const mock=async()=>Response.json({choices:[{message:{content:"喵"}}]});
  await modelWithTools({...env,provider:"volcengine",modelId:"ep-test",apiKey:"cat"},
    [{role:"user",content:"hi"}],mock,undefined,r=>reports.push(r));
  assert.equal(reports.length,1);
  assert.equal(reports[0].cacheHitTokens,null);
  assert.equal(reports[0].cacheMissTokens,null);
  assert.equal(reports[0].promptTokens,null);
  assert.equal(reports[0].completionTokens,null);
});

test("failed model call is recorded with HTTP status and null tokens",async()=>{
  const reports=[];
  const mock=async()=>new Response("Too many requests",{status:429});
  await assert.rejects(modelWithTools(env,[{role:"user",content:"hi"}],
    mock,undefined,r=>reports.push(r)),/HTTP 429/);
  assert.equal(reports.length,1);
  assert.equal(reports[0].success,false);
  assert.equal(reports[0].httpStatus,429);
  assert.equal(reports[0].cacheHitTokens,null);
});

test("usage model table persists each round and activity UI displays cache statistics",()=>{
  const room=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  const browser=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(room,/CREATE TABLE IF NOT EXISTS model_usage/);
  assert.match(room,/INSERT INTO model_usage/);
  assert.match(room,/SUM\(cache_hit_tokens\)/);
  assert.match(room,/SUM\(cache_miss_tokens\)/);
  assert.match(browser,/模型用量 · 最近 24 小时/);
  assert.match(browser,/缓存命中/);
});

test("system events are server-authored, persisted, and do not enqueue model jobs",()=>{
  const source=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("private memberEvent("),source.indexOf("private humanName("));
  assert.match(body,/INSERT INTO messages\(role,content,created_at\)/);
  assert.match(body,/role:"system"/);
  assert.doesNotMatch(body,/ai_jobs|waitUntil|drain/);
  for(const text of ["添加了 AI","暂停了","启用了","移除了 AI"]){
    assert.ok(source.includes(text),text);
  }
});

test("message Token usage is stored on AI replies, not double-counting reasoning tokens",()=>{
  const room=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  const browser=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(room,/ALTER TABLE messages ADD COLUMN usage TEXT/);
  assert.match(room,/usageForDecision\(ai.id,job.message_id\)/);
  assert.match(room,/INSERT INTO messages\(role,content,created_at,reasoning,trace,usage\)/);
  assert.match(browser,/messageUsage\(m.usage\)/);
  assert.match(browser,/inp\+out/);
  assert.match(browser,/role==="system"/);
  assert.match(browser,/system-event/);
});
