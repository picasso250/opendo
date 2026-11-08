import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {loadExecutionConfigs,selectExecutionConfig,codexArgsForConfig} from '../scripts/runner-configs.mjs';

test('legacy/default Codex configuration preserves the previous command-line behavior',()=>{
  const local=loadExecutionConfigs();
  assert.equal(local.defaultId,'default');
  assert.equal(local.configs.length,1);
  const selected=selectExecutionConfig({},local);
  assert.equal(selected.model,null);
  assert.equal(selected.effort,null);
  assert.deepEqual(codexArgsForConfig(selected),[]);
});
test('locally configured execution IDs can select arbitrary models and reasoning levels',()=>{
  const local=loadExecutionConfigs(JSON.stringify([
    {id:'default',label:'机器默认',harness:'Codex'},
    {id:'codex-small',label:'Fast Rust',harness:'Codex',model:'gpt-5.3-codex',effort:'low',description:'便宜的明确小任务'},
    {id:'codex-deep',label:'审慎工程',harness:'Codex',model:'gpt-5.3-codex',effort:'high'}
  ]),'codex-deep');
  assert.equal(selectExecutionConfig({},local).id,'codex-deep');
  assert.deepEqual(codexArgsForConfig(selectExecutionConfig({execution_config_id:'codex-small'},local)),
    ['--model','gpt-5.3-codex','--config','model_reasoning_effort="low"']);
  assert.throws(()=>selectExecutionConfig({execution_config_id:'cannot-run'},local));
  assert.throws(()=>loadExecutionConfigs('[]'));
  assert.throws(()=>loadExecutionConfigs('not-json'));
  assert.throws(()=>loadExecutionConfigs(JSON.stringify([{id:'foo',label:'Model',harness:'WorkBuddy'}])));
  assert.throws(()=>loadExecutionConfigs(JSON.stringify([{id:'foo',label:'Model',harness:'Codex',effort:'ultra'}])));
  assert.throws(()=>loadExecutionConfigs(JSON.stringify([{id:'foo',label:'Model',harness:'Codex',sandbox:'danger-full-access'}])));
  assert.throws(()=>loadExecutionConfigs(JSON.stringify([{id:'foo',label:'Model',harness:'Codex',model:'sh -c x'}])));
});

test('local and example catalogs have exactly Terra, Sol, Astra with High reasoning',()=>{
  const example=JSON.parse(readFileSync(new URL('../runner.example.json',import.meta.url),'utf8'));
  // Local config is deliberately Git-ignored, so CI and clean clones do not
  // have it. If present, verify it without making tests depend on the host.
  const localPath=new URL('../runner.local.json',import.meta.url);
  if(existsSync(localPath)){
    const local=JSON.parse(readFileSync(localPath,'utf8'));
    assert.deepEqual(local,example,'the installed local setup matches the tracked example');
  }
  const parsed=loadExecutionConfigs(JSON.stringify(example.configs),example.default_config_id);
  assert.equal(parsed.defaultId,'sol');
  assert.deepEqual(parsed.configs.map(x=>[x.id,x.model,x.effort]),[
    ['terra','gpt-6.1-terra','high'],
    ['sol','gpt-6.1-sol','high'],
    ['astra','gpt-6-astra','high']
  ]);
  for(const config of parsed.configs){
    assert.equal(config.harness,'Codex');
    assert.deepEqual(codexArgsForConfig(config),[
      '--model',config.model,'--config','model_reasoning_effort="high"'
    ]);
  }
  assert.equal(selectExecutionConfig({},parsed).id,'sol');
  assert.throws(()=>selectExecutionConfig({execution_config_id:'luna'},parsed));
});

test('OpenDo MVP Codex Runner defaults to YOLO with a local opt-out',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../scripts/runner.mjs',import.meta.url),'utf8');
  assert.match(source,/const allowYolo=process\.env\.DSGO_YOLO!=='0'/);
  assert.match(source,/--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(source,/DSGO_CONFIRM_YOLO/);
});
