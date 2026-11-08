/** Harmless local DSH headless preflight. Does not contact OpenDo Worker APIs. */
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveDshLaunch,executeDshHeadless} from './dsh-headless.mjs';
import {loadDshProviderEnvironment} from './dsh-credentials.mjs';

let cwd;
try{
  cwd=await mkdtemp(join(tmpdir(),'opendo-dsh-smoke-'));
  const launch=resolveDshLaunch(process.env);
  const provider=await loadDshProviderEnvironment(process.env);
  console.log('DSH model credential source:',provider.source);
  console.log('Checking local DSH headless in an isolated temporary workspace.');
  const started=Date.now();
  const result=await executeDshHeadless({
    instructions:'Respond with only this text: OPENDO_DSH_READY. Do not use tools or modify files.',
    deadline_at:Date.now()+90_000
  },{cwd,launch,env:provider.env});
  if(result.status!=='completed'||!result.output.includes('OPENDO_DSH_READY')){
    const details=result.stderr||'';
    if(/MISSING_CREDENTIAL|no API key|provider route/i.test(details))
      console.error('DSH headless is missing its MODEL provider API key. Set it in DSH Models or the local shell; never paste it into chat or Git.');
    else if(/permission|approval|sandbox/i.test(details))
      console.error('DSH headless permission or approval configuration rejected the task.');
    else console.error('DSH headless did not finish the expected simple task.');
    console.error('Local DSH preflight failed; elapsed '+(Date.now()-started)+'ms.');
    process.exitCode=1;
  }else{
    console.log('PASS: DSH headless answered successfully in '+(Date.now()-started)+'ms.');
  }
}catch(e){
  console.error('DSH preflight failed:',e?.message||String(e));
  process.exitCode=1;
}finally{
  if(cwd)await rm(cwd,{recursive:true,force:true});
}
