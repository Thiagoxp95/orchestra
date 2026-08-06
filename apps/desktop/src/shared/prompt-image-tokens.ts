// src/shared/prompt-image-tokens.ts
// Image attachments reach an agent as raw *text*, not as anything the user
// typed: the remote bridge saves a phone photo and types its absolute path
// (`~/.orchestra/remote-images/…`) into the TUI, and claude-code substitutes
// `[Image #N]` for a pasted image. Both are plumbing. When a conversation opens
// with an attachment, that plumbing is the whole first prompt — so anything
// derived from prompt text (sidebar labels, notification titles, resume
// previews) has to drop it or the session ends up named after a JPEG.

const IMAGE_TOKEN_RE = /\S*[/\\]\.orchestra[/\\]remote-images[/\\]\S+|\[Image #\d+\]/g

/**
 * Remove image path/placeholder tokens and collapse the whitespace they leave
 * behind. Returns '' when the text was nothing but attachments — callers should
 * treat that as "the user submitted no text" rather than substituting the raw
 * input back in.
 */
export function stripPromptImageTokens(text: string): string {
  return text.replace(IMAGE_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim()
}
