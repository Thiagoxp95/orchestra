import type { GeneratedTicketDraft } from '../shared/linear-types'

/** Pull the first JSON object out of the agent's output and coerce it to a draft. */
export function parseTicketDraft(text: string): GeneratedTicketDraft | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let obj: any
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof obj?.title !== 'string' || !obj.title.trim()) return null
  return {
    title: obj.title.trim(),
    description: typeof obj.description === 'string' ? obj.description : '',
    labelNames: Array.isArray(obj.labelNames) ? obj.labelNames.filter((n: unknown) => typeof n === 'string') : [],
    projectName: typeof obj.projectName === 'string' && obj.projectName.trim() ? obj.projectName.trim() : null,
    priority: Number.isInteger(obj.priority) ? obj.priority : 0,
  }
}

/**
 * Build the headless-agent prompt, constraining label/project choices to the team's.
 *
 * Pass `gitContext` (from collectWorktreeGitContext) whenever it's available: it
 * turns this from an agentic loop — where every `git status` / `git diff` costs a
 * model round-trip — into a single-turn generation, which is most of why the web
 * header's "Analyzing this worktree…" step used to drag. Without it the agent
 * falls back to gathering the same information itself.
 */
export function buildTicketPrompt(
  labelNames: string[],
  projectNames: string[],
  gitContext?: string | null,
): string {
  const labels = labelNames.length ? labelNames.join(', ') : '(none)'
  const projects = projectNames.length ? projectNames.join(', ') : '(none)'
  const investigation = gitContext
    ? [
        'The worktree has already been inspected for you. Everything you need is below.',
        'Do NOT run any commands or read any files — answer immediately from this context.',
        '',
        '<worktree>',
        gitContext,
        '</worktree>',
      ]
    : [
        'Inspect the work yourself: run `git status`, `git diff`, `git log --oneline -20`, and read changed files as needed.',
      ]
  return [
    'You are drafting a Linear ticket that describes the work happening in THIS git worktree.',
    ...investigation,
    '',
    'Infer a concise ticket describing that work.',
    '',
    `Choose labels ONLY from this list (use exact names, pick 0-3): ${labels}`,
    `Choose a project ONLY from this list (exact name, or null): ${projects}`,
    'priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.',
    '',
    'Output ONLY a single JSON object, no prose, no code fences, matching exactly:',
    '{"title": string, "description": string (markdown), "labelNames": string[], "projectName": string|null, "priority": number}',
  ].join('\n')
}
