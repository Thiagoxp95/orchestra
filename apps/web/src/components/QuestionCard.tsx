'use client'
import { MessageCircle } from 'lucide-react'
import { type DisplayBlock } from '../chat/chat-messages'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

/**
 * An AskUserQuestion form's timeline record, t3code style: a one-line work-log
 * row ("User input requested" → "User input submitted"), no options echo, no
 * answer echo. The whole interaction — options, custom answer, submitted state
 * — lives in the composer's pinned panel (ComposerQuestionPanel); the timeline
 * only logs that it happened.
 *
 * A dismissed form (isError result) stays "User input requested": t3code never
 * emits a resolved row for a rejection, and the composer panel's disappearance
 * already tells the story.
 */
export function QuestionRow({ block }: { block: QuestionBlock }) {
  const submitted = block.result != null && block.result.isError !== true
  return (
    <div className="flex flex-col rounded-md px-0.5 py-0.5">
      <div className="flex select-none items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
          <MessageCircle className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" />
        </span>
        <p className="min-w-0 flex-1 truncate text-[12px] font-medium leading-5 text-foreground/80">
          {submitted ? 'User input submitted' : 'User input requested'}
        </p>
      </div>
    </div>
  )
}
