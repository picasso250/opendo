/**
 * A human message starts one decision round for the enabled AI members.
 * Randomize once, persist the resulting run_order in ai_jobs, then execute
 * strictly in that order. New human messages start separate rounds.
 */
export function randomizedAIOrder<T>(members: readonly T[], randomIndex?: (max: number) => number): T[] {
  const ordered = [...members];
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = randomIndex
      ? randomIndex(i + 1)
      : crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("Invalid shuffle index");
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  return ordered;
}

/**
 * The previous successfully observed TTFT (smoothed over recent samples)
 * determines a member's first-turn priority. This is a historic estimate,
 * not a guarantee of which request will finish first.
 */
export function fastestFirst<T extends {id:string}>(
  members: readonly T[],
  score: (member:T)=>number|null
): T[] {
  const ranked=members.map(member=>({member,value:score(member)}));
  ranked.sort((a,b)=>{
    const aMs=a.value!==null&&Number.isFinite(a.value)&&a.value>=0
      ?a.value:Number.POSITIVE_INFINITY;
    const bMs=b.value!==null&&Number.isFinite(b.value)&&b.value>=0
      ?b.value:Number.POSITIVE_INFINITY;
    return aMs-bMs || a.member.id.localeCompare(b.member.id);
  });
  return ranked.map(x=>x.member);
}


/** Newer successful first-turn TTFT samples have greater influence. */
export function estimateTTFT(recentFirst: readonly number[], decay=0.65): number|null {
  let total=0, weighted=0, weight=1;
  for(const ms of recentFirst.slice(0,6)){
    if(Number.isFinite(ms) && ms>=0){
      weighted+=ms*weight;
      total+=weight;
    }
    weight*=decay;
  }
  return total>0?weighted/total:null;
}
