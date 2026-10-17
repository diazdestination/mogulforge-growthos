import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { cleanupProduction75Container,recordProduction75RunResponse } from './production75-local.mjs';

const runId='11111111-2222-4333-8444-555555555555';
const name='production75-local-12345-11111111';
const id='a'.repeat(64);
const inspection={Name:`/${name}`,Id:id,Config:{Labels:{'com.forge.local-test':runId,'com.forge.fixture-purpose':'production75-local'}}};

test('lost Docker run response recovers unknown ID from exact name and both labels, then removes only that ID', async () => {
  const identity={name,runId,id:null},calls=[];let exists=false;
  const command=async args=>{
    calls.push(args);
    if(args[0]==='run'){exists=true;throw new Error('synthetic lost response after daemon creation');}
    if(args[0]==='ps')return{output:exists?id:''};
    if(args[0]==='inspect')return{output:JSON.stringify([inspection])};
    if(args[0]==='rm'){assert.deepEqual(args,['rm','--force',id]);exists=false;return{output:id};}
    assert.fail('unexpected command');
  };
  await assert.rejects(command(['run','--name',name]));
  const result=await cleanupProduction75Container(identity,command);
  assert.equal(result.containerRemoved,true);assert.equal(result.idRecovered,true);assert.equal(identity.id,id);
  assert.deepEqual(calls.filter(c=>c[0]==='rm'),[['rm','--force',id]]);
  assert.equal(calls.at(-1)[0],'ps');
});

test('unknown-ID cleanup refuses either missing ownership label, wrong name or ambiguous candidate before deletion', async () => {
  const cases=[
    {...inspection,Name:'/unrelated-container'},
    {...inspection,Config:{Labels:{...inspection.Config.Labels,'com.forge.local-test':'other-run'}}},
    {...inspection,Config:{Labels:{...inspection.Config.Labels,'com.forge.fixture-purpose':'other-task'}}},
    {...inspection,Id:'b'.repeat(64)},
  ];
  for(const record of cases){let removed=false;const identity={name,runId,id:null};
    await assert.rejects(cleanupProduction75Container(identity,async args=>{
      if(args[0]==='ps')return{output:id};if(args[0]==='inspect')return{output:JSON.stringify([record])};if(args[0]==='rm'){removed=true;}
    }),/production75_local_/);assert.equal(removed,false);assert.equal(identity.id,null);
  }
  let removed=false;
  await assert.rejects(cleanupProduction75Container({name,runId,id:null},async args=>{if(args[0]==='ps')return{output:`${id}\n${'b'.repeat(64)}`};removed=true;}),/production75_local_/);
  assert.equal(removed,false);
});

test('known-ID cleanup refuses a changed container ID even when name and labels match', async () => {
  let removed=false;
  await assert.rejects(cleanupProduction75Container({name,runId,id:'b'.repeat(64)},async args=>{
    if(args[0]==='ps')return{output:id};if(args[0]==='inspect')return{output:JSON.stringify([inspection])};removed=true;
  }),/production75_local_/);assert.equal(removed,false);
});

test('empty or malformed successful run output leaves ID unknown for ownership recovery', async () => {
  for(const response of ['',undefined,'not-a-container-id']) {
    const identity={name,runId,id:null};
    assert.throws(()=>recordProduction75RunResponse(identity,response),/production75_local_run_response/);
    assert.equal(identity.id,null);let exists=true;
    const cleanup=await cleanupProduction75Container(identity,async args=>{
      if(args[0]==='ps')return{output:exists?id:''};
      if(args[0]==='inspect')return{output:JSON.stringify([inspection])};
      if(args[0]==='rm'){assert.deepEqual(args,['rm','--force',id]);exists=false;return{output:id};}
      assert.fail('unexpected command');
    });assert.equal(cleanup.containerRemoved,true);assert.equal(cleanup.idRecovered,true);
  }
});
