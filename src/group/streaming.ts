/**
 * OpenAI-compatible SSE chat completion adapter. Collects stream deltas into
 * the same message shape as nonstreaming Chat Completions, including function
 * arguments, reasoning and Doubao's encrypted_content for tool continuation.
 * Observability callbacks are raised only for real generated content, never
 * an empty role/keepalive chunk.
 */
export type StreamMilestone = "first_token" | "first_content";

export async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  onMilestone?: (kind: StreamMilestone) => void
): Promise<{choices: Array<{message: Record<string, unknown>; finish_reason: string | null}>; usage?: unknown}> {
  const reader=stream.getReader();
  const decoder=new TextDecoder();
  let pending="";
  let totalBytes=0;
  let completed=false;
  let received=false;
  let first=false;
  let firstContent=false;
  let content="";
  let reasoning="";
  let encrypted="";
  let usage:unknown;
  let finishReason:string|null=null;
  const calls=new Map<number,{id:string;type:string;function:{name:string;arguments:string}}>();
  const milestone=(kind:StreamMilestone)=>{
    if(kind==="first_token" && !first){first=true;onMilestone?.(kind);}
    if(kind==="first_content" && !firstContent){firstContent=true;onMilestone?.(kind);}
  };
  const processEvent=(raw:string)=>{
    const data=raw.split(/\r?\n/).filter(x=>x.startsWith("data:"))
      .map(x=>x.slice(5).trimStart()).join("\n").trim();
    if(!data)return;
    if(data==="[DONE]"){completed=true;return;}
    const chunk=JSON.parse(data);
    if(chunk.usage&&typeof chunk.usage==="object")usage=chunk.usage;
    for(const choice of chunk.choices??[]){
      if(typeof choice?.finish_reason==="string"){
        finishReason=choice.finish_reason;
        // A filtered completion may contain no delta, just a finish reason.
        received=true;
      }
      const delta=choice?.delta;
      if(!delta || typeof delta!=="object")continue;
      received=true;
      if(typeof delta.reasoning_content==="string" && delta.reasoning_content.length){
        milestone("first_token");
        reasoning+=delta.reasoning_content;
      }
      if(typeof delta.content==="string" && delta.content.length){
        milestone("first_token");milestone("first_content");
        content+=delta.content;
      }
      if(typeof delta.encrypted_content==="string" && delta.encrypted_content){
        // Volcengine may supply a single complete opaque blob in a later chunk.
        encrypted=delta.encrypted_content;
      }
      for(const call of delta.tool_calls??[]){
        if(!Number.isInteger(call.index) || call.index<0 || call.index>20) {
          throw new Error("invalid streamed tool index");
        }
        let target=calls.get(call.index);
        if(!target){
          target={id:"",type:"function",function:{name:"",arguments:""}};
          calls.set(call.index,target);
        }
        if(typeof call.id==="string")target.id=call.id;
        if(typeof call.type==="string")target.type=call.type;
        if(typeof call.function?.name==="string" && call.function.name){
          target.function.name+=call.function.name;
          milestone("first_token");
        }
        if(typeof call.function?.arguments==="string" && call.function.arguments){
          target.function.arguments+=call.function.arguments;
          milestone("first_token");
        }
      }
    }
  };
  const consume=()=>{
    let match:RegExpExecArray|null;
    const re=/\r?\n\r?\n/g;
    while((match=re.exec(pending))!==null){
      const event=pending.slice(0,match.index);
      pending=pending.slice(match.index+match[0].length);
      re.lastIndex=0;
      processEvent(event);
    }
  };
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      totalBytes+=value.byteLength;
      if(totalBytes>4_000_000)throw new Error("stream response too large");
      pending+=decoder.decode(value,{stream:true});
      consume();
      if(completed)break;
    }
    pending+=decoder.decode();
    if(pending.trim()&&!completed)processEvent(pending);
    if(!received)throw new Error("empty streamed model response");
    if(!completed)throw new Error("incomplete streamed model response");
    const message:Record<string,unknown>={
      role:"assistant",content:content || null
    };
    if(reasoning)message.reasoning_content=reasoning;
    if(encrypted)message.encrypted_content=encrypted;
    if(calls.size)message.tool_calls=[...calls.entries()]
      .sort(([a],[b])=>a-b).map(([,call])=>call);
    return {choices:[{message,finish_reason:finishReason}],usage};
  }finally{
    reader.releaseLock();
  }
}
