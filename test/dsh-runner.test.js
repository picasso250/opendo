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
import {loadDshProviderEnvironment,loadDshWorkerToken} from '../scripts/dsh-credentials.mjs';

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
  assert.match(source,/loadDshWorkerToken/);
  assert.match(source,/catalog_session_id/);
  assert.match(source,/request\('heartbeat'/);
  assert.match(source,/request\('complete'/);
  assert.match(source,/Refusing to register DSH Worker: preflight failed/);
  assert.match(source,/Invalid Task ID/);
  assert.match(helper,/shell:false/);
  assert.match(helper,/--permission-mode','workspace-write'/);
  assert.match(helper,/--approval-policy','never'/);
});

test('load DSH provider key from a private home file without mutating caller env',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-key-'));
  try{
    const key='test-deepseek-key-do-not-use-outside-tests';
    writeFileSync(join(temp,'.deepseek.key'),key+'\r\n');
    const original={DSGO_DSH_WORKER_TOKEN:'worker-secret'};
    const result=await loadDshProviderEnvironment(original,{home:temp});
    assert.equal(result.source,'local-file');
    assert.equal(result.env.DEEPSEEK_API_KEY,key);
    assert.equal(original.DEEPSEEK_API_KEY,undefined);
    const child=dshChildEnvironment(result.env);
    assert.equal(child.DEEPSEEK_API_KEY,key);
    assert.equal(child.DSGO_DSH_WORKER_TOKEN,undefined);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('explicit model key wins over ~/.deepseek.key without reading it',async()=>{
  const result=await loadDshProviderEnvironment(
    {DEEPSEEK_API_KEY:'explicit-key-that-is-not-a-real-key'},
    {home:'nonexistent-private-dir',readFileImpl:async()=>{throw Error('should not read file')}}
  );
  assert.equal(result.source,'environment');
  assert.equal(result.env.DEEPSEEK_API_KEY,'explicit-key-that-is-not-a-real-key');
});

test('missing or malformed private key is handled without exposing contents',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-bad-key-'));
  try{
    const missing=await loadDshProviderEnvironment({},{home:temp});
    assert.equal(missing.source,'missing');
    assert.equal(missing.env.DEEPSEEK_API_KEY,undefined);
    writeFileSync(join(temp,'.deepseek.key'),'a b\nline two');
    await assert.rejects(()=>loadDshProviderEnvironment({},{home:temp}),/one nonempty API key only/);
    const named=join(temp,'custom-key-file');
    writeFileSync(named,'long-single-token-that-is-not-a-secret');
    const explicit=await loadDshProviderEnvironment({DSGO_DSH_KEY_FILE:named},{home:temp});
    assert.equal(explicit.source,'local-file');
    assert.equal(explicit.env.DEEPSEEK_API_KEY,'long-single-token-that-is-not-a-secret');
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('DSH Worker token loads from gitignored local file without leaking into provider env',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-worker-secret-'));
  try{
    const workerId='worker_'+'a'.repeat(32);
    const token=workerId+'.'+'b'.repeat(64);
    const path=join(temp,'worker.json');
    writeFileSync(path,JSON.stringify({worker_id:workerId,token}));
    const r=await loadDshWorkerToken({}, {localPath:path});
    assert.equal(r.token,token);
    assert.equal(r.source,'local-file');
    assert.equal(dshChildEnvironment({...process.env,DSGO_DSH_WORKER_TOKEN:r.token}).DSGO_DSH_WORKER_TOKEN,undefined);
    const s=await loadDshWorkerToken({DSGO_DSH_WORKER_TOKEN:token},{localPath:'not-used'});
    assert.equal(s.source,'environment');
    assert.equal(s.token,token);
  }finally{rmSync(temp,{recursive:true,force:true})}
});

test('DSH Worker local token rejects mismatched ID and secrets',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'opendo-dsh-worker-invalid-'));
  try{
    const path=join(temp,'bad.json');
    writeFileSync(path,JSON.stringify({worker_id:'worker_'+'a'.repeat(32),token:'not-a-token'}));
    await assert.rejects(()=>loadDshWorkerToken({}, {localPath:path}),/mismatch/);
    await assert.rejects(()=>loadDshWorkerToken({DSGO_DSH_WORKER_TOKEN:'bad'}, {localPath:path}),/Invalid DSH Worker token/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});
