// The chat UI shared by the web app and the desktop renderer. Relative imports
// only (the desktop reaches this directory through its `@chat` alias), no
// next/* imports, React 18 and 19 both.
export { ChatPane } from './ChatPane'
export { ChatOverlay } from './ChatOverlay'
export { ViewToggle, useChatView } from './ViewToggle'
export type { ChatContextUsage, ChatDictation, ChatTransport } from './transport'
export { upsertMessages } from './native-messages'
