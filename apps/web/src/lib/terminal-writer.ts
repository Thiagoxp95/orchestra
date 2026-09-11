interface TerminalSink {
  write(data: string, callback: () => void): void;
  reset(): void;
  buffer: { active: { baseY: number; viewportY: number } };
  scrollToLine(line: number): void;
}

interface TerminalWriterOptions {
  onOverflow(): void;
  onBeforeReset?(): void;
  onAfterWrite?(event: { reset: boolean }): void;
  maxPendingChars?: number;
  maxWriteChars?: number;
}

export function createTerminalWriter(term: TerminalSink, options: TerminalWriterOptions) {
  const maxPendingChars = Math.max(2, options.maxPendingChars ?? 2 * 1024 * 1024);
  const maxWriteChars = Math.max(2, options.maxWriteChars ?? 32 * 1024);
  type Entry = { data: string; offset: number; reset: boolean };
  let queue: Entry[] = [];
  let head = 0;
  let pendingChars = 0;
  let writing = false;
  let disposed = false;
  let waitingForSeed = false;
  let generation = 0;
  let replaying = false;
  let replayAnchor: number | undefined;

  function clearQueue() {
    queue = [];
    head = 0;
    pendingChars = 0;
  }

  function completeReplay() {
    // Keep the anchor through superseded, partially parsed snapshots: their
    // temporary buffer position does not represent the reader's original place.
    if (replayAnchor !== undefined && replayAnchor > 0) {
      term.scrollToLine(Math.max(0, term.buffer.active.baseY - replayAnchor));
    }
    replayAnchor = undefined;
    replaying = false;
    options.onAfterWrite?.({ reset: true });
  }

  function pump() {
    if (disposed || writing || waitingForSeed || head >= queue.length) return;
    const entry = queue[head];
    const isSeed = entry.reset;
    if (isSeed && entry.offset === 0) {
      replayAnchor ??= Math.max(0, term.buffer.active.baseY - term.buffer.active.viewportY);
      options.onBeforeReset?.();
      term.reset();
    }
    const parts: string[] = [];
    let length = 0;
    while (head < queue.length && length < maxWriteChars) {
      const next = queue[head];
      if (next !== entry && (isSeed || next.reset)) break;
      let end = Math.min(next.data.length, next.offset + maxWriteChars - length);
      // A chunk boundary must not cut a UTF-16 surrogate pair in half.
      if (end < next.data.length && end > next.offset &&
          /[\uD800-\uDBFF]/.test(next.data[end - 1]) && /[\uDC00-\uDFFF]/.test(next.data[end])) end--;
      if (end === next.offset && next.offset < next.data.length) break;
      const part = next.data.slice(next.offset, end);
      parts.push(part);
      length += part.length;
      pendingChars -= part.length;
      next.offset = end;
      if (end === next.data.length) head++;
      else break;
    }
    const seedComplete = isSeed && entry.offset === entry.data.length;
    if (head > 128 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    if (head === queue.length) clearQueue();
    if (length === 0) {
      if (seedComplete) completeReplay();
      pump();
      return;
    }
    const writeGeneration = generation;
    writing = true;
    term.write(parts.join(""), () => {
      if (disposed) return;
      writing = false;
      if (writeGeneration === generation) {
        if (seedComplete) completeReplay();
        else if (!isSeed) options.onAfterWrite?.({ reset: false });
      }
      pump();
    });
  }

  return {
    get isReplaying() { return replaying || waitingForSeed; },
    enqueue({ data, reset = false }: { data: string; reset?: boolean }) {
      if (disposed || (waitingForSeed && !reset)) return false;
      if (reset) {
        generation++;
        clearQueue();
        replaying = true;
      }
      if (pendingChars + data.length > maxPendingChars) {
        generation++;
        clearQueue();
        if (!waitingForSeed) {
          waitingForSeed = true;
          options.onOverflow();
        }
        return false;
      }
      if (reset) waitingForSeed = false;
      if (!reset && data.length === 0) return true;
      queue.push({ data, offset: 0, reset });
      pendingChars += data.length;
      pump();
      return true;
    },
    dispose() {
      disposed = true;
      replaying = false;
      waitingForSeed = false;
      clearQueue();
    },
  };
}
