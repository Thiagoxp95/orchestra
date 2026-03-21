export interface AgentInputUpdate {
  nextBuffer: string
  submittedPrompt: boolean
}

export function updateAgentInputBuffer(currentBuffer: string, data: string): AgentInputUpdate {
  let nextBuffer = currentBuffer
  let submittedPrompt = false

  for (let index = 0; index < data.length; index++) {
    const char = data[index]

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
