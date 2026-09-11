import { describe, expect, it } from "vitest";
import { createTerminalWriter } from "./terminal-writer";

// xterm parses writes asynchronously. The fake exposes that boundary explicitly;
// reset during a pending parse would erase or mix old and replacement output.
class AsyncTerminal {
  output = "";
  writes: string[] = [];
  resets = 0;
  pending: { data: string; callback: () => void } | undefined;
  buffer = { active: { baseY: 100, viewportY: 100 } };
  write(data: string, callback: () => void) {
    if (this.pending) throw new Error("Concurrent terminal parsing");
    this.writes.push(data);
    this.pending = { data, callback };
  }
  reset() {
    if (this.pending) throw new Error("Reset during terminal parsing");
    this.resets++;
    this.output = "";
    this.buffer.active = { baseY: 0, viewportY: 0 };
  }
  scrollToLine(line: number) { this.buffer.active.viewportY = line; }
  finish(baseY = this.buffer.active.baseY) {
    const pending = this.pending;
    if (!pending) throw new Error("No pending write");
    this.pending = undefined;
    this.output += pending.data;
    this.buffer.active.baseY = baseY;
    pending.callback();
  }
  drain() { while (this.pending) this.finish(); }
}

describe("terminal writer", () => {
  it("waits for the parser before reset and holds live output behind the entire seed", () => {
    const term = new AsyncTerminal();
    const completed: boolean[] = [];
    const writer = createTerminalWriter(term, { onOverflow() {}, maxWriteChars: 4, onAfterWrite: event => completed.push(event.reset) });
    writer.enqueue({ data: "old" });
    writer.enqueue({ data: "obsolete" });
    writer.enqueue({ data: "snapshot", reset: true });
    writer.enqueue({ data: "live" });
    expect(term.resets).toBe(0);
    expect(writer.isReplaying).toBe(true);
    term.finish();
    expect(term.resets).toBe(1);
    term.finish();
    expect(completed).not.toContain(true);
    term.finish();
    expect(completed).toContain(true);
    term.drain();
    expect(term.output).toBe("snapshotlive");
    expect(writer.isReplaying).toBe(false);
  });

  it("coalesces pending output into bounded writes without splitting emoji", () => {
    const term = new AsyncTerminal();
    const writer = createTerminalWriter(term, { onOverflow() {}, maxWriteChars: 4 });
    writer.enqueue({ data: "first" });
    writer.enqueue({ data: "a" });
    writer.enqueue({ data: "b" });
    writer.enqueue({ data: "😀end" });
    term.drain();
    expect(term.output).toBe("firstab😀end");
    expect(term.writes.every(data => data.length <= 4)).toBe(true);
    expect(term.writes.every(data => !/[\uD800-\uDBFF]$/.test(data))).toBe(true);
    expect(term.writes.length).toBeLessThan(6);
  });

  it("replaces a partially parsed seed and preserves the original distance from bottom", () => {
    const term = new AsyncTerminal();
    term.buffer.active.viewportY = 70;
    const writer = createTerminalWriter(term, { onOverflow() {}, maxWriteChars: 4 });
    writer.enqueue({ data: "old snapshot", reset: true });
    writer.enqueue({ data: "new seed", reset: true });
    term.finish(10);
    term.finish(100);
    term.finish(200);
    expect(term.output).toBe("new seed");
    expect(term.buffer.active.viewportY).toBe(170);
  });

  it("runs empty reset boundaries before later live output", () => {
    const term = new AsyncTerminal();
    const completed: boolean[] = [];
    const writer = createTerminalWriter(term, { onOverflow() {}, onAfterWrite: event => completed.push(event.reset) });
    writer.enqueue({ data: "old" });
    writer.enqueue({ data: "", reset: true });
    writer.enqueue({ data: "live" });
    term.finish();
    expect(term.resets).toBe(1);
    expect(completed).toContain(true);
    term.drain();
    expect(term.output).toBe("live");
  });

  it("requests one recovery on overflow and refuses deltas until a fresh seed", () => {
    const term = new AsyncTerminal();
    let recoveries = 0;
    const writer = createTerminalWriter(term, { onOverflow: () => recoveries++, maxPendingChars: 8 });
    writer.enqueue({ data: "busy" });
    writer.enqueue({ data: "12345678" });
    expect(writer.enqueue({ data: "9" })).toBe(false);
    expect(writer.enqueue({ data: "ignored" })).toBe(false);
    term.drain();
    expect(recoveries).toBe(1);
    expect(term.output).toBe("busy");
    expect(writer.enqueue({ data: "fresh", reset: true })).toBe(true);
    writer.enqueue({ data: "!" });
    term.drain();
    expect(term.output).toBe("fresh!");
  });

  it("ignores parser callbacks and new output after disposal", () => {
    const term = new AsyncTerminal();
    let completions = 0;
    const writer = createTerminalWriter(term, { onOverflow() {}, onAfterWrite: () => completions++ });
    writer.enqueue({ data: "in flight" });
    writer.enqueue({ data: "queued", reset: true });
    writer.dispose();
    term.finish();
    expect(writer.enqueue({ data: "late" })).toBe(false);
    expect(term.resets).toBe(0);
    expect(completions).toBe(0);
    expect(term.pending).toBeUndefined();
  });
});
