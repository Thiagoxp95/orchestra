// Stamps a fresh build id into public/build-id.txt before `next build`.
//
// The same value is inlined into the client bundle by next.config.ts, so a
// long-lived phone page can compare its own baked-in copy against the file the
// desktop is currently serving and notice it is running stale code (see
// lib/build-freshness.ts).
//
// A plain file rather than a route handler: the app is a static export, so
// there is no server here to compute an answer.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'build-id.txt')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${Date.now().toString(36)}\n`)
console.log(`stamped ${target}`)
