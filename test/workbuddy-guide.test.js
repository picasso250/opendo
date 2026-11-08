import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const guide=readFileSync(new URL('../public/workbuddy.md',import.meta.url),'utf8');
const source=readFileSync(new URL('../docs/worker-adapter.md',import.meta.url),'utf8');
const headers=readFileSync(new URL('../public/_headers',import.meta.url),'utf8');

test('WorkBuddy document is public, self-contained, and generated from canonical protocol',()=>{
  assert.match(guide,/^# OpenDo × WorkBuddy 接入说明书/);
  assert.match(guide,/https:\/\/chat\.io99\.xyz\/workbuddy\.md/);
  assert.match(guide,/无需登录或访问 GitHub/);
  assert.match(guide,/WorkBuddy.*非交互执行接口/);
  for(const action of ['configs','claim','heartbeat','complete']){
    assert.ok(guide.includes('POST /api/worker/'+action),action+' HTTP method in public Markdown');
  }
  assert.ok(guide.includes('catalog_session_id'));
  assert.ok(guide.includes('claim_id'));
  assert.ok(guide.includes('task_result'));
  assert.ok(guide.includes('## 9. Acceptance test for Xiaolai / 小赖'));
  assert.ok(guide.includes(source.replaceAll('\r','').slice(-200).trim()),
    'the public guide must not lose the source protocol ending');
  assert.doesNotMatch(guide,/\]\(\.\.\/src\//,
    'a public path must not require relative repository source links');
  assert.doesNotMatch(guide,/(?:worker_[a-f0-9]{32}\.[a-f0-9]{64}|-----BEGIN PRIVATE KEY-----)/,
    'no real Worker credential or private key may be published');
});

test('public Markdown has explicit UTF-8 content type, open read access and no caching',()=>{
  assert.match(headers,/\/workbuddy\.md\s+Content-Type: text\/markdown; charset=utf-8/);
  assert.match(headers,/\/workbuddy\.md[\s\S]+Cache-Control: no-cache/);
  assert.match(headers,/\/workbuddy\.md[\s\S]+Access-Control-Allow-Origin: \*/);
});
