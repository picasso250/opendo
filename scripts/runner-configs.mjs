/** The local Codex harness maps stable execution IDs to concrete CLI settings.
 * The server/Router sees only metadata; only this file can form Codex argv.
 * Another harness (e.g. WorkBuddy) can publish its own catalog with the same
 * HTTP protocol without pretending that all models fit a fast/deep scale.
 */
const DEFAULT_CONFIG = Object.freeze({
  id:'default',label:'Codex 默认',description:'沿用本机 Codex 配置的模型与思考等级',
  harness:'Codex',model:null,effort:null
});
const EFFORTS = new Set(['minimal','low','medium','high','xhigh']);
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const modelPattern=/^[a-zA-Z0-9_.:/-]{1,120}$/;

export function loadExecutionConfigs(json,defaultId){
  let input;
  if(json===undefined||json==='')input=[DEFAULT_CONFIG];
  else{
    try{input=JSON.parse(json)}catch{throw Error('DSGO_EXECUTION_CONFIGS must be valid JSON')}
  }
  if(!Array.isArray(input)||input.length<1||input.length>20)
    throw Error('DSGO_EXECUTION_CONFIGS must be an array of 1..20 configs');
  const used=new Set();
  const configs=input.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid execution config');
    if(Object.keys(entry).some(key=>!['id','label','description','harness','model','effort'].includes(key)))
      throw Error('Unrecognized execution config option');
    const {id,label,description='',harness='Codex',model=null,effort=null}=entry;
    if(typeof id!=='string'||!idPattern.test(id)||used.has(id))throw Error('Invalid or duplicate config id');
    used.add(id);
    if(typeof label!=='string'||!label.trim()||label.length>80||
       typeof description!=='string'||description.length>500)
      throw Error('Invalid config label/description');
    if(harness!=='Codex')throw Error('This Runner runs Codex only; use another adapter for '+harness);
    if(model!==null && (typeof model!=='string'||!modelPattern.test(model)))
      throw Error('Invalid Codex model ID for '+id);
    if(effort!==null && !EFFORTS.has(effort))throw Error('Invalid Codex reasoning effort for '+id);
    return {id,label:label.trim(),description:description.trim(),harness,model,effort};
  });
  const selected=defaultId||configs[0].id;
  if(typeof selected!=='string'||!used.has(selected))throw Error('DSGO_DEFAULT_EXECUTION_CONFIG_ID is not advertised');
  return {configs,defaultId:selected};
}
export function selectExecutionConfig(task,local){
  const id=task.execution_config_id??local.defaultId; // existing legacy tasks
  const config=local.configs.find(c=>c.id===id);
  if(!config)throw Error('Worker does not support assigned execution_config_id: '+String(id));
  return config;
}
export function codexArgsForConfig(config){
  return [...(config.model?['--model',config.model]:[]),
    ...(config.effort?['--config',`model_reasoning_effort="${config.effort}"`]:[])];
}
