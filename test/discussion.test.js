import test from "node:test";
import assert from "node:assert/strict";
import {nextWaveSpeakers, isJobSuperseded, MAX_DISCUSSION_ROUNDS} from "../src/group/discussion.ts";
import {fastestFirst,estimateTTFT} from "../src/group/scheduling.ts";
import {roomCurrentDate,buildGroupContext} from "../src/group/decision.ts";
import {readFileSync} from "node:fs";

const root=100;
const wave=(outcomes)=>{
  return outcomes.map(([ai,outcome],index)=>({
    ai_id:ai,status:"done",outcome,
    reply_message_id:outcome==="replied"?101+index:null
  }));
};
test("two AIs speaking advance from round 1 to round 2 and then round 3 only",()=>{
  const replies=wave([["fish","replied"],["cat","replied"]]);
  assert.deepEqual(nextWaveSpeakers(replies,root,1,root),[
    {ai_id:"fish",reply_message_id:101},{ai_id:"cat",reply_message_id:102}
  ]);
  assert.equal(nextWaveSpeakers(replies,root,2,root).length,2);
  assert.deepEqual(nextWaveSpeakers(replies,root,3,root),[]);
  assert.equal(MAX_DISCUSSION_ROUNDS,3);
});

test("silence is out for the rest of this discussion; one voice cannot self-loop",()=>{
  const first=wave([["fish","replied"],["cat","silence"]]);
  assert.deepEqual(nextWaveSpeakers(first,root,1,root),[]);
  const second=wave([["fish","replied"],["cat","replied"],["owl","silence"]]);
  assert.deepEqual(nextWaveSpeakers(second,root,2,root),
    [{ai_id:"fish",reply_message_id:101},{ai_id:"cat",reply_message_id:102}]);
  const noSpeakers=wave([["fish","silence"],["cat","failed"],["owl","skipped"]]);
  assert.deepEqual(nextWaveSpeakers(noSpeakers,root,1,root),[]);
});

test("incomplete first wave and superseding human message prevent next wave",()=>{
  const pending=wave([["fish","replied"],["cat","replied"]]);
  pending[1].status="working";
  assert.deepEqual(nextWaveSpeakers(pending,root,1,root),[]);
  const replies=wave([["fish","replied"],["cat","replied"]]);
  assert.deepEqual(nextWaveSpeakers(replies,root,1,103),[]);
  assert.deepEqual(nextWaveSpeakers(replies,root,1,99).length,2);
  assert.deepEqual(nextWaveSpeakers([],root,1,root),[]);
});

test("a newer human message supersedes pending first-round jobs as well as AI continuations",()=>{
  const first={message_id:100,root_message_id:100};
  const later={message_id:110,root_message_id:100};
  const legacy={message_id:100,root_message_id:null};
  for(const job of [first,later,legacy]){
    assert.equal(isJobSuperseded(job,101),true);
    assert.equal(isJobSuperseded(job,100),false);
    assert.equal(isJobSuperseded(job,null),false);
  }
  assert.equal(isJobSuperseded({message_id:102,root_message_id:102},101),false);
});

test("new human eagerly cancels only pending old work and replaces it with a fresh wave",()=>{
  const room=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  const cancel=room.slice(room.indexOf("private supersedePendingJobs("),room.indexOf("private say("));
  const say=room.slice(room.indexOf("private say("),room.indexOf("private onlineNames("));
  const drain=room.slice(room.indexOf("private async drain("));
  assert.match(cancel,/SELECT message_id,ai_id FROM ai_jobs WHERE status='pending'/);
  assert.match(cancel,/UPDATE ai_jobs SET status='done',outcome='skipped'/);
  assert.match(cancel,/WHERE status='pending' AND COALESCE\(root_message_id,message_id\) < \?/);
  assert.match(cancel,/error_code='discussion_superseded'/);
  assert.match(cancel,/this\.notifyDecision\(job\.message_id,job\.ai_id\)/);
  assert.ok(say.indexOf("this.supersedePendingJobs(id)") < say.indexOf("const participants="),
    "supersede old pending work before enqueuing a new wave");
  assert.match(drain,/if\(isJobSuperseded\(job,newest\)\)/);
  assert.doesNotMatch(drain,/if\(job\.discussion_round>1/);
  assert.match(drain,/UPDATE ai_jobs SET status='working',started_at/);
});

test("duplicate speaker entries cannot create extra slots",()=>{
  const duplicates=wave([["fish","replied"],["fish","replied"]]);
  assert.deepEqual(nextWaveSpeakers(duplicates,root,1,root),[]);
});

test("historical TTFT EWMA ranks fastest AI first; no samples are unknown",()=>{
  const candidates=[{id:"fish"},{id:"cat"},{id:"new"}];
  const historical={fish:estimateTTFT([80,120,100]),cat:estimateTTFT([500,350]),new:null};
  assert.ok(historical.fish<historical.cat);
  assert.deepEqual(fastestFirst(candidates,ai=>historical[ai.id]).map(x=>x.id),
    ["fish","cat","new"]);
  assert.equal(estimateTTFT([]),null);
  assert.equal(estimateTTFT([Number.NaN,-1]),null);
  assert.equal(estimateTTFT([100]),100);
  assert.ok(estimateTTFT([100,400])<300);
});

test("current system date uses group calendar, not message timestamps",()=>{
  // Just before Shanghai midnight, Nov 6 in UTC; the current date is Nov 7.
  const now=Date.UTC(2026,10,6,16,1);
  assert.equal(roomCurrentDate(now),"2026-11-07");
  assert.equal(roomCurrentDate(Date.UTC(2026,10,6,15,59)),"2026-11-06");
  const context=buildGroupContext([
    {id:1,role:"xiaochi",content:"现在是几号？",created_at:0}
  ],undefined,{}, {now,discussionRound:2,maxDiscussionRounds:3});
  assert.match(context[0].content,/当前日期\n2026-11-07（北京时间/);
  assert.match(context[0].content,/当前是第 2 \/ 3 轮/);
  assert.deepEqual(context[1],{role:"user",name:"xiaochi",content:"现在是几号？"});
  assert.equal(context.length,2,"No extra synthetic clock message");
});

test("room server persists wave rounds and does not spawn on AI messages alone",()=>{
  const room=readFileSync(new URL("../src/group/room.ts",import.meta.url),"utf8");
  assert.match(room,/nextWaveSpeakers\(wave,root,round,latestInterrupt\)/);
  assert.match(room,/this\.scheduleNextWave\(messageId,aiId\)/);
  assert.match(room,/discussionRound:job\.root_message_id===null\?undefined:job\.discussion_round/);
  assert.match(room,/root_message_id,discussion_round/);
  assert.match(room,/discussion_superseded/);
  assert.match(room,/SELECT message_id,ai_id,root_message_id,discussion_round/);
  assert.match(room,/ADD COLUMN ttft_ms INTEGER/);
  assert.match(room,/ADD COLUMN first_content_ms INTEGER/);
  assert.match(room,/MIN\(CASE WHEN model_round=1 THEN ttft_ms END\)/);
  assert.match(room,/this.ctx.waitUntil\(this.drain\(\)\)/);
  assert.match(room,/ORDER BY message_id,run_order,ai_id/);
  assert.match(room,/INSERT OR IGNORE INTO ai_jobs/);
  assert.doesNotMatch(room,/WHERE id\s*<=\s*\?/);
});
