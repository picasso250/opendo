import test from "node:test";
import assert from "node:assert/strict";
import {readChatStream} from "../src/group/streaming.ts";
import {modelWithTools} from "../src/toolloop.ts";
import {safeAIError} from "../src/group/observability.ts";

const sseData = (...events) => events.map(data=>
  "data: "+(typeof data==="string"?data:JSON.stringify(data))+"\n\n").join("");

function chunkedStream(text, size=7){
  const bytes=new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller){
      for(let i=0;i<bytes.length;i+=size){
        controller.enqueue(bytes.slice(i,i+size));
      }
      controller.close();
    }
  });
}
function response(...events){
  return new Response(chunkedStream(sseData(...events)),{
    headers:{"Content-Type":"text/event-stream"}
  });
}
const content = delta => ({choices:[{delta}]});
const usage = ({prompt_tokens=23,completion_tokens=8}={})=>({
  choices:[{delta:{},finish_reason:"stop"}],
  usage:{prompt_tokens,completion_tokens,prompt_cache_hit_tokens:11,
    prompt_cache_miss_tokens:12,completion_tokens_details:{reasoning_tokens:4}}
});

test("SSE parser handles split UTF-8, role chunks, reasoning, output and final usage",async()=>{
  const fired=[];
  const result=await readChatStream(chunkedStream(sseData(
    content({role:"assistant"}),
    content({reasoning_content:"认真考虑"}),
    content({reasoning_content:"这个问题。"}),
    content({content:"你好"}),
    content({content:"，朋友！"}),
    usage(),"[DONE]"
  ),3),kind=>fired.push(kind));
  assert.deepEqual(fired,["first_token","first_content"]);
  assert.equal(result.choices[0].message.content,"你好，朋友！");
  assert.equal(result.choices[0].message.reasoning_content,"认真考虑这个问题。");
  assert.equal(result.usage.prompt_tokens,23);
  assert.equal(result.usage.prompt_cache_hit_tokens,11);
});

test("streaming tool call arguments combine across SSE chunks with stable tool ID",async()=>{
  const fired=[];
  const result=await readChatStream(chunkedStream(sseData(
    content({role:"assistant",tool_calls:[{index:0,id:"c-1",type:"function",function:{
      name:"web_search",arguments:""}}]}),
    content({tool_calls:[{index:0,function:{arguments:'{"query":'}}]}),
    content({tool_calls:[{index:0,function:{arguments:'"current"}'}}]}),
    usage(),"[DONE]"
  ),11),kind=>fired.push(kind));
  assert.deepEqual(fired,["first_token"]);
  assert.equal(result.choices[0].message.content,null);
  assert.deepEqual(result.choices[0].message.tool_calls,[{
    id:"c-1",type:"function",function:{name:"web_search",arguments:'{"query":"current"}'}
  }]);
});

test("Volcengine encrypted thinking blob is passed back untouched through streamed tool rounds",async()=>{
  let round=0;
  const env={provider:"volcengine",modelId:"doubao-seed-2-1-lite-260915",
    apiKey:"ark-test",DEEPSEEK_API_KEY:"tool-test",
    DEEPSEEK_BASE_URL:"https://api.deepseek.com",DEEPSEEK_MODEL:"deepseek-flash"};
  const reports=[];
  const fetcher=async(url,opts)=>{
    if(String(url).endsWith("/v1/tools/search"))
      return Response.json({results:[{title:"Example",url:"https://example.com",
        summary:"This is a test"}]});
    const req=JSON.parse(opts.body);
    assert.equal(req.stream,true);
    assert.equal(req.stream_options.include_usage,true);
    assert.equal(req.reasoning_effort,"high");
    if(round++===0){
      assert.equal(req.messages.length,1);
      return response(
        content({role:"assistant",reasoning_content:"先检索"},
          ),
        content({encrypted_content:"opaque-unchanged-token"}),
        content({tool_calls:[{index:0,id:"c-1",type:"function",
          function:{name:"web_search",arguments:'{"query":"example"}'}}]}),
        usage(),"[DONE]"
      );
    }
    assert.equal(req.messages[1].role,"assistant");
    assert.equal(req.messages[1].encrypted_content,"opaque-unchanged-token");
    assert.equal(req.messages[1].reasoning_content,"先检索");
    assert.equal(req.messages[2].role,"tool");
    return response(content({content:"查到了。"}),usage(),"[DONE]");
  };
  const result=await modelWithTools(env,[{role:"user",content:"查一下"}],
    fetcher,undefined,u=>reports.push(u));
  assert.equal(result.kind,"speak");
  assert.equal(result.text,"查到了。");
  assert.equal(reports.length,2);
  assert.ok(reports.every(x=>x.ttftMs!==null&&x.durationMs>=x.ttftMs));
  assert.equal(reports[0].firstContentMs,null);
  assert.ok(reports[1].firstContentMs!==null);
  assert.equal(reports[0].cacheHitTokens,11);
});

