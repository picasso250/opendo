import test from "node:test";
import assert from "node:assert/strict";
import {
  hashInvite, roleForInvite, sessionCookie, memberFromCookie,
  secretsConfigured, sameOrigin, clearCookie
} from "../src/group/auth.ts";
import { buildGroupContext, SILENCE_TOOL } from "../src/group/decision.ts";
import { WEB_TOOLS, runWebTool } from "../src/search.ts";
import { modelWithTools } from "../src/toolloop.ts";

const owner = "a".repeat(64), guest = "b".repeat(64);
const env = {
  GROUP_XIAOCHI_HASH: await hashInvite(owner),
  GROUP_XIAOLAI_HASH: await hashInvite(guest),
  DEEPSEEK_API_KEY:"testing-api-key",
  DEEPSEEK_BASE_URL:"https://api.deepseek.com",
  DEEPSEEK_MODEL:"deepseek-flash"
};
const url = "https://chat.io99.xyz/api/group/me";
const message = (role,content,id) => ({role,content,id});

test("two distinct invites map to designated participants", async()=>{
  assert.equal(secretsConfigured(env),true);
  assert.equal(await roleForInvite(owner,env),"xiaochi");
  assert.equal(await roleForInvite(guest,env),"xiaolai");
  assert.equal(await roleForInvite("c".repeat(64),env),null);
  assert.equal(await roleForInvite("bad-code",env),null);
});
test("cookie signed, HttpOnly, time-bound and revocable", async()=>{
  const now=Date.UTC(2026,10,7);
  const cookie=await sessionCookie("xiaolai",env,now);
  assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  const req=new Request(url,{headers:{Cookie:cookie.split(";")[0]}});
  assert.equal(await memberFromCookie(req,env,now+1000),"xiaolai");
  assert.equal(await memberFromCookie(req,env,now+8*86400_000),null);
  assert.equal(await memberFromCookie(req,{...env,GROUP_XIAOLAI_HASH:"c".repeat(64)},now),null);
  const tampered=new Request(url,{headers:{Cookie:cookie.split(";")[0].replace("xiaolai","xiaochi")}});
  assert.equal(await memberFromCookie(tampered,env,now),null);
  assert.match(clearCookie(),/Max-Age=0/);
});
test("cross-origin requests rejected",()=>{
  assert.equal(sameOrigin(new Request(url,{headers:{Origin:"https://evil.example"}})),false);
  assert.equal(sameOrigin(new Request(url,{headers:{Origin:"https://chat.io99.xyz"}})),true);
});
test("context contains both human identities, previous DS messages, latest human turn",()=>{
  const context=buildGroupContext([
    message("xiaochi","你好",1), message("xiaolai","我也来了",2),
    message("ds","欢迎",3), message("xiaolai","继续讨论",4)
  ]);
  assert.equal(context.length,5);
  assert.equal(context[0].role,"system");
  assert.deepEqual(context[1],{role:"user",name:"xiaochi",content:"你好"});
  assert.deepEqual(context[2],{role:"user",name:"xiaolai",content:"我也来了"});
  assert.deepEqual(context[3],{role:"assistant",content:"欢迎"});
  assert.deepEqual(context[4],{role:"user",name:"xiaolai",content:"继续讨论"});
  assert.equal(context.some(m=>m.content.includes("运行时钟")),false);
});
test("exactly silence, web_search, web_fetch; NO js_eval",()=>{
  assert.deepEqual([SILENCE_TOOL,...WEB_TOOLS].map(x=>x.function.name),
    ["silence","web_search","web_fetch"]);
});
test("model can silently abstain, with no public message",async()=>{
  const seen=[];
  const mock=async(path,options)=>{
    seen.push(JSON.parse(options.body));
    return Response.json({choices:[{message:{role:"assistant",content:null,
      tool_calls:[{id:"s1",type:"function",function:{name:"silence",arguments:"{}"}}]}}]});
  };
  const out=await modelWithTools(env,buildGroupContext([message("xiaolai","嗯",5)]),mock);
  assert.deepEqual(out,{kind:"silence",usedTools:[],traces:[],via:"silence_tool"});
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0].tools.map(x=>x.function.name),["silence","web_search","web_fetch"]);
  assert.equal(seen[0].model,"deepseek-flash");
});
test("model can speak without any tool",async()=>{
  const mock=async()=>Response.json({choices:[{message:{role:"assistant",content:"我有不同看法"}}]});
  const out=await modelWithTools(env,buildGroupContext([message("xiaochi","讨论一下",6)]),mock);
  assert.deepEqual(out,{kind:"speak",text:"我有不同看法",usedTools:[],traces:[]});
});
test("search uses official endpoint, previous API Key, and bounded results", async()=>{
  let target="";
  const mock=async(path,init)=>{
    target=String(path);
    assert.equal(init.headers.Authorization,"Bearer testing-api-key");
    assert.deepEqual(JSON.parse(init.body),{query:"DeepSeek 新闻",count:5,need_content:false});
    return Response.json({results:[{title:"官网",url:"https://example.com",
      summary:"最新公告"}]});
  };
  const text=await runWebTool("web_search",{query:"DeepSeek 新闻"},env,mock);
  assert.match(target,/\/v1\/tools\/search$/);
  assert.match(text,/最新公告/);
});
test("web_fetch rejects internal addresses and fetches normal public pages",async()=>{
  let calls=0;
  const mock=async(path,init)=>{
    calls++;
    assert.match(String(path),/\/v1\/tools\/fetch$/);
    assert.equal(JSON.parse(init.body).url,"https://example.com/a");
    return Response.json({title:"Page",content:"# Document"});
  };
  for(const bad of ["http://localhost/a","http://127.0.0.1/a","http://[::1]/","file:///etc/passwd","http://x.local/"]){
    assert.match(await runWebTool("web_fetch",{url:bad},env,mock),/只支持公开/);
  }
  assert.match(await runWebTool("web_fetch",{url:"https://example.com/a"},env,mock),/# Document/);
  assert.equal(calls,1);
});
test("tool loop runs search, fetch, then a sourced reply", async()=>{
  const visited=[];let round=0;
  const mock=async(target,init)=>{
    const path=new URL(target).pathname;
    visited.push(path);
    if(path==="/chat/completions"){
      round++;
      if(round===1)return Response.json({choices:[{message:{
        role:"assistant",content:null,
        tool_calls:[{id:"s1",type:"function",function:{
          name:"web_search",arguments:'{"query":"Cloudflare Docs"}'}}]
      }}]});
      if(round===2){
        assert.equal(JSON.parse(init.body).messages.at(-1).role,"tool");
        return Response.json({choices:[{message:{role:"assistant",content:null,
          tool_calls:[{id:"f1",type:"function",function:{
            name:"web_fetch",arguments:'{"url":"https://example.com/a"}'}}]}}]});
      }
      return Response.json({choices:[{message:{role:"assistant",content:"来源：https://example.com/a"}}]});
    }
    if(path==="/v1/tools/search")return Response.json({results:[{title:"Docs",url:"https://example.com/a",summary:"official"}]});
    if(path==="/v1/tools/fetch")return Response.json({title:"Docs",content:"content"});
    throw Error("unexpected:"+path);
  };
  const result=await modelWithTools(env,buildGroupContext([message("xiaolai","有新消息吗？",2)]),mock);
  assert.equal(result.kind,"speak");
  assert.equal(result.text,"来源：https://example.com/a");
  assert.deepEqual(result.usedTools,["web_search","web_fetch"]);
  assert.deepEqual(result.traces.map(x=>x.name),["web_search","web_fetch"]);
  assert.deepEqual(visited,["/chat/completions","/v1/tools/search","/chat/completions","/v1/tools/fetch","/chat/completions"]);
});
test("one-round search cap restricts expensive search/fetch calls to 3",async()=>{
  let used=0;let modelCalls=0;
  const mock=async(url)=>{
    if(String(url).endsWith("/chat/completions")){
      modelCalls++;
      if(modelCalls===5)return Response.json({choices:[{message:{role:"assistant",content:"已检查"}}]});
      return Response.json({choices:[{message:{role:"assistant",content:null,
        tool_calls:[{id:"w"+modelCalls,type:"function",function:{
          name:"web_search",arguments:'{"query":"hello"}'}}]}}]});
    }
    used++;
    return Response.json({results:[{title:"ok",url:"https://example.com",summary:"ok"}]});
  };
  assert.deepEqual((await modelWithTools(env,buildGroupContext([message("xiaochi","请搜索",1)]),mock)).usedTools,
    ["web_search","web_search","web_search"]);
  assert.equal(used,3);
});

test("literal silence text is never shown to group members", async()=>{
  const { isLiteralSilence } = await import("../src/group/decision.ts");
  for(const word of ["silence","Silence"," silence ","silence.","silence。","沉默","不回复"]) {
    assert.equal(isLiteralSilence(word),true,"expected to silence "+JSON.stringify(word));
    const mock=async()=>Response.json({
      choices:[{message:{role:"assistant",content:word,reasoning_content:"The humans are speaking to each other."}}]
    });
    const out=await modelWithTools(env,buildGroupContext([message("xiaolai","嗯",10)]),mock);
    assert.equal(out.kind,"silence");
  }
  assert.equal(isLiteralSilence("I want to discuss the meaning of silence"),false);
});

test("DS model requests enable high-effort thinking with real silence tool", async()=>{
  let sent;
  const mock=async(_url,options)=>{
    sent=JSON.parse(options.body);
    return Response.json({
      choices:[{message:{role:"assistant",content:null,reasoning_content:"...",
        tool_calls:[{id:"silence1",type:"function",function:{name:"silence",arguments:"{}"}}]}}]
    });
  };
  const out=await modelWithTools(env,buildGroupContext([message("xiaochi","嗨",13)]),mock);
  assert.equal(sent.thinking.type,"enabled");
  assert.equal(sent.reasoning_effort,"high");
  assert.ok(sent.max_tokens>=2000);
  assert.equal(out.kind,"silence");
});

test("DeepSeek thinking tool loop passes back full reasoning_content", async()=>{
  const thought="reasoning_content_from_first_round_exact";
  let count=0;
  const mock=async(url,opts)=>{
    if(String(url).endsWith("/v1/tools/search")){
      return Response.json({results:[{title:"Example",url:"https://example.com",summary:"Found"}]});
    }
    const req=JSON.parse(opts.body);count++;
    if(count===1)return Response.json({choices:[{message:{
      role:"assistant",content:null,reasoning_content:thought,
      tool_calls:[{id:"web1",type:"function",function:{name:"web_search",
        arguments:'{"query":"example.com"}'}}]}}]});
    const a=req.messages.find(x=>x.tool_calls?.[0]?.id==="web1");
    assert.equal(a.reasoning_content,thought);
    assert.equal(req.messages.at(-1).role,"tool");
    return Response.json({choices:[{message:{role:"assistant",content:"找到了：https://example.com"}}]});
  };
  const out=await modelWithTools(env,buildGroupContext([message("xiaolai","搜索一下",10)]),mock);
  assert.equal(out.kind,"speak");
  assert.equal(count,2);
});

test("DS spoken answer includes DeepSeek thinking for optional disclosure", async()=>{
  const reasoning="I should respond because they asked me directly.";
  const mock=async()=>Response.json({choices:[{message:{
    role:"assistant",reasoning_content:reasoning,content:"你好，我是 DS。"
  }}]});
  const out=await modelWithTools(env,buildGroupContext([message("xiaochi","DS，你好",26)]),mock);
  assert.deepEqual(out,{kind:"speak",text:"你好，我是 DS。",usedTools:[],traces:[],reasoning});
});
test("thinking from multiple tool rounds is preserved chronologically",async()=>{
  let i=0;
  const mock=async(target)=>{
    if(new URL(target).pathname==="/v1/tools/search")return Response.json({results:[]});
    i++;
    if(i===1) return Response.json({choices:[{message:{
      role:"assistant",content:null,reasoning_content:"先搜索证据",
      tool_calls:[{id:"s9",type:"function",function:{name:"web_search",arguments:'{"query":"example"}'}}]
    }}]});
    return Response.json({choices:[{message:{
      role:"assistant",content:"没找到结果",reasoning_content:"没有可靠结果，应该说明不确定。"
    }}]});
  };
  const out=await modelWithTools(env,buildGroupContext([message("xiaolai","帮我查一下",20)]),mock);
  assert.equal(out.kind,"speak");
  assert.equal(out.reasoning,"先搜索证据\n\n———\n\n没有可靠结果，应该说明不确定。");
});
test("silent AI retains actual provider reasoning for authenticated debug only",async()=>{
  const mock=async()=>Response.json({choices:[{message:{
    role:"assistant",content:null,reasoning_content:"I will stay quiet.",
    tool_calls:[{id:"silence2",type:"function",function:{name:"silence",arguments:"{}"}}]
  }}]});
  const out=await modelWithTools(env,buildGroupContext([message("xiaolai","好的",23)]),mock);
  assert.deepEqual(out,{kind:"silence",usedTools:[],traces:[],
    reasoning:"I will stay quiet.",via:"silence_tool"});
});
test("web UI renders reasoning in a collapsed native details element with textContent",async()=>{
  const fs=await import("node:fs/promises");
  const js=await fs.readFile(new URL("../public/app.js",import.meta.url),"utf8");
  const css=await fs.readFile(new URL("../public/style.css",import.meta.url),"utf8");
  assert.match(js,/document\.createElement\("details"\)/);
  assert.match(js,/document\.createElement\("summary"\)/);
  assert.match(js,/wrap\.append\(disclosure\("查看思考过程",m\.reasoning,"reasoning"\)\)/);
  assert.match(js,/if\(ai && typeof m\.reasoning==="string" && m\.reasoning\.trim\(\)\)/);
  assert.doesNotMatch(js,/details\.open\s*=\s*true/);
  assert.match(css,/\.reasoning-text\{/);
  assert.ok(js.indexOf('wrap.append(disclosure("查看思考过程"') < js.indexOf('wrap.append(bubble)'));
});
