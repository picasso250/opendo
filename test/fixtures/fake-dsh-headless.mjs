// Offline fixture, not a real model. Keeps all tests free of API charges.
let input='';
process.stdin.setEncoding('utf8');
for await(const part of process.stdin)input+=part;
if(process.argv.slice(2).join(' ')!=='--profile headless -'){
  process.stderr.write('unexpected argv');process.exit(19);
}
if(input==='FAIL'){
  process.stderr.write('local fake diagnostic');process.exit(1);
}
if(input==='OVERSIZE'){
  process.stdout.write('x'.repeat(260000));process.exit(0);
}
if(input==='DELAY'){
  await new Promise(resolve=>setTimeout(resolve,800));
}
process.stdout.write('OUT<'+input+'>\n'+
  (process.env.DSGO_DSH_WORKER_TOKEN?'LEAKED_TOKEN':'NO_WORKER_TOKEN')+'\n'+
  (process.env.DSH_PERMISSION_MODE||'NO_PERMISSION_MODE')+'\n');
