'use client'
// Assistant prose renderer. react-markdown + gfm + breaks — remark-breaks is
// load-bearing: transcript text mixes markdown paragraphs with hard-wrapped
// plain lines, and collapsing those single newlines mangles them. Raw HTML is
// NOT rendered (no rehype-raw; react-markdown skips it by default), so
// transcript content can't inject markup. Block styling leans on the
// `.chat-markdown` rules in globals.css; the components map only intercepts
// what needs structure: fenced code → <CodeBlock>, tables → scroll container,
// links → new tab, task-list checkboxes → inert.

import { Children, isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { cn } from './cn'
import { CodeBlock } from './CodeBlock'

// Module-level constants: react-markdown memoizes on referential identity.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

function nodeText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(nodeText).join('')
  if (isValidElement(children)) {
    return nodeText((children.props as { children?: ReactNode }).children)
  }
  return ''
}

/**
 * A <pre> wrapping a single fenced block (language-x class, or multi-line
 * content) becomes a CodeBlock card. Single-line fences with no language and
 * bare pres keep the default `.chat-markdown pre` box.
 */
function extractFencedCode(children: ReactNode): { code: string; lang?: string } | null {
  const kids = Children.toArray(children).filter((c) => c !== '\n')
  if (kids.length !== 1) return null
  const child = kids[0]
  if (!isValidElement(child)) return null
  const props = child.props as { className?: unknown; children?: ReactNode }
  const className = typeof props.className === 'string' ? props.className : ''
  const lang = /(?:^|\s)language-(\S+)/.exec(className)?.[1]
  const code = nodeText(props.children).replace(/\n$/, '')
  if (!lang && !code.includes('\n')) return null
  return { code, lang }
}

// `node` is destructured out everywhere below: react-markdown passes the hast
// node as a prop, and spreading it onto a DOM element would throw React
// unknown-attribute warnings. `void node` keeps no-unused-vars quiet.
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ node, children, ...props }) => {
    void node
    const fenced = extractFencedCode(children)
    if (fenced) return <CodeBlock code={fenced.code} lang={fenced.lang} />
    return <pre {...props}>{children}</pre>
  },
  // Inline code is NOT overridden — globals' `code:not(pre code)` styles it.
  a: ({ node, children, ...props }) => {
    void node
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  // Tables must scroll inside their own box — the chat column can never
  // scroll horizontally on a phone.
  table: ({ node, children, ...props }) => {
    void node
    return (
      <div className="chat-markdown-table-container">
        <table {...props}>{children}</table>
      </div>
    )
  },
  // GFM task-list checkboxes: display-only (the transcript is read-only from
  // here), but keep the checked state visible.
  input: ({ node, ...props }) => {
    void node
    return props.type === 'checkbox' ? (
      <input {...props} disabled className="accent-primary" />
    ) : (
      <input {...props} />
    )
  },
}

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div className={cn('chat-markdown text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
