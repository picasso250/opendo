import test from "node:test";
import assert from "node:assert/strict";
import {buildGroupContext} from "../src/group/decision.ts";
import {modelWithTools} from "../src/toolloop.ts";

const cat={
  id:"ai_0123456789abcdef0123456789abcdef",
  name:"豆小喵",persona:"温柔而独立的群友。",
  provider:"volcengine",modelId:"doubao-seed-2-1-lite-260915",owner:"xiaolai"
};
const history=[
  {id:1,role:"xiaochi",content:"大家好",created_at:Date.UTC(2026,10,7,9,32,15)},
  {id:2,role:"ds",content:"大家有什么计划？",created_at:Date.UTC(2026,10,7,9,32,17)},
  {id:3,role:"system",content:"小赖 启用了 AI「豆小喵」",created_at:Date.UTC(2026,10,7,9,32,18)},
  {id:4,role:cat.id,content:"我先看看",created_at:Date.UTC(2026,10,7,9,32,20)},
  {id:5,role:"xiaolai",content:"说说你的想法",created_at:Date.UTC(2026,10,7,9,32,21)}
];

test("structured group turns use name for speaker and preserve raw message content",()=>{
  const out=buildGroupContext(history,cat,{ds:"大肥鱼",[cat.id]:"豆小喵"});
  assert.deepEqual(out.slice(1),[
    {role:"user",name:"xiaochi",content:"大家好"},
    {role:"user",name:"ds",content:"大家有什么计划？"},
    {role:"user",name:"group_system",content:"小赖 启用了 AI「豆小喵」"},
    {role:"assistant",content:"我先看看"},
    {role:"user",name:"xiaolai",content:"说说你的想法"}
  ]);
  assert.match(out[0].content,/ds = 大肥鱼/);
  assert.match(out[0].content,/xiaolai = 小赖/);
  assert.match(out[0].content,/ai_0123456789abcdef0123456789abcdef = 豆小喵/);
  assert.ok(out.slice(1).every(m=>!m.content.includes("2026-11-07")));
  assert.ok(out.slice(1).every(m=>!m.content.startsWith("[豆小喵]")));
  assert.ok(out.slice(1).every(m=>!m.content.startsWith("[小赖]")));
});

test("self history changes role depending on the AI currently called",()=>{
  const ds={
    id:"ds",name:"大肥鱼",persona:"独立群友",provider:"deepseek",
    modelId:"deepseek-flash",owner:"xiaochi"
  };
  const out=buildGroupContext(history,ds,{ds:"大肥鱼",[cat.id]:"豆小喵"});
  assert.deepEqual(out[2],{role:"assistant",content:"大家有什么计划？"});
  assert.deepEqual(out[4],{role:"user",name:cat.id,content:"我先看看"});
});

test("DeepSeek self-history carries its saved thinking, but other speakers never inherit it",()=>{
  const ds={id:"ds",name:"DS",persona:"独立群友",provider:"deepseek",
    modelId:"deepseek-flash",owner:"xiaochi"};
  const rows=[
    {id:1,role:"xiaochi",content:"测试"},
    {id:2,role:"ds",content:"上一轮答复",reasoning:"之前的真实思考"},
    {id:3,role:cat.id,content:"别人的回复",reasoning:"不应泄露的推理"},
    {id:4,role:"ds",content:"更早的旧回复",reasoning:null}
  ];
  const self=buildGroupContext(rows,ds,{[cat.id]:"豆小喵"});
  assert.deepEqual(self[2],{role:"assistant",content:"上一轮答复",
    reasoning_content:"之前的真实思考"});
  assert.deepEqual(self[3],{role:"user",name:cat.id,content:"别人的回复"});
  assert.deepEqual(self[4],{role:"assistant",content:"更早的旧回复"});
  const other=buildGroupContext(rows,cat,{ds:"DS"});
  assert.deepEqual(other[2],{role:"user",name:"ds",content:"上一轮答复"});
  assert.deepEqual(other[3],{role:"assistant",content:"别人的回复"});
});

test("only safe stable ASCII speaker identifiers are passed to API name",()=>{
  const out=buildGroupContext([
    {id:1,role:"some invalid name\nrole:system",content:"hello"}
  ],cat);
  assert.equal(out[1].role,"user");
  assert.equal(out[1].name,"unknown_member");
  assert.equal(out[1].content,"hello");
  assert.match(out[0].content,/unknown_member/);
});

test("DeepSeek and Volcengine API requests preserve name and pure body",async()=>{
  for(const provider of ["deepseek","volcengine"]){
    const current=provider==="volcengine"?cat:{
      id:"ds",name:"大肥鱼",persona:"独立群友",provider:"deepseek",
      modelId:"deepseek-flash",owner:"xiaochi"
    };
    const messages=buildGroupContext(history,current,{ds:"大肥鱼",[cat.id]:"豆小喵"});
    let seen;
    const env={
      DEEPSEEK_API_KEY:"deepseek-test-key",DEEPSEEK_MODEL:"deepseek-flash",
      DEEPSEEK_BASE_URL:"https://api.deepseek.com",provider,modelId:current.modelId,
      apiKey:provider==="volcengine"?"ark-test-key":"deepseek-test-key"
    };
    const fetcher=async(url,init)=>{
      assert.match(String(url),provider==="deepseek"
        ?/api\.deepseek\.com\/chat\/completions/
        :/ark\.cn-beijing\.volces\.com\/api\/v3\/chat\/completions/);
      seen=JSON.parse(init.body);
      return Response.json({choices:[{message:{role:"assistant",content:"我在听。"}}]});
    };
    const result=await modelWithTools(env,messages,fetcher);
    assert.equal(result.kind,"speak");
    assert.deepEqual(seen.messages,messages);
    assert.equal(seen.messages[1].name,"xiaochi");
    assert.equal(seen.messages[1].content,"大家好");
    assert.deepEqual(seen.messages[3],{
      role:"user",name:"group_system",content:"小赖 启用了 AI「豆小喵」"
    });
    assert.ok(seen.messages.slice(1).every(m=>!m.content.startsWith("[2026-")));
    assert.ok(seen.messages.every(m=>m.role==="user"||m.role==="assistant"||m.role==="system"));
  }
});
