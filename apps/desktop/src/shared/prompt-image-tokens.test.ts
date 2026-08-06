import { describe, expect, it } from 'vitest'
import { stripPromptImageTokens } from './prompt-image-tokens'

describe('stripPromptImageTokens', () => {
  it('keeps only what the user typed alongside a remote image path', () => {
    expect(
      stripPromptImageTokens(
        '/Users/me/.orchestra/remote-images/remote-1786047609106-9.jpg the sidebar title is wrong',
      ),
    ).toBe('the sidebar title is wrong')
  })

  it('drops several attachments and claude-code placeholders', () => {
    expect(
      stripPromptImageTokens(
        '~/.orchestra/remote-images/a.png ~/.orchestra/remote-images/b.jpg [Image #1] compare these',
      ),
    ).toBe('compare these')
  })

  it('returns empty when the prompt was nothing but an attachment', () => {
    expect(stripPromptImageTokens('/Users/me/.orchestra/remote-images/remote-1-1.png')).toBe('')
  })

  it('leaves ordinary prompts alone, whitespace collapsed', () => {
    expect(stripPromptImageTokens('  fix   the\nheader  ')).toBe('fix the header')
  })

  it('does not eat unrelated paths that merely mention images', () => {
    expect(stripPromptImageTokens('open apps/web/public/images/hero.png')).toBe(
      'open apps/web/public/images/hero.png',
    )
  })
})
