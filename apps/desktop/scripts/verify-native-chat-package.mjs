#!/usr/bin/env node
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Check the packaged app, not node_modules: cross-architecture builds can
// succeed and sign even when an optional provider executable was omitted.
const apps = process.argv.slice(2)
if (apps.length === 0) throw new Error('Pass each packaged Orchestra.app path')
for (const app of apps) {
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/Orchestra')], { encoding: 'utf8' }).trim().split(/\s+/)
  for (const architecture of architectures) {
    const cpu = { arm64: 'arm64', x86_64: 'x64' }[architecture]
    if (!cpu) throw new Error(`Unsupported packaged architecture: ${architecture}`)
    const cli = join(app, `Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${cpu}/claude`)
    accessSync(cli, constants.X_OK)
    const cliArchitectures = execFileSync('/usr/bin/lipo', ['-archs', cli], { encoding: 'utf8' }).trim().split(/\s+/)
    if (!cliArchitectures.includes(architecture)) throw new Error(`Wrong Claude executable architecture in ${app}`)
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', cli], { stdio: 'pipe' })
    console.log(`Verified ${cpu} native Claude executable: ${app}`)
  }
}
