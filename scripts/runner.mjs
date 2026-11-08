/** Minimal local Task Runner. It polls only its assigned tasks, starts one
 * Codex process, and faithfully reports the final output. No chat access.
 * All execution permissions and directories are configured LOCAL to this host.
 */
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {loadExecutionConfigs,selectExecutionConfig,codexArgsForConfig} from './runner-configs.mjs';
const url=(process.env.DSGO_URL||'https://chat.io99.xyz').replace(/\/$/,'');
const token=process.env.DSGO_WORKER_TOKEN||'';
const cwd=process.env.DSGO_WORKDIR?resolve(process.env.DSGO_WORKDIR):'';
const pollMs=60_000,heartbeatMs=120_000,maxResult=256_000;
const directory=resolve(process.env.DSGO_RUNNER_STATE||'.runner-state');
// Local, persistent model catalog. The chat Task never supplies CLI flags.
// Environment variables still override the file for temporary experiments.
const configFile=new URL('../runner.local.json',import.meta.url);
let fileSettings={};
try {
  const parsed=JSON.parse(await readFile(configFile,'utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw Error('Root must be a JSON object');
  if(Object.keys(parsed).some(k=>!['configs','default_config_id'].includes(k)))
    throw Error('Unknown option in runner.local.json');
  fileSettings=parsed;
} catch (err) {
  if(err?.code!=='ENOENT')throw Error('Invalid runner.local.json: '+String(err?.message||err));
}
const catalogJson=process.env.DSGO_EXECUTION_CONFIGS ||
  (fileSettings.configs===undefined?undefined:JSON.stringify(fileSettings.configs));
const defaultConfigId=process.env.DSGO_DEFAULT_EXECUTION_CONFIG_ID || fileSettings.default_config_id;
const localConfigs=loadExecutionConfigs(catalogJson,defaultConfigId);
// OpenDo MVP: unsandboxed Codex by default. DSGO_YOLO=0 opts back into workspace-write.
const allowYolo=process.env.DSGO_YOLO!=='0';
let addDirs=[];
try{addDirs=JSON.parse(process.env.DSGO_ADD_DIRS||'[]')}catch{}
if(!/^worker_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token) || !cwd ||
  !Array.isArray(addDirs)||addDirs.some(x=>typeof x!=='string'||!x.trim())){
  console.error('Configure DSGO_WORKER_TOKEN, DSGO_WORKDIR and optional DSGO_ADD_DIRS (JSON array).');
  process.exit(2);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(action,body={}){
  const response=await fetch(url+'/api/worker/'+action,{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(25_000)});
  let payload;try{payload=await response.json()}catch{throw Error('Non-JSON worker API response')}
  if(!response.ok)throw Error('Worker API '+action+' HTTP '+response.status+': '+String(payload.error||'request_failed'));
  return payload;
}
async function execute(task){
  const taskDir=join(directory,task.id);
  await mkdir(taskDir,{recursive:true});
  await writeFile(join(taskDir,'task.txt'),task.instructions,'utf8');
  const finalPath=join(taskDir,'final.txt');
  const config=selectExecutionConfig(task,localConfigs);
  const args=['exec','-C',cwd,'--output-last-message',finalPath,...codexArgsForConfig(config)];
  if(allowYolo)args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox','workspace-write');
  for(const dir of addDirs)args.push('--add-dir',resolve(dir));
  args.push(task.instructions);
  console.log('Running',task.id,'execution config',config.id,
    'model',config.model||'(Codex local default)','effort',config.effort||'(Codex local default)',
    'sandbox',allowYolo?'YOLO (unsandboxed)':'workspace-write');
  // Windows npm installs codex.cmd (a shell shim). spawn(shell:false) cannot
  // execute a .cmd file. Launch the underlying JS via node.exe instead, while
  // keeping shell:false so Task text cannot be interpreted by a host shell.
  let command=process.env.DSGO_CODEX_COMMAND||'codex';
  if(process.platform==='win32'&&!process.env.DSGO_CODEX_COMMAND){
    const entry=join(process.env.APPDATA||'', 'npm','node_modules','@openai','codex','bin','codex.js');
    if(!existsSync(entry))throw Error('Codex CLI JS entry not found: '+entry);
    command=process.execPath;
    args.unshift(entry);
  }
  const child=spawn(command,args,{cwd,windowsHide:true,
    env:process.env,shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>maxResult)stdout=stdout.slice(-maxResult)});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>maxResult)stderr=stderr.slice(-maxResult)});
  const cutoff=Math.max(1_000,task.deadline_at-Date.now());
  const kill=setTimeout(()=>child.kill('SIGTERM'),cutoff);
  const heartbeat=setInterval(()=>request('heartbeat',{task_id:task.id,claim_id:task.claim_id})
    .catch(err=>console.error('Heartbeat:',err.message)),heartbeatMs);
  const outcome=await new Promise(resolve=>{
    child.on('error',err=>resolve({code:-1,error:String(err.message)}));
    child.on('exit',(code,signal)=>resolve({code:code??-1,signal}));
  });
  clearInterval(heartbeat);clearTimeout(kill);
  let output='';
  try{output=await readFile(finalPath,'utf8')}catch{}
  if(!output)output=stdout||stderr||JSON.stringify(outcome);
  // Keep the raw final answer, including whitespace; refuse oversize rather
  // than silently changing/truncating the Worker output.
  await writeFile(join(taskDir,'reported.txt'),output,'utf8');
  if(output.length>maxResult)throw Error('Worker output exceeds 256000 characters; stored locally, not sent as altered text');
  const status=output.startsWith('[TASK_REFUSED]')?'refused':outcome.code===0?'completed':'failed';
  return {status,output,actual_model:config.model,actual_effort:config.effort};
}
await mkdir(directory,{recursive:true});
console.log('Runner ready; poll interval',pollMs/1000,'seconds.');
let catalogSessionId=null;
for(;;){
  try{
    if(!catalogSessionId){
      const published=await request('configs',{configs:localConfigs.configs,
        default_config_id:localConfigs.defaultId});
      if(!published.catalog_session_id)throw Error('Worker server did not return a catalog session');
      catalogSessionId=published.catalog_session_id;
      console.log('Execution configs advertised:',localConfigs.configs.map(c=>c.id).join(', '),
        'default:',localConfigs.defaultId);
    }
    const {task,busy}=await request('claim',{catalog_session_id:catalogSessionId});
    if(task){
      let report;
      try{report=await execute(task)}catch(err){
        report={status:'failed',output:'[Runner execution error] '+String(err.message)};
      }
      const answer=await request('complete',{task_id:task.id,claim_id:task.claim_id,...report});
      console.log(task.id,'=>',answer.status,answer.late?'(late result)':'');
    }else if(busy){
      console.log('Worker has a previous active claim; no automatic duplicate execution.');
    }
  }catch(err){console.error('Poll:',err.message)}
  await sleep(pollMs);
}
