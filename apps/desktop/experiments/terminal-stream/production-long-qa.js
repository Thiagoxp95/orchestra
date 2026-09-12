const p = await openTab('http://127.0.0.1:4382/production.html');
try {
  await new Promise(r => setTimeout(r, 1800));
  for (let batch=0;batch<11;batch++) {
    console.log(await p.evaluate(async () => {
      const a=window.lab.views[0], b=window.lab.views[1];
      const last=()=>{const buf=a.terminal.buffer.active;for(let i=buf.length-1;i>=0;i--){const m=buf.getLine(i).translateToString().match(/row-(\d+)/);if(m)return Number(m[1]);}return -1;};
      const target=last()+10000;
      window.lab.command('burst 10000');
      const until=Date.now()+20000;
      while(last()<target || a.applier.applied.seq!==b.applier.applied.seq){if(Date.now()>until)throw Error('Burst stalled');await new Promise(r=>setTimeout(r,30));}
      return {lastRow:last(),liveRows:b.terminal.buffer.active.length};
    }));
  }
  console.log(await p.evaluate(async () => {
    const {views,command} = window.lab; const a=views[0],b=views[1];
    const wait=async(f,msg)=>{const until=Date.now()+20000;while(!f()){if(Date.now()>until)throw Error(msg);await new Promise(r=>setTimeout(r,30));}};
    const last=()=>{const buf=a.terminal.buffer.active;for(let i=buf.length-1;i>=0;i--){const m=buf.getLine(i).translateToString().match(/row-(\d+)/);if(m)return Number(m[1]);}return -1;};
    const equal=()=>a.applier.applied.seq===b.applier.applied.seq;
    await wait(()=>a.connection.isController,'control');
    b.terminal.scrollToLine(9000);const anchor=()=>b.terminal.buffer.active.getLine(b.terminal.buffer.active.viewportY).translateToString(true);const before=anchor();
    const target=last()+500;command('burst 500');await wait(()=>last()>=target&&equal(),'trim burst');
    if(anchor()!==before)throw Error('Retained anchor moved when capped buffer trimmed');
    b.disconnect();await new Promise(r=>setTimeout(r,1500));await wait(equal,'resume at cap');
    if(anchor()!==before)throw Error('Capped anchor moved after reconnect');
    const server=await fetch('/production-session').then(r=>r.json());
    if(server.retainedBytes>8*1024*1024||server.pendingBytes!==0)throw Error('Daemon bounds not respected');
    return {ok:true,generatedRows:110500,liveRows:b.terminal.buffer.active.length,retainedAnchor:before,viewport:b.terminal.buffer.active.viewportY,retainedBytes:server.retainedBytes,queuedBytes:server.pendingBytes,offset:server.head.offset};
  }));
} finally { await p.close(); }
const fresh=await openTab('http://127.0.0.1:4382/production.html');
try {
 await new Promise(r=>setTimeout(r,2500));
 console.log(await fresh.evaluate(()=>({coldCheckpoint:window.lab.views.every(v=>v.applier.epoch&&v.terminal.buffer.active.length>=10000),rows:window.lab.views.map(v=>v.terminal.buffer.active.length),pending:window.lab.views.map(v=>v.applier.pendingBytes)})));
} finally {await fresh.close();}
