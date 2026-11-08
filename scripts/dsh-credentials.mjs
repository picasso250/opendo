/** Resolve a DSH model credential without placing the secret in Git or logs.
 * An explicitly provided environment key wins; otherwise load the user's
 * private ~/.deepseek.key file. Never mutate process.env.
 */
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function loadDshProviderEnvironment(env=process.env,{
  readFileImpl=readFile,home=homedir()
}={}){
  if(typeof env.DEEPSEEK_API_KEY==='string'&&env.DEEPSEEK_API_KEY.trim())
    return {env:{...env},source:'environment'};
  const filename=env.DSGO_DSH_KEY_FILE
    ?resolve(env.DSGO_DSH_KEY_FILE)
    :join(home,'.deepseek.key');
  let content;
  try{
    content=await readFileImpl(filename,'utf8');
  }catch(err){
    if(err?.code==='ENOENT')
      return {env:{...env},source:'missing'};
    // Existing but unreadable credential files must not be silently ignored.
    throw Error('Cannot read local DSH credential file: '+String(err?.code||'read_error'));
  }
  const key=content.trim();
  if(key.length<20||key.length>1024||/\s/.test(key))
    throw Error('Local DSH credential file must contain one nonempty API key only');
  return {env:{...env,DEEPSEEK_API_KEY:key},source:'local-file'};
}

/** Keep Worker auth independent from the model provider key. Explicit
 * DSGO_DSH_WORKER_TOKEN takes priority over gitignored local registration.
 */
export async function loadDshWorkerToken(env=process.env,{
  readFileImpl=readFile,
  localPath=fileURLToPath(new URL('../.dsh-worker.local.json',import.meta.url))
}={}){
  let token=typeof env.DSGO_DSH_WORKER_TOKEN==='string'
    ?env.DSGO_DSH_WORKER_TOKEN.trim():'';
  let source='environment';
  if(!token){
    source='local-file';
    const filename=env.DSGO_DSH_WORKER_FILE
      ?resolve(env.DSGO_DSH_WORKER_FILE):localPath;
    let parsed;
    try{parsed=JSON.parse(await readFileImpl(filename,'utf8'))}
    catch(e){
      if(e?.code==='ENOENT')throw Error('DSH Worker token missing: register a separate Worker first');
      throw Error('Cannot read DSH Worker local config');
    }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
      throw Error('Invalid DSH Worker local config');
    token=parsed.token;
    if(typeof parsed.worker_id==='string' && token?.split('.')[0]!==parsed.worker_id)
      throw Error('DSH Worker ID/token mismatch in local config');
  }
  if(typeof token!=='string'||!/^worker_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token))
    throw Error('Invalid DSH Worker token; register it separately from Codex');
  return {token,source};
}
