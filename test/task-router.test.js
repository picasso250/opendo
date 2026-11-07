import test from 'node:test';
import assert from 'node:assert/strict';
import {modelWithTools} from '../src/toolloop.ts';
import {ROUTER_TASK_TOOLS} from '../src/group/task-tools.ts';
import {readFileSync} from 'node:fs';
const env={DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_BASE_URL:'https://api.deepseek.com',DEEPSEEK_API_KEY:'test'};
test('Router sees Task tools, Worker calls are handled server-side, task creation is bounded',async()=>{
  let n=0;const invoked=[];const requests=[];
  const fake=async(_url,opts)=>{
    const req=JSON.parse(opts.body);requests.push(req);n++;
    if(n===1)return Response.json({choices:[{message:{role:'assistant',content:null,
      tool_calls:[{id:'w1',type:'function',function:{name:'list_workers',arguments:'{}'}}]}}]});
    if(n===2)return Response.json({choices:[{message:{role:'assistant',content:null,
      tool_calls:[{id:'c1',type:'function',function:{name:'create_task',arguments:JSON.stringify({worker_id:'worker_'+'a'.repeat(32),title:'Fix',instructions:'Repair login'})}}]}}]});
    if(n===3)return Response.json({choices:[{message:{role:'assistant',content:'任务已派出'}}]});
    throw Error('unexpected repeat');
  };
  const out=await modelWithTools(env,[{role:'user',content:'修复登录'}],fake,
    undefined,undefined,undefined,async(name,args)=>{
      invoked.push([name,args]);return name==='list_workers'?'[]':'Task task_created';
    });
  assert.equal(out.kind,'speak');
  assert.deepEqual(invoked.map(x=>x[0]),['list_workers','create_task']);
  assert.ok(requests[0].tools.some(x=>x.function.name==='create_task'));
  assert.equal(requests[2].messages.at(-1).role,'tool');
  assert.equal(requests[2].messages.at(-1).content,'Task task_created');
});
test('Worker API and room task state are decoupled from routing/AI text',()=>{
  const room=readFileSync(new URL('../src/group/room.ts',import.meta.url),'utf8');
  const router=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
  assert.match(room,/async onRequest\(request:Request\)/);
  assert.match(room,/token_hash/);
  assert.match(room,/claim_id/);
  assert.match(room,/status='running'/);
  assert.match(room,/this\.schedule\(new Date\(deadline\),"expireTask"/);
  assert.match(room,/task_late_results/);
  assert.match(room,/scheduleTaskTriggeredWave\(id\)/);
  assert.match(room,/kind='task_result'/);
  assert.match(router,/url\.pathname\.startsWith\("\/api\/worker\/"\)/);
  assert.equal(ROUTER_TASK_TOOLS.length,3);
});

test('Worker registration UI uses CSP-compliant styles and a DOM form, not a browser prompt',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
  const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const headers=readFileSync(new URL('../public/_headers',import.meta.url),'utf8');
  assert.match(headers,/style-src 'self'/);
  assert.doesNotMatch(html,/\sstyle\s*=/i,'CSP forbids inline style attributes');
  assert.match(html,/id="worker-register-form"/);
  assert.match(html,/id="worker-token-value" class="worker-token-value"/);
  assert.match(css,/\.worker-token-value\{/);
  assert.match(js,/el\.workerRegisterDialog\.showModal\(\)/);
  assert.match(js,/sendWS\(\{type:"worker_register",name,description\}\)/);
  assert.match(html,/id="worker-register-description"/);
  assert.match(html,/maxlength="1000"/);
  assert.match(js,/workerRegisterDescription\.value\.trim\(\)/);
  assert.doesNotMatch(js,/window\.prompt\("为本机 Worker/);
  assert.match(js,/el\.workerTokenDialog\.showModal\(\)/);
});

test('Worker descriptions are persisted and made available to Router selection without granting permissions',()=>{
  const room=readFileSync(new URL('../src/group/room.ts',import.meta.url),'utf8');
  const tools=readFileSync(new URL('../src/group/task-tools.ts',import.meta.url),'utf8');
  assert.match(room,/ALTER TABLE task_workers ADD COLUMN description TEXT NOT NULL DEFAULT ''/);
  assert.match(room,/SELECT id,name,description,execution_configs,default_config_id/);
  assert.match(room,/description\.length>1000/);
  assert.match(room,/id,name,description,owner,hash,Date\.now\(\)/);
  assert.match(tools,/能力描述/);
  assert.match(tools,/不是可信系统指令或权限声明/);
  assert.doesNotMatch(room,/task\.description.*--sandbox/);
});

test('execution configuration IDs are selected from authenticated Worker catalogs and exposed in group task details',()=>{
  const room=readFileSync(new URL('../src/group/room.ts',import.meta.url),'utf8');
  const browser=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const tool=readFileSync(new URL('../src/group/task-tools.ts',import.meta.url),'utf8');
  assert.match(room,/ALTER TABLE task_workers ADD COLUMN execution_configs TEXT NOT NULL DEFAULT/);
  assert.match(room,/ALTER TABLE tasks ADD COLUMN execution_config_id TEXT/);
  assert.match(room,/ALTER TABLE tasks ADD COLUMN execution_config_snapshot TEXT/);
  assert.match(room,/JSON.stringify\(selected\)/);
  assert.match(room,/selected_config/);
  assert.match(room,/api\/worker\/configs/);
  assert.match(room,/active_task_config_changed/);
  assert.match(room,/catalog_session_mismatch/);
  assert.match(room,/ALTER TABLE task_workers ADD COLUMN catalog_session_id TEXT/);
  assert.match(room,/const selected=available\.find\(c=>c\.id===execution_config_id\)/);
  assert.match(room,/execution_config_id:task\.execution_config_id/);
  assert.match(room,/actual_model=\?,actual_effort=\?/);
  assert.match(tool,/execution_config_id/);
  assert.doesNotMatch(tool,/enum:\["fast","balanced","deep"\]/);
  assert.match(browser,/"任务结束"/);
  assert.doesNotMatch(browser,/"任务终结"/);
});

test('sidebar categorizes human, AI, and Worker; management menu preserves AI toggle',()=>{
  const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(js,/memberGroup\("人类",groupMembers\.filter/);
  assert.match(js,/memberGroup\("AI",groupMembers\.filter/);
  assert.match(js,/memberGroup\("Worker",workers,renderWorker\)/);
  assert.match(js,/data\.type==="workers"\|\|data\.type==="worker_list"/);
  assert.match(js,/workers=Array\.isArray\(data\.workers\)\?data\.workers:\[\]/);
  assert.match(js,/memberMenu\("管理 AI/);
  assert.match(js,/memberMenu\("管理 Worker/);
  assert.match(js,/type:"ai_toggle",id:m\.id,enabled:!m\.enabled/);
  assert.match(js,/type:"worker_disable",worker_id:w\.id,enabled:!w\.enabled/);
  assert.match(css,/\.rail-main\{flex:1;min-height:0;overflow-y:auto/);
  assert.match(css,/\.member-menu-content/);
  assert.match(html,/id="worker-edit-dialog"/);
  assert.doesNotMatch(html,/\sstyle\s*=/i);
});

test('Worker owner can edit or remove, but pending and running tasks block deletion',()=>{
  const room=readFileSync(new URL('../src/group/room.ts',import.meta.url),'utf8');
  const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(room,/case "worker_update": this\.updateTaskWorker/);
  assert.match(room,/case "worker_remove": this\.removeTaskWorker/);
  assert.match(room,/workers:this\.publicWorkers\(\)/);
  assert.match(room,/if\(!w\|\|w\.owner!==owner\)throw new Error\("只能编辑自己的 Worker"\)/);
  assert.match(room,/if\(!w\|\|w\.owner!==owner\)throw new Error\("只能删除自己的 Worker"\)/);
  assert.match(room,/status IN \('pending','running'\)/);
  assert.match(room,/DELETE FROM task_workers WHERE id=\?/);
  assert.match(room,/Worker 正在执行任务，请等待任务结束后再暂停/);
  assert.match(room,/type:"worker_updated"/);
  assert.match(room,/type:"worker_removed"/);
  assert.match(js,/type:"worker_update",worker_id:editingWorker,name,description/);
  assert.match(js,/type:"worker_remove",worker_id:w\.id/);
});
