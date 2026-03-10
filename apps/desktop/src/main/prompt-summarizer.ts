// src/main/prompt-summarizer.ts
// Calls Convex HTTP action to summarize user prompts into 3-4 word labels.

import { net } from 'electron'
import { debugWorkState } from './work-state-debug'

const CONVEX_SITE_URL = 'https://valuable-iguana-916.convex.site'
const REQUEST_TIMEOUT_MS = 8000

export interface ResponseSummaryResult {
  summary: string
  requiresUserInput: boolean
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
  const parsed = await postToConvex('/api/summarize', { prompt })
  if (parsed && typeof parsed === 'object' && typeof (parsed as { summary?: unknown }).summary === 'string') {
    return (parsed as { summary: string }).summary
  }
  throw new Error('Invalid summarize prompt response')
}

export async function summarizeResponse(response: string): Promise<ResponseSummaryResult> {
  const parsed = await postToConvex('/api/summarize-response', { response })

  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { summary?: unknown }).summary === 'string' &&
    typeof (parsed as { requiresUserInput?: unknown }).requiresUserInput === 'boolean'
  ) {
    return parsed as ResponseSummaryResult
  }

  throw new Error('Invalid summarize response payload')
}
