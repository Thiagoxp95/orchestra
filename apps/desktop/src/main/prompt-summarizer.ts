// src/main/prompt-summarizer.ts
// Calls Convex HTTP action to summarize user prompts into 3-4 word labels.

import { net } from 'electron'

const CONVEX_SITE_URL = 'https://valuable-iguana-916.convex.site'

export interface ResponseSummaryResult {
  summary: string
  requiresUserInput: boolean
}

function postToConvex<T extends Record<string, string>>(endpoint: string, body: T): Promise<unknown> {
  const url = `${CONVEX_SITE_URL}${endpoint}`

  return new Promise<unknown>((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url
    })

    request.setHeader('Content-Type', 'application/json')

    let responseData = ''

    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseData)
          if (response.statusCode === 200) {
            resolve(parsed)
          } else {
            reject(new Error(parsed.error || `HTTP ${response.statusCode}`))
          }
        } catch {
          reject(new Error(`Invalid response: ${responseData.slice(0, 200)}`))
        }
      })
    })

    request.on('error', (err) => {
      reject(err)
    })

    request.write(JSON.stringify(body))
    request.end()
  })
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
