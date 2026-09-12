const p = await openTab('http://127.0.0.1:4382/production.html');
try {
  await new Promise(r => setTimeout(r, 2000));
  console.log(await p.evaluate(async () => {
    const lab = window.lab;
    const wait = async (check, message) => { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error(message); await new Promise(r => setTimeout(r, 30)); } };
    const a = lab.views[0], b = lab.views[1];
    const equal = () => a.applier.applied.seq === b.applier.applied.seq;
    await wait(() => a.connection.isController, 'A control');
    lab.command('burst 5000');
    await wait(() => b.terminal.buffer.active.baseY >= 4800 && equal(), 'Initial burst');
    b.terminal.scrollToLine(1200);
    const anchor = () => b.terminal.buffer.active.getLine(b.terminal.buffer.active.viewportY).translateToString(true);
    const original = anchor();
    lab.command('stream');
    await new Promise(r => setTimeout(r, 650));
    if (anchor() !== original) throw new Error('Reading anchor moved during live output');
    b.disconnect();
    await new Promise(r => setTimeout(r, 1500));
    lab.command('stop');
    await wait(equal, 'Reconnect catchup');
    if (anchor() !== original) throw new Error('Reading anchor moved on reconnect');
    lab.command('styles');
    await new Promise(r => setTimeout(r, 200));
    const screen = v => {
      const t = v.terminal, buffer = t.buffer.active;
      const rows = [];
      for (let y = buffer.baseY; y < buffer.length; y++) {
        const line = buffer.getLine(y); const cells = [];
        for (let x = 0; x < t.cols; x++) { const c = line.getCell(x); cells.push([c.getChars(), c.getWidth(), c.getFgColor(), c.getBgColor(), c.isUnderline()]); }
        rows.push(cells);
      }
      return JSON.stringify({ cols:t.cols, rows:t.rows, x:buffer.cursorX, y:buffer.cursorY, type:buffer.type, modes:t.modes, cells:rows });
    };
    await wait(equal, 'Styles catchup');
    if (screen(a) !== screen(b)) throw new Error('Live cell mismatch');
    lab.command('alt'); await new Promise(r => setTimeout(r, 200)); await wait(equal, 'Alt catchup');
    if (screen(a) !== screen(b) || b.terminal.buffer.active.type !== 'alternate') throw new Error('Alternate mismatch');
    lab.command('normal'); await new Promise(r => setTimeout(r, 200)); await wait(equal, 'Normal catchup');
    const beforeCols = a.terminal.cols;
    a.panel.style.width = '430px';
    await wait(() => a.terminal.cols < beforeCols && equal(), 'Automatic narrow reflow');
    if (a.terminal.cols !== b.terminal.cols) throw new Error('Geometry mismatch');
    a.disconnect(); await new Promise(r => setTimeout(r, 1200));
    await wait(() => a.connection.isController, 'Control after reconnect');
    b.slow(1000); lab.command('burst 2000');
    await new Promise(r => setTimeout(r, 350));
    const slowIsolated = BigInt(a.applier.applied.seq) > BigInt(b.applier.applied.seq);
    b.slow(0); await new Promise(r => setTimeout(r, 1200)); await wait(equal, 'Slow viewer catchup');
    if (!slowIsolated) throw new Error('Did not observe independent viewer credit');
    return {ok:true,anchor:original,retainedReconnect:true,matchedCells:true,alternate:true,automaticReflow:[beforeCols,a.terminal.cols],controllerReclaimed:true,slowViewerIsolation:slowIsolated,rows:b.terminal.buffer.active.length};
  }));
  await p.screenshot({path:'/tmp/orchestra-production-stream.png'});
} finally { await p.close(); }
