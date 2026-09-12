export interface AgentInputUpdate {
  nextBuffer: string
  submittedPrompt: boolean
}

export function updateAgentInputBuffer(currentBuffer: string, data: string): AgentInputUpdate {
  let nextBuffer = currentBuffer
  let submittedPrompt = false
  // xterm delivers a paste as one onData event, including these delimiters.
  // Newlines inside it edit the draft; only Enter outside it submits a turn.
  let inPaste = false

  for (let index = 0; index < data.length; index++) {
    if (data.startsWith('\x1b[200~', index)) {
      inPaste = true
      index += 5
      continue
    }
    if (data.startsWith('\x1b[201~', index)) {
      inPaste = false
      index += 5
      continue
    }
    const char = data[index]

    if (inPaste) {
      nextBuffer = (nextBuffer + char).slice(-2000)
      continue
    }

    if (char === '\x1b') {
      const nextChar = data[index + 1]
      if (nextChar === '[' || nextChar === 'O') {
        index += 1
        while (index + 1 < data.length && !/[@-~]/.test(data[index + 1])) {
          index += 1
        }
        if (index + 1 < data.length) {
          index += 1
        }
      } else if (nextChar != null) {
        index += 1
      }
      continue
    }

    if (char === '\r' || char === '\n') {
      if (nextBuffer.trim()) {
        submittedPrompt = true
      }
      nextBuffer = ''
      continue
    }

    if (char === '\x03' || char === '\x15') {
      nextBuffer = ''
      continue
    }

    if (char === '\x17') {
      nextBuffer = nextBuffer.replace(/\S+\s*$/, '')
      continue
    }

    if (char === '\x7f' || char === '\b') {
      nextBuffer = nextBuffer.slice(0, -1)
      continue
    }

    if (char >= ' ' && char !== '\x7f') {
      nextBuffer += char
      if (nextBuffer.length > 2000) {
        nextBuffer = nextBuffer.slice(-2000)
      }
    }
  }

  return { nextBuffer, submittedPrompt }
}
