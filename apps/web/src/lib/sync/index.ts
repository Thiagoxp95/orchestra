// lib/sync/index.ts
//
// The app's data layer: everything the phone reads from and writes to the
// desktop goes through here.

export { api, type FunctionName } from './api'
export { getSyncClient, SyncClient, type Unsubscribe } from './client'
export {
  SKIP,
  SyncProvider,
  useForegroundNonce,
  useForegroundResync,
  useMutation,
  useQuery,
  useSync,
  useSyncConnected,
  type QueryArgs,
} from './react'
export { SYNC_PATH, SYNC_PROTOCOL_VERSION } from './protocol'
