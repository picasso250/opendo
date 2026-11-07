import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  resolveDshLaunch,dshChildEnvironment,executeDshHeadless,DSH_CATALOG
} from '../scripts/dsh-headless.mjs';
import {readFileSync} from 'node:fs';

const fixture=fileURLToPath(new URL('./fixtures/fake-dsh-headless.mjs',import.meta.url));
const fakeLaunch={command:process.execPath,prefix:[fixture],electron:false};
const task=input=>({instructions:input,deadline_at:Date.now()+10_000});

test('Windows Desktop bundle can be used without PATH, shell or npm install',()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-path-'));
  try{
    mkdirSync(join(temp,'resources'));
    writeFileSync(join(temp,'DeepSeek Harness.exe'),'');
    writeFileSync(join(temp,'resources','app.asar'),'');
    const launch=resolveDshLaunch({DSGO_DSH_INSTALL_DIR:temp},'win32');
    assert.equal(launch.command,join(temp,'DeepSeek Harness.exe'));
    assert.ok(launch.prefix.includes('--expose-internals'));
    assert.ok(launch.prefix[1].replaceAll(String.fromCharCode(92),'/').endsWith('/dsh-desktop-host/lib/cli.js'));
    assert.equal(launch.electron,true);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('Runner keeps credentials separate; child cannot inherit OpenDo bearer or admin secrets',()=>{
  const env={DSGO_DSH_WORKER_TOKEN:'SECRET',DSGO_WORKER_TOKEN:'OTHERTOKEN',
    GH_TOKEN:'PRIVATE',CLOUDFLARE_API_TOKEN:'PRIVATE',
    DEEPSEEK_API_KEY:'test-provider-key',DSH_PERMISSION_MODE:'danger-full-access',
    Path:'C:\Windows'};
  const child=dshChildEnvironment(env);
  assert.equal(child.DSGO_DSH_WORKER_TOKEN,undefined);
  assert.equal(child.DSGO_WORKER_TOKEN,undefined);
  assert.equal(child.GH_TOKEN,undefined);
  assert.equal(child.CLOUDFLARE_API_TOKEN,undefined);
  assert.equal(child.DEEPSEEK_API_KEY,'test-provider-key');
  assert.equal(child.DSH_PERMISSION_MODE,'workspace-write');
  assert.equal(child.Path,'C:\Windows');
});

test('DSH stdout is returned byte-for-byte and Task is passed on stdin only',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-exec-'));
  try{
    const r=await executeDshHeadless(task('hello world'),{cwd:temp,launch:fakeLaunch,
      env:{...process.env,DSGO_DSH_WORKER_TOKEN:'SENSITIVE',DSH_PERMISSION_MODE:'danger-full-access'}});
    assert.equal(r.status,'completed');
    assert.equal(r.output,'OUT<hello world>\nNO_WORKER_TOKEN\nworkspace-write\n');
    assert.equal(r.actual_model,null);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('failed DSH exit cannot become success even if stderr contains diagnostics',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-fail-'));
  try{
    const r=await executeDshHeadless(task('FAIL'),{cwd:temp,launch:fakeLaunch});
    assert.equal(r.status,'failed');
    assert.match(r.output,/exited with code 1/);
    assert.equal(r.stderr,'local fake diagnostic');
    assert.doesNotMatch(r.output,/local fake diagnostic/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('oversized DSH output fails instead of claiming truncated success',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-big-'));
  try{
    const r=await executeDshHeadless(task('OVERSIZE'),{cwd:temp,launch:fakeLaunch});
    assert.equal(r.status,'failed');
    assert.match(r.output,/exceeded 256000/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('deadline limits execution and no expired Task starts',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-timeout-'));
  try{
    const r=await executeDshHeadless({instructions:'DELAY',deadline_at:Date.now()+90},{cwd:temp,launch:fakeLaunch});
    assert.equal(r.status,'failed');
    assert.match(r.output,/deadline/);
    await assert.rejects(()=>executeDshHeadless({instructions:'no',deadline_at:Date.now()-1},
      {cwd:temp,launch:fakeLaunch}),/deadline already passed/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('OpenDo DSH integration does not depend on the Codex runner or change the Worker protocol',()=>{
  const source=readFileSync(new URL('../scripts/dsh-runner.mjs',import.meta.url),'utf8');
  const helper=readFileSync(new URL('../scripts/dsh-headless.mjs',import.meta.url),'utf8');
  assert.equal(DSH_CATALOG.default_config_id,'dsh-default');
  assert.equal(DSH_CATALOG.configs[0].harness,'DeepSeek Harness');
  assert.equal(DSH_CATALOG.configs[0].model,null);
  assert.match(source,/DSGO_DSH_WORKER_TOKEN/);
  assert.match(source,/catalog_session_id/);
  assert.match(source,/request\('heartbeat'/);
  assert.match(source,/request\('complete'/);
  assert.match(source,/Refusing to register DSH Worker: preflight failed/);
  assert.match(source,/Invalid Task ID/);
  assert.match(helper,/shell:false/);
  assert.match(helper,/--permission-mode','workspace-write'/);
  assert.match(helper,/--approval-policy','never'/);
});
