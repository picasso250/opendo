/** Standalone DeepSeek Harness Worker client for OpenDo V1.
 * No Codex runner, model, shell or Cloudflare server changes are needed.
 * This process uses its own registered Worker token and a local DSH installation.
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {DSH_CATALOG,executeDshHeadless,resolveDshLaunch} from './dsh-headless.mjs';

const env=process.env;
const url=(env.DSGO_DSH_URL||'https://chat.io99.xyz').replace(/\/$/,'');
const token=env.DSGO_DSH_WORKER_TOKEN||'';
const cwd=env.DSGO_DSH_WORKDIR||'';
const stateDir=resolve(env.DSGO_DSH_STATE_DIR||'.dsh-runner-state');
const pollMs=60_000,heartbeatMs=120_000;
if(!/^worker_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)){
  console.error('Register a separate DSH Worker in OpenDo and set DSGO_DSH_WORKER_TOKEN locally.');
  process.exit(2);
}
if(!cwd||!isAbsolute(cwd)){
  console.error('Set DSGO_DSH_WORKDIR to an explicit trusted absolute directory.');
  process.exit(2);
}
if(!/^https:\/\//.test(url)&&!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(url)){
  console.error('DSGO_DSH_URL must be HTTPS, or an isolated local localhost HTTP URL.');
  process.exit(2);
}
let launch;
try{launch=resolveDshLaunch(env)}catch(e){console.error(e.message);process.exit(2)}

async function request(action,body={}){
  const res=await fetch(url+'/api/worker/'+action,{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(25_000),redirect:'error'
  });
  let data;try{data=await res.json()}catch{throw Error(action+': unexpected non-JSON server response')}
  if(!res.ok){
    const err=Error('Worker '+action+' HTTP '+res.status+': '+String(data.error||'request_failed'));
    err.status=res.status;err.code=data.error;
    throw err;
  }
  return data;
}

async function executeAndComplete(task){
  if(!/^task_[a-f0-9]{32}$/.test(String(task?.id)))throw Error('Invalid Task ID');
  const taskDir=resolve(stateDir,task.id);
  await mkdir(taskDir,{recursive:true});
  await writeFile(resolve(taskDir,'task.txt'),task.instructions,'utf8');
  let heartbeatBusy=false;
  const heartbeat=setInterval(async()=>{
    if(heartbeatBusy)return;
    heartbeatBusy=true;
    try{await request('heartbeat',{task_id:task.id,claim_id:task.claim_id})}
    catch(e){console.error('Heartbeat for',task.id,':',e.message)}
    finally{heartbeatBusy=false}
  },heartbeatMs);
  let report;
  try{
    if(task.execution_config_id!==null&&task.execution_config_id!=='dsh-default')
      throw Error('Unsupported execution_config_id: '+String(task.execution_config_id));
    console.log('Executing',task.id,'with local DSH headless profile in',cwd);
    report=await executeDshHeadless(task,{cwd,launch,env});
  }catch(e){report={status:'failed',output:'[DSH Runner error] '+String(e.message),stderr:''}}
  finally{clearInterval(heartbeat)}
  await writeFile(resolve(taskDir,'result.txt'),report.output,'utf8');
  if(report.stderr)await writeFile(resolve(taskDir,'diagnostics.txt'),report.stderr,'utf8');
  // The server should receive only the original result or an explicit failure,
  // never stderr reasoning, local logs, private tokens or a truncated success.
  const {stderr:_privateDiagnostics,...visible}=report;
  const response=await request('complete',{
    task_id:task.id,claim_id:task.claim_id,...visible
  });
  console.log(task.id,'=>',response.status,response.late?'(late result)':'');
}

// Fail closed before announcing an available Worker: a desktop install alone
// does not imply the headless model credential is present. A short preflight
// prevents claiming live Tasks only to fail with MISSING_CREDENTIAL.
try{
  const verified=await executeDshHeadless({
    instructions:'Reply with only OPENDO_DSH_READY. Do not call tools or change files.',
    deadline_at:Date.now()+90_000
  },{cwd,launch,env});
  if(verified.status!=='completed'||!verified.output.includes('OPENDO_DSH_READY')){
    const reason=/MISSING_CREDENTIAL|no API key|provider route/i.test(verified.stderr||'')
      ?'missing model API key in headless DSH'
      :'headless smoke did not return the expected result';
    throw Error(reason);
  }
}catch(err){
  console.error('Refusing to register DSH Worker: preflight failed ('+err.message+').');
  console.error('Set up DSH Models or a local model API key and retry; no Task was claimed.');
  process.exit(2);
}
await mkdir(stateDir,{recursive:true});
console.log('DSH Runner preflight passed; starting Worker polling every',pollMs/1000,'seconds.');
let session=null;
let stopping=false;
process.on('SIGINT',()=>{stopping=true});
process.on('SIGTERM',()=>{stopping=true});
while(!stopping){
  try{
    if(!session){
      const response=await request('configs',DSH_CATALOG);
      session=response.catalog_session_id;
      if(!session)throw Error('Missing catalog_session_id in server response');
      console.log('Published configuration: dsh-default; DSH CLI is local and independent of Codex.');
    }
    const response=await request('claim',{catalog_session_id:session});
    if(response.task)await executeAndComplete(response.task);
    else if(response.busy)console.log('A previous DSH claim is running; not re-executing.');
  }catch(e){
    console.error('DSH Runner:',e.message);
    if(e.status===401||e.code==='catalog_session_mismatch'){
      console.error('Stopped: invalid Worker token or competing Runner session.');
      process.exitCode=1;break;
    }
  }
  if(!stopping)await new Promise(done=>setTimeout(done,pollMs));
}
console.log('DSH Runner stopped.');
