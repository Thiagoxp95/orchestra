// A real PTY running only deterministic synthetic output. Never a user shell.
let row = 0
let timer
let input = ''
let producing = false
let generation = 0
const write = text => process.stdout.write(text)
async function lines(count) {
  if (producing) return
  producing = true
  const activeGeneration = generation
  try {
    for (let batch = 0; batch < count && activeGeneration === generation; batch += 100) {
      let output = ''
      for (let i = batch; i < Math.min(count, batch + 100); i++) {
        output += `\x1b[38;5;${33 + row % 6}mrow-${String(row++).padStart(6, '0')}\x1b[0m  synthetic output · café · 界 · 🙂\r\n`
      }
      if (!write(output)) await new Promise(resolve => process.stdout.once('drain', resolve))
    }
  } finally { producing = false }
}
function command(text) {
  if (text.startsWith('burst ')) lines(Math.min(10000, Math.max(0, Number(text.slice(6)) || 0)))
  else if (text === 'stream') { clearInterval(timer); timer = setInterval(() => lines(10), 50) }
  else if (text === 'stop') { generation++; clearInterval(timer); timer = undefined }
  else if (text === 'alt') write('\x1b[?1049h\x1b[2J\x1b[H\x1b[32mAlternate screen\x1b[0m\r\nSame cells in both viewers. Use Normal screen to leave.\r\n')
  else if (text === 'styles') write('\x1b[4mUnderlined\x1b[0m · \x1b]8;;https://example.com\x1b\\linked text\x1b]8;;\x1b\\ · plain\r\n')
  else if (text === 'normal') write('\x1b[?1049l')
  else if (text) write(`echo: ${text}\r\n`)
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  for (const char of data) {
    if (char === '\x03') { generation++; clearInterval(timer); timer = undefined; input = ''; write('^C\r\n'); continue }
    if (char === '\r' || char === '\n') { command(input); input = '' }
    else if (char === '\x7f') input = input.slice(0, -1)
    else input += char
  }
})
process.stdout.on('resize', () => write(`\r\n[PTY geometry ${process.stdout.columns} × ${process.stdout.rows}]\r\n`))
write('\x1b[1;36mOrchestra terminal stream prototype\x1b[0m\r\nSynthetic PTY ready. Take control, then generate output.\r\n')
