// src/main/prompt-summarizer.ts
// Calls Convex HTTP action to summarize user prompts into 3-4 word labels.

import { net } from 'electron'
import { debugWorkState } from './work-state-debug'
import { CONVEX_SITE_URL } from './convex-config'
import { DEFAULT_OPENROUTER_CLASSIFIER_PROMPT } from '../shared/types'
const REQUEST_TIMEOUT_MS = 8000
const PROMPT_SUMMARY_CHAR_THRESHOLD = 30
const PROMPT_SUMMARY_WORD_THRESHOLD = 4
const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ResponseSummaryResult {
  title: string
  summary: string
  requiresUserInput: boolean
}

export interface OpenRouterClassificationSettings {
  apiKey: string
  model: string
  systemPrompt?: string
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

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Empty model response')

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error(`Invalid model JSON: ${trimmed.slice(0, 200)}`)
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

function normalizeResponseSummary(parsed: unknown, response: string): ResponseSummaryResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid response classification payload')
  }

  const obj = parsed as Record<string, unknown>
  const summary = typeof obj.summary === 'string' && obj.summary.trim()
    ? obj.summary.trim()
    : response.replace(/\s+/g, ' ').trim().slice(0, 160)
  const title = typeof obj.title === 'string' && obj.title.trim()
    ? obj.title.trim().slice(0, 80)
    : summary.split(/[.!?]/)[0].trim().slice(0, 50)

  return {
    title,
    summary,
    requiresUserInput: typeof obj.requiresUserInput === 'boolean'
      ? obj.requiresUserInput
      : detectRequiresUserInput(response),
  }
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
 * Detect whether the agent's response is asking the user a question.
 * Used as a local fallback when the API doesn't return requiresUserInput.
 */
export function detectRequiresUserInput(response: string): boolean {
  const normalized = response.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false
  // Check for question marks anywhere
  if (normalized.includes('?')) return true
  // Check for common invitation/question phrases
  return [
    'do you want', 'would you like', 'can you', 'could you',
    'should i', 'which option', 'what would you like', 'please confirm',
    'let me know', 'need your input', 'can i continue', 'can i proceed',
    'please provide', 'please choose', 'how can i help', 'what should',
  ].some((phrase) => normalized.includes(phrase))
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

export async function classifyAgentResponseWithOpenRouter(
  response: string,
  settings: OpenRouterClassificationSettings,
): Promise<ResponseSummaryResult> {
  const normalizedResponse = normalizePromptText(response).slice(0, 6000)
  if (!normalizedResponse) {
    return { title: '', summary: '', requiresUserInput: false }
  }

  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined

  const httpResponse = await fetch(OPENROUTER_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      'HTTP-Referer': 'https://orchestra.local',
      'X-Title': 'Orchestra',
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      max_tokens: 180,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: settings.systemPrompt?.trim() || DEFAULT_OPENROUTER_CLASSIFIER_PROMPT,
        },
        {
          role: 'user',
          content: normalizedResponse,
        },
      ],
    }),
    signal,
  })

  const body = await httpResponse.text()
  const parsed = parseResponsePayload(body, httpResponse.status)
  const content = (parsed as any)?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('Invalid OpenRouter response payload')
  }

  return normalizeResponseSummary(extractJsonObject(content), normalizedResponse)
}
