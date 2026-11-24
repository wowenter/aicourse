import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {runInNewContext} from 'node:vm';

const original = fs.readFileSync(new URL('../gateway/src/polling.js', import.meta.url),'utf8');
const source = original.replace(/^import .*;\n/gm,'').replace(/export /g,'').replace(/import\.meta\.url/g,JSON.stringify(import.meta.url))
  + '\nglobalThis.api={trackPayment,pollOnce,processRetries,loadTracked,loadRetries,getTrackedPayments};';
function gateway(dir, bankStatus, webhookStatus) {
  const calls=[];
  const context = {crypto,fs,path,process:{env:{DATA_DIR:dir}},fileURLToPath:()=>'/tmp/polling.js',
    KASPI_QRPAY_URL:'https://bank.test',signedQrPayHeaders:()=>({}),decryptSecret:()=> 'test',
    getWebhooksByEvent:()=>[{url:'https://worker.test/hook',secret:'test-only-secret'}],
    logger:{info(){},warn(){},error(){}},AbortController,setTimeout,clearTimeout,
    fetch:async(url,options)=>{
      if(url.startsWith('https://bank.test'))return Response.json({Data:{Status:bankStatus,Amount:4990}});
      calls.push(JSON.parse(options.body));return new Response('',{status:webhookStatus});
    },
  };
  runInNewContext(source,context);
  return {...context.api,calls};
}
test('unknown bank status stays pending; success is durably queued before delivery', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicourse-poll-'));
  try{
    let g=gateway(dir,'Processing',200);g.trackPayment('123','qr',{tokenSN:'test',vtokenSecret:'test'},{amount:4990});
    await g.pollOnce();assert.ok(g.getTrackedPayments()['123']);assert.equal(g.calls.length,0);
    g=gateway(dir,'Processed',503);g.loadTracked();await g.pollOnce();
    assert.equal(Object.keys(g.getTrackedPayments()).length,0);assert.equal(g.calls.length,0);
    const retryFile=path.join(dir,'webhook-retries.json');let queue=JSON.parse(fs.readFileSync(retryFile));
    assert.equal(queue.length,1);assert.equal(queue[0].payload.amount,4990);
    await g.processRetries();queue=JSON.parse(fs.readFileSync(retryFile));assert.equal(queue.length,1);assert.equal(queue[0].attempt,2);
    // Reboot after failure: retry survives and is removed only after the Worker acknowledges.
    queue[0].executeAfter=0;fs.writeFileSync(retryFile,JSON.stringify(queue));
    g=gateway(dir,'Processed',200);g.loadRetries();await g.processRetries();
    assert.equal(g.calls.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(retryFile)),[]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
