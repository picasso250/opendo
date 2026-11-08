/** DeepSeek Harness headless adapter: a *local* executable, never task-supplied argv. */
import {spawn as nodeSpawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

export const DSH_DEFAULT_CONFIG=Object.freeze({
  id:'dsh-default',label:'DSH · 本机默认',
  description:'使用已安装的 DeepSeek Harness headless profile 与本机模型设置',
  harness:'DeepSeek Harness',model:null,effort:null
});
export const DSH_CATALOG=Object.freeze({
  configs:[DSH_DEFAULT_CONFIG],default_config_id:'dsh-default'
});

/** On Windows the Desktop install bundles a working CLI even if dsh is not in PATH.
 * Execute the Electron runtime directly with ELECTRON_RUN_AS_NODE=1 and shell:false.
 * The app.asar CLI path is virtual (so existsSync(cli) is false); app.asar itself exists.
 */
export function resolveDshLaunch(env=process.env,platform=process.platform){
  if(platform==='win32'){
    const root=env.DSGO_DSH_INSTALL_DIR
      ?resolve(env.DSGO_DSH_INSTALL_DIR)
      :join(env.LOCALAPPDATA||'', 'Programs','DeepSeek Harness');
    const command=join(root,'DeepSeek Harness.exe');
    const asar=join(root,'resources','app.asar');
    if(!existsSync(command)||!existsSync(asar))
      throw Error('DeepSeek Harness Desktop runtime not found; check DSGO_DSH_INSTALL_DIR');
    const cli=join(asar,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
    return {command,prefix:['--expose-internals',cli],electron:true};
  }
  return {command:env.DSGO_DSH_COMMAND||'dsh',prefix:[],electron:false};
}

// OpenDo MVP: the local DSH Runner defaults to full access. This is a
// local host choice, never taken from Router Task instructions.
export const dshPermissionMode=(env=process.env)=>
  env.DSGO_DSH_MODE==='workspace-write'?'workspace-write':'danger-full-access';

export function dshChildEnvironment(env=process.env,electron=true){
  // Least-privilege inheritance: only OS essentials, network proxy options,
  // DSH profile location and intentionally configured model-provider keys.
  // In particular, an OpenDo Worker bearer or Cloudflare/GitHub credential
  // must never be passed into a remotely instructed local coding process.
  const allowed=/^(?:PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ProgramFiles|ProgramFiles\(x86\)|ProgramData|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|LC_CTYPE|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|DSH_HOME|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|ZAI_API_KEY|ZAI_CODING_CN_API_KEY)$/i;
  const clean=Object.fromEntries(Object.entries(env).filter(([key])=>allowed.test(key)));
  // CLI and environment use the same locally selected execution preset.
  clean.DSH_PERMISSION_MODE=dshPermissionMode(env);
  clean.DSH_TOOLS_MODE='native';
  if(electron)clean.ELECTRON_RUN_AS_NODE='1';
  return clean;
}

export async function executeDshHeadless(task,{cwd,launch=resolveDshLaunch(),
  env=process.env,maxResult=256_000,spawnImpl=nodeSpawn}={}){
  if(typeof cwd!=='string'||!cwd||!existsSync(cwd))throw Error('Missing local DSH work directory');
  if(!task||typeof task.instructions!=='string'||!task.instructions.trim())throw Error('Missing Task text');
  const remaining=task.deadline_at-Date.now();
  if(!Number.isSafeInteger(task.deadline_at)||remaining<=0)throw Error('Task deadline already passed');

  const args=[...launch.prefix,'--profile','headless',
    '--permission-mode',dshPermissionMode(env),'--approval-policy','never','-'];
  const child=spawnImpl(launch.command,args,{cwd,env:dshChildEnvironment(env,launch.electron),
    windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',overflow=false,deadlineHit=false;
  const stdoutDecoder=new StringDecoder('utf8');
  const stderrDecoder=new StringDecoder('utf8');
  const append=(current,value,max)=>current.length+value.length>max
    ?current+value.slice(0,Math.max(0,max-current.length)):current+value;
  const stopChild=()=>{
    if(process.platform==='win32'&&child.pid){
      // DSH may start descendant tool processes. Kill the entire owned tree on
      // timeout, not just the Electron Node host. No untrusted argv involved.
      const killer=nodeSpawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{
        windowsHide:true,shell:false,stdio:'ignore'
      });
      killer.on('error',()=>child.kill());
    }else child.kill();
  };
  const ended=new Promise((done)=>{
    let resolved=false;
    const finish=(value)=>{if(!resolved){resolved=true;done(value)}};
    child.on('error',e=>finish({code:-1,error:String(e.message)}));
    child.on('close',(code,signal)=>finish({code:code??-1,signal}));
  });
  child.stdout.on('data',chunk=>{
    const piece=stdoutDecoder.write(chunk);
    if(stdout.length+piece.length>maxResult&&!overflow){overflow=true;stopChild()}
    stdout=append(stdout,piece,maxResult+1);
  });
  child.stderr.on('data',chunk=>{
    stderr=append(stderr,stderrDecoder.write(chunk),128_000)
  });
  const timer=setTimeout(()=>{deadlineHit=true;stopChild()},remaining);
  child.stdin.on('error',()=>{}); // Child may terminate before stdin is consumed.
  child.stdin.end(task.instructions,'utf8');
  const outcome=await ended;
  clearTimeout(timer);
  stdout=append(stdout,stdoutDecoder.end(),maxResult+1);
  stderr=append(stderr,stderrDecoder.end(),128_000);
  if(deadlineHit)return {status:'failed',output:'[DSH Runner error] Task exceeded its deadline.',stderr};
  if(overflow)return {status:'failed',output:'[DSH Runner error] Original output exceeded 256000 characters; refused to truncate.',stderr};
  if(outcome.error)return {status:'failed',output:'[DSH Runner error] Could not launch DSH: '+outcome.error,stderr};
  if(outcome.code!==0)return {status:'failed',output:'[DSH Runner error] DSH headless exited with code '+outcome.code+'. See local diagnostics.',stderr};
  if(!stdout.trim())return {status:'failed',output:'[DSH Runner error] DSH returned no final answer.',stderr};
  return {status:stdout.trimStart().startsWith('[TASK_REFUSED]')?'refused':'completed',
    output:stdout,actual_model:null,actual_effort:null,stderr};
}
