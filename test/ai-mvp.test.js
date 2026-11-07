import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  DEFAULT_DS_PERSONA,DEFAULT_DOUBAO_PERSONA,readAIInput,
  encryptAPIKey,decryptAPIKey,publicAI
} from "../src/group/ai.ts";
import {buildGroupContext} from "../src/group/decision.ts";
import {modelWithTools} from "../src/toolloop.ts";

const example = {
  name:"豆包",provider:"volcengine",modelId:"doubao-seed-example",
  persona:"你是一个愿意独立思考的群友。",apiKey:"sk-example-123456"
};
test("model configuration and editable Markdown persona are independent",()=>{
  const config=readAIInput(example);
  assert.equal(config.name,"豆包");
  assert.equal(config.provider,"volcengine");
  assert.equal(config.model_id,"doubao-seed-example");
  assert.equal(config.persona,example.persona);
  assert.match(DEFAULT_DS_PERSONA,/DS/);
  assert.match(DEFAULT_DOUBAO_PERSONA,/豆包/);
  assert.throws(()=>readAIInput({...example,persona:""}),/人格文字/);
  assert.throws(()=>readAIInput({...example,provider:"unknown"}),/服务商/);
  const edit=readAIInput({...example,apiKey:""},true);
  assert.equal(edit.apiKey,"");
});
test("user credentials are encrypted and never returned to group members",async()=>{
  const secret=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const cipher=await encryptAPIKey(example.apiKey,secret);
  assert.ok(cipher.startsWith("v1."));
  assert.ok(!cipher.includes(example.apiKey));
  assert.equal(await decryptAPIKey(cipher,secret),example.apiKey);
  const another=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await assert.rejects(decryptAPIKey(cipher,another));
  const record={id:"ai_a",owner:"xiaolai",name:"豆包",provider:"volcengine",
    model_id:example.modelId,persona:example.persona,
    encrypted_key:cipher,created_at:Date.now(),enabled:1};
  const safe=publicAI(record);
  assert.equal(safe.owner,"xiaolai");
  assert.equal(safe.persona,example.persona);
  assert.equal(safe.hasKey,true);
  assert.ok(!("encrypted_key" in safe));
});
test("another AI's messages are user-context, its own are assistant-context",()=>{
  const context=buildGroupContext([
    {id:1,role:"xiaochi",content:"你们好"},
    {id:2,role:"ds",content:"你好，豆包"},
    {id:3,role:"ai_doubao",content:"大家好"}
  ],{id:"ai_doubao",name:"豆包",persona:"认真聊天。"},
  {ds:"DS",ai_doubao:"豆包"});
  assert.match(context[0].content,/认真聊天/);
  assert.equal(context[2].role,"user");
  assert.equal(context[2].name,"ds");
  assert.equal(context[2].content,"你好，豆包");
  assert.deepEqual(context[3],{role:"assistant",content:"大家好"});
});
test("Volcengine chat uses owner's key and model, not DeepSeek key",async()=>{
  let called=false;
  const env={provider:"volcengine",modelId:"ep-123",apiKey:"volcano-private",
    DEEPSEEK_BASE_URL:"https://api.deepseek.com",
    DEEPSEEK_MODEL:"deepseek-flash",DEEPSEEK_API_KEY:"owner-deepseek"};
  const mock=async(url,init)=>{
    called=true;
    assert.equal(String(url),"https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(init.headers.Authorization,"Bearer volcano-private");
    const request=JSON.parse(init.body);
    assert.equal(request.model,"ep-123");
    assert.ok(!request.thinking);
    assert.equal(request.reasoning_effort,"high");
    return Response.json({choices:[{message:{content:"你好，我是豆包"}}]});
  };
  const result=await modelWithTools(env,[{role:"user",content:"[小池] 你好"}],mock);
  assert.equal(called,true);
  assert.equal(result.kind,"speak");
  assert.equal(result.text,"你好，我是豆包");
});
test("a silent tool-using AI still emits activity records, not a message",async()=>{
  let rounds=0;
  const seen=[];
  const mock=async(url)=>{
    if(String(url).endsWith("/v1/tools/search")){
      return Response.json({results:[{title:"官网",url:"https://example.com",summary:"ok"}]});
    }
    rounds++;
    if(rounds===1) return Response.json({choices:[{message:{
      content:null,tool_calls:[{type:"function",id:"c1",function:{
        name:"web_search",arguments:'{"query":"hello"}'}}]
    }}]});
    return Response.json({choices:[{message:{
      content:null,tool_calls:[{type:"function",id:"c2",function:{name:"silence",arguments:"{}"}}]
    }}]});
  };
  const out=await modelWithTools({
    DEEPSEEK_BASE_URL:"https://api.deepseek.com",
    DEEPSEEK_MODEL:"deepseek-flash",DEEPSEEK_API_KEY:"test"
  },[{role:"user",content:"[小赖] 嗯"}],mock,t=>seen.push(t));
  assert.equal(out.kind,"silence");
  assert.equal(out.traces.length,1);
  assert.equal(out.traces[0].name,"web_search");
  assert.equal(seen.length,1);
});

class Element {
  constructor(tag="#text",value=""){
    this.tag=tag;this.children=[];this.value=value;
    this.href="";this.target="";this.rel="";
  }
  set textContent(value){this.children=[];this.value=String(value);}
  get textContent(){return this.value+this.children.map(x=>x.textContent).join("");}
  appendChild(node){this.children.push(node);return node;}
  replaceChildren(...items){this.children=items;this.value="";}
}
function renderFixture(text){
  const document={
    createElement:tag=>new Element(tag),
    createTextNode:content=>new Element("#text",content),
    createDocumentFragment:()=>new Element("#fragment")
  };
  const scope={document,window:{},URL};
  const source=readFileSync(new URL("../public/mini-markdown.js",import.meta.url),"utf8");
  vm.runInNewContext(source,scope);
  const container=new Element("div");
  scope.window.MiniMarkdown.render(text,container);
  const flattened=[];
  const visit=n=>{flattened.push(n);for(const child of n.children)visit(child);};
  visit(container);
  return {nodes:flattened,container};
}
test("safe chat Markdown renders clickable URLs with noopener noreferrer",()=>{
  const {nodes,container}=renderFixture("查看 https://example.com/path?x=1。以及 [官方](https://api.deepseek.com/docs)。");
  const links=nodes.filter(x=>x.tag==="a");
  assert.equal(links.length,2);
  assert.equal(links[0].href,"https://example.com/path?x=1");
  assert.equal(links[0].target,"_blank");
  assert.match(links[0].rel,/noopener/);
  assert.match(links[0].rel,/noreferrer/);
  assert.equal(links[1].textContent,"官方");
  assert.match(container.textContent,/。/);
});
test("Markdown does not interpret HTML, javascript URLs, or embedded scripts",()=>{
  const {nodes}=renderFixture('<img src=x onerror=alert(1)> [click](javascript:alert(1)) https://good.example');
  assert.equal(nodes.some(x=>x.tag==="img" || x.tag==="script"),false);
  const links=nodes.filter(x=>x.tag==="a");
  assert.equal(links.length,1);
  assert.equal(links[0].href,"https://good.example/");
  assert.ok(!nodes.some(x=>x.href?.startsWith("javascript:")));
});
test("Markdown subset renders bold, inline code, multiline code fences",()=>{
  const tick=String.fromCharCode(96);
  const content="**重点** "+tick+"foo()"+tick+"\n"+
    tick.repeat(3)+"js\nalert('<script>')\n"+tick.repeat(3);
  const {nodes}=renderFixture(content);
  assert.equal(nodes.filter(x=>x.tag==="strong").length,1);
  assert.equal(nodes.filter(x=>x.tag==="pre").length,1);
  assert.equal(nodes.filter(x=>x.tag==="code").length,2);
  assert.ok(nodes.filter(x=>x.tag==="code").some(x=>x.textContent.includes("alert(")));
});
