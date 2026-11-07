export const MAX_DISCUSSION_ROUNDS = 3;

/** A newer human message invalidates every not-yet-started decision from an older trigger.
 * A job already marked working is allowed to finish; callers apply this only to pending jobs.
 * Legacy jobs (without a root ID) use their triggering message ID.
 */
export function isJobSuperseded(
  job: {message_id:number;root_message_id:number|null},
  latestHumanMessageId:number|null
): boolean {
  return latestHumanMessageId !== null &&
    latestHumanMessageId > (job.root_message_id ?? job.message_id);
}

export type DiscussionJob = {
  ai_id: string;
  status: string;
  outcome: string | null;
  reply_message_id: number | null;
};

/**
 * Only AI members that actually spoke in this wave are eligible to continue.
 * Silence, failures and skips are final for the current human-triggered thread.
 * Every wave must be finished before the next one is considered, and a newer
 * human utterance supersedes its autonomous continuation.
 */
export function nextWaveSpeakers(
  jobs: readonly DiscussionJob[],
  rootMessageId: number,
  currentRound: number,
  latestHumanMessageId: number | null,
  maxRounds = MAX_DISCUSSION_ROUNDS
): Array<{ai_id:string;reply_message_id:number}> {
  if(!jobs.length || currentRound < 1 || currentRound >= maxRounds ||
     (latestHumanMessageId !== null && latestHumanMessageId > rootMessageId) ||
     jobs.some(job=>job.status!=="done"))return [];
  const speakers=new Map<string,number>();
  for(const job of jobs){
    if(job.outcome==="replied" &&
       Number.isSafeInteger(job.reply_message_id) &&
       (job.reply_message_id??0)>0 &&
       !speakers.has(job.ai_id)){
      speakers.set(job.ai_id,job.reply_message_id!);
    }
  }
  return speakers.size>=2
    ?[...speakers.entries()].map(([ai_id,reply_message_id])=>({ai_id,reply_message_id}))
    :[];
}
