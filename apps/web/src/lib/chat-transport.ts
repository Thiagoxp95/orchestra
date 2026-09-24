// The web half of the chat transport: the desktop's sync hub, over the same
// socket every other query rides (see lib/sync).

import type { NativeChatSnapshot } from '../../../desktop/src/shared/native-chat'
import type { ChatMessage } from '../../../desktop/src/shared/chat-message'
import type { ChatTransport } from '../chat/transport'
import { api, getSyncClient, useQuery } from './sync'

/** Same handshake the terminal's image paste uses: get a URL, POST the bytes. */
async function upload(file: File): Promise<{ storageId: string; mime: string }> {
  const sync = getSyncClient()
  const mime = file.type || 'image/png'
  const url = (await sync.call(api.remote.generateUploadUrl)) as string
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: file })
  if (!res.ok) throw new Error(`Image upload failed (${res.status})`)
  const { storageId } = (await res.json()) as { storageId: string }
  return { storageId, mime }
}

export const webChatTransport: ChatTransport = {
  useSnapshot: (sessionId) =>
    useQuery<NativeChatSnapshot | null>(api.nativeChat.getSession, { sessionId }),
  useMessages: (sessionId) => useQuery<ChatMessage[]>(api.nativeChat.messages, { sessionId }),
  async command(sessionId, command, images) {
    // Sequential: the order picked is the order the agent sees them.
    const uploads = []
    for (const file of images ?? []) uploads.push(await upload(file))
    await getSyncClient().call(api.nativeChat.command, {
      sessionId,
      command,
      ...(uploads.length ? { uploads } : {}),
    })
  },
  async setView(sessionId, view) {
    return (await getSyncClient().call(api.nativeChat.setView, { sessionId, view })) as NativeChatSnapshot | null
  },
}
