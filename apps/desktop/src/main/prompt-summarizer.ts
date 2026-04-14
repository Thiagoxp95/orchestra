// src/main/prompt-summarizer.ts
// Calls Convex HTTP action to summarize user prompts into 3-4 word labels.

import { net } from 'electron'
import { debugWorkState } from './work-state-debug'
import { CONVEX_SITE_URL } from './convex-config'
const REQUEST_TIMEOUT_MS = 8000
const PROMPT_SUMMARY_CHAR_THRESHOLD = 30
const PROMPT_SUMMARY_WORD_THRESHOLD = 4

export interface ResponseSummaryResult {
  title: string
  summary: string
  requiresUserInput: boolean
}

export function normalizePromptText(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim()
}

export function shouldSummarizePrompt(prompt: string): boolean {
  const normalized = normalizePromptText(prompt)
  if (!normalized) return false

  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  return normalized.length > PROMPT_SUMMARY_CHAR_THRESHOLD || wordCount > PROMPT_SUMMARY_WORD_THRESHOLD
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseResponsePayload(responseData: string, statusCode: number): unknown {
  let parsed: unknown

  try {
    parsed = JSON.parse(responseData)
  } catch {
    throw new Error(`Invalid response: ${responseData.slice(0, 200)}`)
  }

  if (statusCode === 200) {
    return parsed
  }

  if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
    throw new Error((parsed as { error: string }).error)
  }

  throw new Error(`HTTP ${statusCode}`)
}

async function postToConvexViaFetch<T extends Record<string, string>>(url: string, body: T): Promise<unknown> {
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  const responseText = await response.text()
  return parseResponsePayload(responseText, response.status)
}

function postToConvexViaElectronNet<T extends Record<string, string>>(url: string, body: T): Promise<unknown> {
  const payload = JSON.stringify(body)

  return new Promise<unknown>((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url
    })

    request.setHeader('Content-Type', 'application/json')

    let responseData = ''
    let settled = false
    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    const finishResolve = (value: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }

    const timeout = setTimeout(() => {
      request.abort()
      finishReject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)

    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        try {
          finishResolve(parseResponsePayload(responseData, response.statusCode))
        } catch (error) {
          finishReject(error as Error)
        }
      })
    })

    request.on('error', (err) => {
      finishReject(err)
    })

    request.write(payload)
    request.end()
  })
}

async function postToConvex<T extends Record<string, string>>(endpoint: string, body: T): Promise<unknown> {
  const url = `${CONVEX_SITE_URL}${endpoint}`

  try {
    return await postToConvexViaFetch(url, body)
  } catch (fetchError) {
    debugWorkState('prompt-summarizer-fetch-fallback', {
      endpoint,
      error: formatError(fetchError),
    })
  }

  try {
    return await postToConvexViaElectronNet(url, body)
  } catch (netError) {
    debugWorkState('prompt-summarizer-request-failed', {
      endpoint,
      error: formatError(netError),
    })
    throw netError
  }
}

export async function summarizePrompt(prompt: string): Promise<string> {
  const normalizedPrompt = normalizePromptText(prompt)
  if (!normalizedPrompt) return ''
  if (!shouldSummarizePrompt(normalizedPrompt)) return normalizedPrompt

  const parsed = await postToConvex('/api/summarize', { prompt: normalizedPrompt })
  if (parsed && typeof parsed === 'object' && typeof (parsed as { summary?: unknown }).summary === 'string') {
    return (parsed as { summary: string }).summary
  }
  throw new Error('Invalid summarize prompt response')
}

/**
 * Detect whether the agent's response is asking the user a direct question.
 *
 * Used as the local fast-path before we call the remote classifier. When
 * this returns `true` we promote the session to `waitingUserInput`
 * immediately (skipping the remote round-trip), so it MUST be high-precision
 * — a false positive here means the sidebar flags "needs input" on a
 * message that doesn't actually need input.
 *
 * v1 returned true for any `?` anywhere in the response — that flagged jokes
 * ("Why do programmers prefer dark mode? Because light attracts bugs."),
 * rhetorical questions in explanations, and example questions in code
 * comments. v2 requires the signal to appear at the TAIL of the response:
 *
 *   - the last sentence ends with `?` AND contains a 2nd-person addressing
 *     pronoun (you / your) — a question directed AT the user, or
 *   - the tail of the response contains an explicit invitation phrase
 *     ("let me know", "would you like me to", "shall I", etc.).
 *
 * Anything less conclusive falls through to the remote classifier, which
 * has more context and is allowed to say no.
 */
export function detectRequiresUserInput(response: string): boolean {
  const normalized = response.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  // Tail window — we only care about the last ~250 chars. This is enough to
  // catch a multi-sentence closing passage without scanning the whole body.
  const tail = normalized.slice(-250)

  // Explicit direct invitations. If any of these appear anywhere in the
  // tail, we treat it as a real ask — Claude is addressing the user.
  const directInvitations = [
    'let me know',
    'would you like me',
    'do you want me',
    'do you want to',
    'shall i ',
    'should i ',
    'which would you',
    'which do you',
    'please confirm',
    'please choose',
    'please provide',
    'please let me know',
    'waiting for your',
    'need your input',
    'need your confirmation',
    'can i continue',
    'can i proceed',
    'proceed?',
  ]
  if (directInvitations.some((p) => tail.includes(p))) return true

  // Isolate the last sentence. A sentence terminator is `.`, `!`, `?`, or `;`.
  // If we can't find one, treat the whole tail as the last sentence.
  const priorTerminator = Math.max(
    tail.lastIndexOf('. ', tail.length - 2),
    tail.lastIndexOf('! ', tail.length - 2),
    tail.lastIndexOf('? ', tail.length - 2),
    tail.lastIndexOf('; ', tail.length - 2),
    tail.lastIndexOf('.\n', tail.length - 2),
    tail.lastIndexOf('!\n', tail.length - 2),
    tail.lastIndexOf('?\n', tail.length - 2),
  )
  const lastSentence = priorTerminator >= 0
    ? tail.slice(priorTerminator + 1).trim()
    : tail

  // The last sentence must actually end with a question mark (optionally
  // followed by a trailing quote / bracket). A `?` in the middle of the
  // last sentence followed by more text is a rhetorical setup, not an ask.
  const endsWithQuestion = /\?\s*["')\]]*\s*$/.test(lastSentence)
  if (!endsWithQuestion) return false

  // And it must address the user. A bare "Does this work?" in the middle of
  // a technical explanation is usually rhetorical; "Does this work for you?"
  // is a real ask. Heuristic: require a 2nd-person pronoun in the last
  // sentence.
  const addressesUser = /\b(you|your|yours)\b/.test(lastSentence)
  return addressesUser
}

export async function summarizeResponse(response: string): Promise<ResponseSummaryResult> {
  const parsed = await postToConvex('/api/summarize-response', { response })

  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { summary?: unknown }).summary === 'string'
  ) {
    const obj = parsed as Record<string, unknown>
    return {
      title: typeof obj.title === 'string' ? obj.title : (obj.summary as string).split(/[.!?]/)[0].trim().slice(0, 50),
      summary: obj.summary as string,
      requiresUserInput: typeof obj.requiresUserInput === 'boolean'
        ? obj.requiresUserInput
        : detectRequiresUserInput(response)
    }
  }

  throw new Error('Invalid summarize response payload')
}