test("DeepSeek SSE tool calls and explicit silence preserve usage without fabricating content",async()=>{
  let round=0;
  const reports=[];
  const mock=async(url,options)=>{
    const req=JSON.parse(options.body);
    assert.equal(req.stream,true);
    assert.equal(req.thinking.type,"enabled");
    round++;
    return response(content({role:"assistant",reasoning_content:"现在不打断他们。"}),
      content({tool_calls:[{index:0,id:"silence-1",type:"function",
        function:{name:"silence",arguments:"{}"}}]}),
      usage(),"[DONE]");
  };
  const result=await modelWithTools({
    DEEPSEEK_API_KEY:"test-ds",DEEPSEEK_BASE_URL:"https://api.deepseek.com",
    DEEPSEEK_MODEL:"deepseek-flash"
  },[{role:"user",name:"xiaochi",content:"哈哈"}],mock,undefined,u=>reports.push(u));
  assert.equal(result.kind,"silence");
  assert.equal(result.via,"silence_tool");
  assert.match(result.reasoning,/现在不打断/);
  assert.equal(round,1);
  assert.equal(reports[0].success,true);
  assert.ok(reports[0].ttftMs!==null);
  assert.equal(reports[0].firstContentMs,null);
});

test("non-SSE compatibility response records TTFT as unknown, not full request duration",async()=>{
  const calls=[];
  const result=await modelWithTools({
    DEEPSEEK_API_KEY:"test-ds",DEEPSEEK_BASE_URL:"https://api.deepseek.com",
    DEEPSEEK_MODEL:"deepseek-flash"
  },[{role:"user",content:"Hi"}],
  async()=>Response.json({choices:[{message:{content:"Hello"}}],
    usage:{prompt_tokens:5,completion_tokens:3}}),
  undefined,usage=>calls.push(usage));
  assert.equal(result.kind,"speak");
  assert.equal(calls.length,1);
  assert.equal(calls[0].ttftMs,null);
  assert.equal(calls[0].firstContentMs,null);
  assert.equal(calls[0].promptTokens,5);
});

test("a zero-token response distinguishes provider filtering, length, and empty stop",async()=>{
  for(const [finish,expected] of [
    ["content_filter","model_content_filter"],
    ["length","model_output_truncated"],
    ["stop","model_empty_output"]
  ]){
    const reports=[];
    let sent=0;
    const env={DEEPSEEK_API_KEY:"test-ds",DEEPSEEK_BASE_URL:"https://api.deepseek.com",
      DEEPSEEK_MODEL:"deepseek-flash",provider:"volcengine",modelId:"doubao-seed-2-1-lite-260915",
      apiKey:"test-volcengine"};
    const mock=async()=>{
      sent++;
      return response({choices:[{index:0,finish_reason:finish}]},
        {choices:[],usage:{prompt_tokens:9110,completion_tokens:0}},"[DONE]");
    };
    await assert.rejects(modelWithTools(env,[{role:"user",content:"hi"}],
      mock,undefined,x=>reports.push(x)),e=>{
      const issue=safeAIError(e);
      assert.equal(issue.code,expected);
      assert.match(issue.detail,new RegExp("finish_reason="+finish));
      return true;
    });
    assert.equal(sent,1,"do not blindly retry an empty or filtered answer");
    assert.equal(reports.length,1);
    assert.equal(reports[0].httpStatus,200);
    assert.equal(reports[0].success,false,"HTTP 200 with no content is a failed decision");
    assert.equal(reports[0].finishReason,finish);
    assert.equal(reports[0].completionTokens,0);
    assert.equal(reports[0].ttftMs,null);
  }
});

test("truncated SSE fails closed and still records the failed request",async()=>{
  const reports=[];
  await assert.rejects(modelWithTools({
    DEEPSEEK_API_KEY:"test-ds",DEEPSEEK_BASE_URL:"https://api.deepseek.com",
    DEEPSEEK_MODEL:"deepseek-flash"
  },[{role:"user",content:"Hello"}],
  async()=>response(content({content:"partial, not done"})),
  undefined,usage=>reports.push(usage)),/incomplete streamed model response/);
  assert.equal(reports.length,1);
  assert.equal(reports[0].success,false);
  assert.ok(reports[0].ttftMs!==null);
});
