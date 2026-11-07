import test from 'node:test';
import assert from 'node:assert/strict';
import {taskCreation,taskResult,taskCardContent,parseExecutionConfigs,savedExecutionConfigs,
  TASK_DEADLINE_MS,TASK_LEASE_MS,TASK_HEARTBEAT_MS,TASK_POLL_MS} from '../src/group/task-contract.ts';
const wid='worker_'+'a'.repeat(32), tid='task_'+'b'.repeat(32), claim='12345678-1234-4123-8123-123456789abc';
test('task input is instructions only and deadline/lease are separate',()=>{
  assert.equal(TASK_DEADLINE_MS,30*60_000);
  assert.equal(TASK_LEASE_MS,5*60_000);
  assert.equal(TASK_HEARTBEAT_MS,2*60_000);
  assert.equal(TASK_POLL_MS,60_000);
  assert.deepEqual(taskCreation({worker_id:wid,title:' 修复登录 ',instructions:' 检查 WebSocket ',cwd:'C:/sensitive',command:'rm -rf /'}),
    {worker_id:wid,title:'修复登录',instructions:'检查 WebSocket',execution_config_id:null});
  assert.equal(taskCreation({worker_id:wid,title:'ok',instructions:'hi',execution_config_id:'glm-high'}).execution_config_id,'glm-high');
  assert.throws(()=>taskCreation({worker_id:wid,title:'ok',instructions:'hi',execution_config_id:'--model'}));
  assert.throws(()=>taskCreation({worker_id:'bad',title:'ok',instructions:'hi'}));
  assert.throws(()=>taskCreation({worker_id:wid,title:'ok',instructions:'x'.repeat(32001)}));
});
test('result is raw and immutable by contract; only three Worker terminal outcomes accepted',()=>{
  const output='\u0000原样保留\n```sh\necho ok\n```';
  assert.deepEqual(taskResult({task_id:tid,claim_id:claim,status:'completed',output}),
    {task_id:tid,claim_id:claim,status:'completed',output});
  assert.throws(()=>taskResult({task_id:tid,claim_id:claim,status:'timed_out',output}));
  assert.throws(()=>taskResult({task_id:tid,claim_id:claim,status:'completed',output:'x'.repeat(256001)}));
  assert.match(taskCardContent('created',{id:tid,title:'修复登录',worker_id:wid}),/任务书与原始结果/);
});

test('Worker advertises an arbitrary set of named model+effort combinations, not a global ladder',()=>{
  const input=[
    {id:'flash-low',label:'DeepSeek Flash / Low',harness:'WorkBuddy',model:'deepseek-flash',effort:'low',description:'简单后端修复'},
    {id:'hunyuan-high',label:'混元 4 / High',harness:'WorkBuddy',model:'hunyuan-4',effort:'high'},
    {id:'glm-custom',label:'GLM 项目维护',harness:'WorkBuddy',model:'glm-5.3',effort:null}
  ];
  const normalized=parseExecutionConfigs(input);
  assert.equal(normalized.length,3);
  assert.equal(normalized[0].description,'简单后端修复');
  assert.equal(normalized[1].description,'');
  assert.deepEqual(savedExecutionConfigs(JSON.stringify(normalized)),normalized);
  assert.deepEqual(savedExecutionConfigs('[]').map(x=>x.id),['default']);
  assert.throws(()=>parseExecutionConfigs([]));
  assert.throws(()=>parseExecutionConfigs([input[0],input[0]]));
  assert.throws(()=>parseExecutionConfigs([{...input[0],id:'../../etc'}]));
  assert.throws(()=>parseExecutionConfigs([{...input[0],model:'rm -rf /'}]));
  assert.throws(()=>parseExecutionConfigs([{...input[0],description:'x'.repeat(501)}]));
  assert.match(taskCardContent('created',{id:tid,worker_id:wid,title:'test',execution_config_id:'flash-low'}),/配置 flash-low/);
});
