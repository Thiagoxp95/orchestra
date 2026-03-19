const DEFAULT_FOREGROUND_REPORT = '\x1b]10;rgb:e0e0/e0e0/e0e0\x1b\\'
const DEFAULT_BACKGROUND_REPORT = '\x1b]11;rgb:2424/2424/2424\x1b\\'
const DEFAULT_CURSOR_REPORT = '\x1b]12;rgb:e0e0/e0e0/e0e0\x1b\\'

function countMatches(data: string, pattern: RegExp): number {
  return [...data.matchAll(pattern)].length
}

export function buildSyntheticTerminalResponses(data: string): string {
  let response = ''

  // DA1 / DA2
  response += '\x1b[?1;2c'.repeat(countMatches(data, /\x1b\[(?:0)?c/g))
  response += '\x1b[>0;276;0c'.repeat(countMatches(data, /\x1b\[>(?:0)?c/g))

  // DSR / DECDSR
  response += '\x1b[0n'.repeat(countMatches(data, /\x1b\[(?:0)?5n/g))
  response += '\x1b[1;1R'.repeat(countMatches(data, /\x1b\[(?:0)?6n/g))
  response += '\x1b[?1;1R'.repeat(countMatches(data, /\x1b\[\?(?:0)?6n/g))

  // OSC special color reports.
  response += DEFAULT_FOREGROUND_REPORT.repeat(countMatches(data, /\x1b\]10;\?(?:\x07|\x1b\\)/g))
  response += DEFAULT_BACKGROUND_REPORT.repeat(countMatches(data, /\x1b\]11;\?(?:\x07|\x1b\\)/g))
  response += DEFAULT_CURSOR_REPORT.repeat(countMatches(data, /\x1b\]12;\?(?:\x07|\x1b\\)/g))

  // If focus reporting is enabled before a real terminal is attached, emit
  // an initial focus-in event so TUIs can finish bootstrapping.
  if (data.includes('\x1b[?1004h')) {
    response += '\x1b[I'
  }

  return response
}
