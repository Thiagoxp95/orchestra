// src/main/prompt-summarizer.ts
// Calls Convex HTTP action to summarize user prompts into 3-4 word labels.

import { net } from 'electron'

const CONVEX_SITE_URL = 'https://valuable-iguana-916.convex.site'

function postToConvex<T extends Record<string, string>>(endpoint: string, body: T): Promise<string> {
  const url = `${CONVEX_SITE_URL}${endpoint}`

  return new Promise((resolve, reject) => {
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
          if (response.statusCode === 200 && parsed.summary) {
            resolve(parsed.summary)
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
  return postToConvex('/api/summarize', { prompt })
}

export async function summarizeResponse(response: string): Promise<string> {
  return postToConvex('/api/summarize-response', { response })
}
