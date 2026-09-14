// src/main/local-server/summarize.ts
//
// Notification titles and webhook filters, generated with a cheap model. These
// were Convex Node actions reached over HTTP; they are ordinary async functions
// now, because the only caller was always this same process.
//
// The API key is the one the user saved in Settings → OpenRouter (the same key
// the idle notifier classifies with), or OPENROUTER_API_KEY in the environment.
// Without one the summarizers throw (the caller falls back to a heuristic
// label) and the webhook filter fails open, which is the same behaviour as
// before.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Supplies the user's saved key. Injected from index.ts, which owns the
 *  persisted settings and their decryption; left unset in tests. */
let keyProvider: (() => string | undefined) | null = null

export function setOpenRouterKeyProvider(provider: (() => string | undefined) | null): void {
  keyProvider = provider
}

function apiKey(): string | undefined {
  try {
    const saved = keyProvider?.()?.trim()
    if (saved) return saved
  } catch (err) {
    console.warn('[summarize] OpenRouter key lookup failed:', err)
  }
  return process.env.OPENROUTER_API_KEY || undefined
}

interface ChatRequest {
  model: string
  system: string
  user: string
  maxTokens: number
  temperature: number
}

async function chat({ model, system, user, maxTokens, temperature }: ChatRequest): Promise<string> {
  const key = apiKey()
  if (!key) throw new Error('OPENROUTER_API_KEY not configured')

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${await response.text()}`)
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('No summary returned from LLM')
  return content
}

function inferRequiresUserInput(response: string): boolean {
  const normalized = response.replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  if (normalized.includes('?')) return true
  const lower = normalized.toLowerCase()
  return [
    'do you want',
    'would you like',
    'can you',
    'could you',
    'should i',
    'which option',
    'what would you like',
    'please confirm',
    'let me know',
    'need your input',
    'can i continue',
    'can i proceed',
    'please provide',
    'please choose',
  ].some((phrase) => lower.includes(phrase))
}

export interface ResponseSummary {
  title: string
  summary: string
  requiresUserInput: boolean
}

export function parseResponsePayload(raw: string, fallbackSource: string): ResponseSummary {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
      if (summary) {
        return {
          title: title || summary.split(/[.!?]/)[0].trim().slice(0, 50),
          summary,
          requiresUserInput:
            typeof parsed.requiresUserInput === 'boolean'
              ? parsed.requiresUserInput
              : inferRequiresUserInput(fallbackSource),
        }
      }
    } catch {
      // Fall through to the heuristic below.
    }
  }
  return {
    title: 'Agent finished work',
    summary: raw.trim().replace(/^["']|["']$/g, '') || 'Agent finished work.',
    requiresUserInput: inferRequiresUserInput(fallbackSource),
  }
}

const PROMPT_SYSTEM =
  'You are a label generator. Given a user prompt sent to a coding AI assistant, respond with ' +
  "ONLY a 3-4 word summary that describes what the user wants. No punctuation, no quotes. " +
  "Examples: 'Fix sidebar spacing', 'Add dark mode', 'Refactor auth logic', 'Debug API timeout'."

export async function summarizePrompt(prompt: string): Promise<string> {
  return chat({
    model: 'google/gemini-2.0-flash-001',
    system: PROMPT_SYSTEM,
    user: prompt,
    maxTokens: 20,
    temperature: 0.3,
  })
}

const RESPONSE_SYSTEM =
  'You summarize coding AI assistant responses for desktop notifications. CRITICAL RULES: ' +
  '1) ONLY describe what is EXPLICITLY written in the provided text. NEVER invent, assume, or ' +
  'fabricate actions or content not present. 2) If the text is just a question, summarize the ' +
  'question itself. 3) If the text is short or simple, keep the summary equally short. Respond ' +
  'with ONLY minified JSON: {"title":"...","summary":"...","requiresUserInput":true/false}. ' +
  '`title`: 3-5 word label of what the text actually says (e.g. "Ask about next task", "Fixed ' +
  'sidebar spacing", "Request clarification"). `summary`: 1-2 sentences describing ONLY what the ' +
  'text contains. `requiresUserInput`: true if the text asks the user a question, requests input, ' +
  'or invites a response. No markdown, no extra text.'

export async function summarizeResponse(response: string): Promise<ResponseSummary> {
  // Long responses are trimmed from the front: the tail is where an agent asks
  // its question, which is the part the notification needs to convey.
  const truncated = response.length > 2000 ? response.slice(-2000) : response
  const raw = await chat({
    model: 'openai/gpt-5',
    system: RESPONSE_SYSTEM,
    user: truncated,
    maxTokens: 140,
    temperature: 0.3,
  })
  return parseResponsePayload(raw, truncated)
}

// ── Webhook filters ──────────────────────────────────────────────────────

export interface FilterVerdict {
  pass: boolean
  reason: string
}

export function parseFilterVerdict(raw: string): FilterVerdict {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      return {
        pass: typeof parsed.pass === 'boolean' ? parsed.pass : true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : raw,
      }
    } catch {
      // Fall through to the signal scan below.
    }
  }
  const lower = raw.toLowerCase()
  if (lower.includes('"pass":false') || lower.includes('"pass": false')) {
    return { pass: false, reason: raw }
  }
  return { pass: true, reason: raw }
}

const FILTER_SYSTEM =
  'You are a webhook payload filter. The user has defined a condition in plain English. You must ' +
  'decide whether the given JSON payload matches that condition.\n\n' +
  'Respond with ONLY minified JSON: {"pass":true/false,"reason":"..."}\n' +
  '- "pass": true if the payload matches the condition, false if it does not.\n' +
  "- \"reason\": a brief one-sentence explanation of why it matched or didn't.\n\n" +
  'No markdown, no extra text. JSON only.'

/**
 * Judge a payload against a plain-English condition.
 *
 * Fails open at every step. A webhook exists to trigger work, and dropping a
 * real event because a model was unreachable is worse than running one the
 * user would have filtered out.
 */
export async function evaluateWebhookFilter(filter: string, payload: unknown): Promise<FilterVerdict> {
  if (!apiKey()) {
    return { pass: true, reason: 'No OPENROUTER_API_KEY configured — skipping filter' }
  }
  const asText = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const truncated = asText.length > 4000 ? `${asText.slice(0, 4000)}\n... (truncated)` : asText
  try {
    const raw = await chat({
      model: 'google/gemini-2.0-flash-001',
      system: FILTER_SYSTEM,
      user: `CONDITION: ${filter}\n\nPAYLOAD:\n${truncated}`,
      maxTokens: 100,
      temperature: 0,
    })
    return parseFilterVerdict(raw)
  } catch (err) {
    console.error('[webhook-filter] evaluation failed', err)
    return { pass: true, reason: `Filter evaluation failed: ${err instanceof Error ? err.message : err}` }
  }
}
