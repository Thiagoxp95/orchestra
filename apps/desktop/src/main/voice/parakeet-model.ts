// The one place the speech model id is written on the TypeScript side.
//
// `parakeet-tdt-0.6b-v2` is the English-only model. The newer `-v3` is
// multilingual (25 European languages) and is *worse* for an English-only
// dictation box: it is slower and spends capacity on languages we never send
// it. Stay on v2 unless dictation becomes multilingual.
//
// voice-setup.ts pre-downloads this id and voice-sidecar/main.py loads it. The
// two must agree or setup reports "ready" for a model the sidecar then
// downloads again mid-utterance — parakeet-model.test.ts asserts they match.
export const PARAKEET_MODEL_ID = 'mlx-community/parakeet-tdt-0.6b-v2'
