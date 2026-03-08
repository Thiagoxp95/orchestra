"use strict";
!(function() {
  try {
    var e = "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : {};
    e.SENTRY_RELEASE = { id: "1.1.0" };
  } catch (e2) {
  }
})();
;
{
  try {
    (function() {
      var e = "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : {}, n = new e.Error().stack;
      n && (e._sentryDebugIds = e._sentryDebugIds || {}, e._sentryDebugIds[n] = "03aa85ae-df89-4e13-81ea-1c65aac3b2fb", e._sentryDebugIdIdentifier = "sentry-dbid-03aa85ae-df89-4e13-81ea-1c65aac3b2fb");
    })();
  } catch (e) {
  }
}
;
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const treeKill = require("./chunks/tree-kill-DNWlNxr1.js");
const node_perf_hooks = require("node:perf_hooks");
const node_child_process = require("node:child_process");
const ptySubprocessIpc = require("./chunks/pty-subprocess-ipc-CWpq8i5E.js");
require("./chunks/index-356-OGYe.js");
require("node:process");
require("./chunks/index-Hqy_aaOa.js");
require("./chunks/_commonjsHelpers-rb2ZsTxW.js");
require("child_process");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k2 in e) {
      if (k2 !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k2);
        Object.defineProperty(n, k2, d.get ? d : {
          enumerable: true,
          get: () => e[k2]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
function recordTransientErrorInWindow(timestamps, now, windowMs) {
  const cutoff = now - windowMs;
  timestamps.push(now);
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  return timestamps.length;
}
const TRANSIENT_ERROR_CODES = ["ENOSPC", "ENOMEM", "EMFILE", "ENFILE"];
const MAX_TRANSIENT_ERRORS = 50;
const TRANSIENT_ERROR_WINDOW_MS = 6e4;
const TRANSIENT_ERROR_WINDOW_SECONDS = Math.floor(
  TRANSIENT_ERROR_WINDOW_MS / 1e3
);
const SHUTDOWN_TIMEOUT_MS = 1e4;
function isTransientError(error) {
  if (error instanceof Error) {
    return TRANSIENT_ERROR_CODES.some(
      (code) => error.message.includes(code) || error.code === code
    );
  }
  return false;
}
function getTransientErrorIdentifier(error) {
  if (error instanceof Error) {
    const code = error.code;
    return code ?? error.message.split(",")[0];
  }
  return "unknown";
}
function setupTerminalHostSignalHandlers({
  log: log2,
  stopServer: stopServer2
}) {
  const transientErrorTimestamps = [];
  let isShuttingDown = false;
  let forceExitTimer = null;
  const clearForceExitTimer = () => {
    if (!forceExitTimer) return;
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  };
  const shutdownOnce = ({
    exitCode,
    message,
    stopServerErrorMessage,
    timeoutMessage
  }) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    forceExitTimer = setTimeout(() => {
      try {
        log2("error", timeoutMessage);
      } finally {
        process.exit(exitCode);
      }
    }, SHUTDOWN_TIMEOUT_MS);
    if (message) {
      try {
        log2(exitCode === 0 ? "info" : "error", message);
      } catch {
      }
    }
    stopServer2().catch((error) => {
      log2("error", stopServerErrorMessage, { error });
    }).finally(() => {
      clearForceExitTimer();
      process.exit(exitCode);
    });
  };
  process.on("SIGINT", () => {
    shutdownOnce({
      exitCode: 0,
      message: "Received SIGINT, shutting down...",
      stopServerErrorMessage: "Error during stopServer in SIGINT shutdown",
      timeoutMessage: "Forced exit after SIGINT shutdown timeout"
    });
  });
  process.on("SIGTERM", () => {
    shutdownOnce({
      exitCode: 0,
      message: "Received SIGTERM, shutting down...",
      stopServerErrorMessage: "Error during stopServer in SIGTERM shutdown",
      timeoutMessage: "Forced exit after SIGTERM shutdown timeout"
    });
  });
  process.on("SIGHUP", () => {
    shutdownOnce({
      exitCode: 0,
      message: "Received SIGHUP, shutting down...",
      stopServerErrorMessage: "Error during stopServer in SIGHUP shutdown",
      timeoutMessage: "Forced exit after SIGHUP shutdown timeout"
    });
  });
  process.on("uncaughtException", (error) => {
    if (isShuttingDown) return;
    if (isTransientError(error)) {
      const transientErrorCount = recordTransientErrorInWindow(
        transientErrorTimestamps,
        node_perf_hooks.performance.now(),
        TRANSIENT_ERROR_WINDOW_MS
      );
      log2(
        "warn",
        `Transient uncaught error #${transientErrorCount}/${MAX_TRANSIENT_ERRORS} in last ${TRANSIENT_ERROR_WINDOW_SECONDS}s (${getTransientErrorIdentifier(error)}), keeping sessions alive`
      );
      if (transientErrorCount >= MAX_TRANSIENT_ERRORS) {
        shutdownOnce({
          exitCode: 1,
          message: `Too many transient errors in ${TRANSIENT_ERROR_WINDOW_SECONDS}s window, shutting down`,
          stopServerErrorMessage: "Error during stopServer in fatal error shutdown",
          timeoutMessage: "Forced exit after fatal error shutdown timeout"
        });
      }
      return;
    }
    log2("error", "Uncaught exception", {
      error: error.message,
      stack: error.stack
    });
    shutdownOnce({
      exitCode: 1,
      stopServerErrorMessage: "Error during stopServer in fatal shutdown",
      timeoutMessage: "Forced exit after shutdown timeout"
    });
  });
  process.on("unhandledRejection", (reason) => {
    if (isShuttingDown) return;
    if (isTransientError(reason)) {
      const transientErrorCount = recordTransientErrorInWindow(
        transientErrorTimestamps,
        node_perf_hooks.performance.now(),
        TRANSIENT_ERROR_WINDOW_MS
      );
      log2(
        "warn",
        `Transient unhandled rejection #${transientErrorCount}/${MAX_TRANSIENT_ERRORS}, in last ${TRANSIENT_ERROR_WINDOW_SECONDS}s, (${getTransientErrorIdentifier(reason)}), keeping sessions alive`
      );
      if (transientErrorCount >= MAX_TRANSIENT_ERRORS) {
        shutdownOnce({
          exitCode: 1,
          message: `Too many transient rejections in ${TRANSIENT_ERROR_WINDOW_SECONDS}s window (${transientErrorCount}/${MAX_TRANSIENT_ERRORS}), shutting down`,
          stopServerErrorMessage: "Error during stopServer in fatal rejection shutdown",
          timeoutMessage: "Forced exit after fatal rejection shutdown timeout"
        });
      }
      return;
    }
    log2("error", "Unhandled rejection", { reason });
    shutdownOnce({
      exitCode: 1,
      stopServerErrorMessage: "Error during stopServer in fatal shutdown",
      timeoutMessage: "Forced exit after shutdown timeout"
    });
  });
}
if (typeof window === "undefined") {
  globalThis.window = globalThis;
}
var m = 0, b = 0, _ = 0, p = 0;
var g;
((t) => {
  function l(r, a, s, i) {
    return i !== void 0 ? `#${w(r)}${w(a)}${w(s)}${w(i)}` : `#${w(r)}${w(a)}${w(s)}`;
  }
  t.toCss = l;
  function n(r, a, s, i = 255) {
    return (r << 24 | a << 16 | s << 8 | i) >>> 0;
  }
  t.toRgba = n;
  function e(r, a, s, i) {
    return { css: t.toCss(r, a, s, i), rgba: t.toRgba(r, a, s, i) };
  }
  t.toColor = e;
})(g ||= {});
var U;
((i) => {
  function l(o, u) {
    if (p = (u.rgba & 255) / 255, p === 1) return { css: u.css, rgba: u.rgba };
    let f = u.rgba >> 24 & 255, C = u.rgba >> 16 & 255, c = u.rgba >> 8 & 255, h = o.rgba >> 24 & 255, d = o.rgba >> 16 & 255, I = o.rgba >> 8 & 255;
    m = h + Math.round((f - h) * p), b = d + Math.round((C - d) * p), _ = I + Math.round((c - I) * p);
    let L = g.toCss(m, b, _), E = g.toRgba(m, b, _);
    return { css: L, rgba: E };
  }
  i.blend = l;
  function n(o) {
    return (o.rgba & 255) === 255;
  }
  i.isOpaque = n;
  function e(o, u, f) {
    let C = B.ensureContrastRatio(o.rgba, u.rgba, f);
    if (C) return g.toColor(C >> 24 & 255, C >> 16 & 255, C >> 8 & 255);
  }
  i.ensureContrastRatio = e;
  function t(o) {
    let u = (o.rgba | 255) >>> 0;
    return [m, b, _] = B.toChannels(u), { css: g.toCss(m, b, _), rgba: u };
  }
  i.opaque = t;
  function r(o, u) {
    return p = Math.round(u * 255), [m, b, _] = B.toChannels(o.rgba), { css: g.toCss(m, b, _, p), rgba: g.toRgba(m, b, _, p) };
  }
  i.opacity = r;
  function a(o, u) {
    return p = o.rgba & 255, r(o, p * u / 255);
  }
  i.multiplyOpacity = a;
  function s(o) {
    return [o.rgba >> 24 & 255, o.rgba >> 16 & 255, o.rgba >> 8 & 255];
  }
  i.toColorRGB = s;
})(U ||= {});
var x;
((t) => {
  let l, n;
  try {
    let r = document.createElement("canvas");
    r.width = 1, r.height = 1;
    let a = r.getContext("2d", { willReadFrequently: true });
    a && (l = a, l.globalCompositeOperation = "copy", n = l.createLinearGradient(0, 0, 1, 1));
  } catch {
  }
  function e(r) {
    if (r.match(/#[\da-f]{3,8}/i)) switch (r.length) {
      case 4:
        return m = parseInt(r.slice(1, 2).repeat(2), 16), b = parseInt(r.slice(2, 3).repeat(2), 16), _ = parseInt(r.slice(3, 4).repeat(2), 16), g.toColor(m, b, _);
      case 5:
        return m = parseInt(r.slice(1, 2).repeat(2), 16), b = parseInt(r.slice(2, 3).repeat(2), 16), _ = parseInt(r.slice(3, 4).repeat(2), 16), p = parseInt(r.slice(4, 5).repeat(2), 16), g.toColor(m, b, _, p);
      case 7:
        return { css: r, rgba: (parseInt(r.slice(1), 16) << 8 | 255) >>> 0 };
      case 9:
        return { css: r, rgba: parseInt(r.slice(1), 16) >>> 0 };
    }
    let a = r.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)/);
    if (a) return m = parseInt(a[1]), b = parseInt(a[2]), _ = parseInt(a[3]), p = Math.round((a[5] === void 0 ? 1 : parseFloat(a[5])) * 255), g.toColor(m, b, _, p);
    if (r === "transparent") return { css: "transparent", rgba: 0 };
    if (!l || !n) throw new Error("css.toColor: Unsupported css format");
    if (l.fillStyle = n, l.fillStyle = r, typeof l.fillStyle != "string") throw new Error("css.toColor: Unsupported css format");
    if (l.fillRect(0, 0, 1, 1), [m, b, _, p] = l.getImageData(0, 0, 1, 1).data, p !== 255) throw new Error("css.toColor: Unsupported css format");
    return { rgba: g.toRgba(m, b, _, p), css: r };
  }
  t.toColor = e;
})(x ||= {});
var v;
((e) => {
  function l(t) {
    return n(t >> 16 & 255, t >> 8 & 255, t & 255);
  }
  e.relativeLuminance = l;
  function n(t, r, a) {
    let s = t / 255, i = r / 255, o = a / 255, u = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4), f = i <= 0.03928 ? i / 12.92 : Math.pow((i + 0.055) / 1.055, 2.4), C = o <= 0.03928 ? o / 12.92 : Math.pow((o + 0.055) / 1.055, 2.4);
    return u * 0.2126 + f * 0.7152 + C * 0.0722;
  }
  e.relativeLuminance2 = n;
})(v ||= {});
var B;
((a) => {
  function l(s, i) {
    if (p = (i & 255) / 255, p === 1) return i;
    let o = i >> 24 & 255, u = i >> 16 & 255, f = i >> 8 & 255, C = s >> 24 & 255, c = s >> 16 & 255, h = s >> 8 & 255;
    return m = C + Math.round((o - C) * p), b = c + Math.round((u - c) * p), _ = h + Math.round((f - h) * p), g.toRgba(m, b, _);
  }
  a.blend = l;
  function n(s, i, o) {
    let u = v.relativeLuminance(s >> 8), f = v.relativeLuminance(i >> 8);
    if (F(u, f) < o) {
      if (f < u) {
        let d = e(s, i, o), I = F(u, v.relativeLuminance(d >> 8));
        if (I < o) {
          let L = t(s, i, o), E = F(u, v.relativeLuminance(L >> 8));
          return I > E ? d : L;
        }
        return d;
      }
      let c = t(s, i, o), h = F(u, v.relativeLuminance(c >> 8));
      if (h < o) {
        let d = e(s, i, o), I = F(u, v.relativeLuminance(d >> 8));
        return h > I ? c : d;
      }
      return c;
    }
  }
  a.ensureContrastRatio = n;
  function e(s, i, o) {
    let u = s >> 24 & 255, f = s >> 16 & 255, C = s >> 8 & 255, c = i >> 24 & 255, h = i >> 16 & 255, d = i >> 8 & 255, I = F(v.relativeLuminance2(c, h, d), v.relativeLuminance2(u, f, C));
    for (; I < o && (c > 0 || h > 0 || d > 0); ) c -= Math.max(0, Math.ceil(c * 0.1)), h -= Math.max(0, Math.ceil(h * 0.1)), d -= Math.max(0, Math.ceil(d * 0.1)), I = F(v.relativeLuminance2(c, h, d), v.relativeLuminance2(u, f, C));
    return (c << 24 | h << 16 | d << 8 | 255) >>> 0;
  }
  a.reduceLuminance = e;
  function t(s, i, o) {
    let u = s >> 24 & 255, f = s >> 16 & 255, C = s >> 8 & 255, c = i >> 24 & 255, h = i >> 16 & 255, d = i >> 8 & 255, I = F(v.relativeLuminance2(c, h, d), v.relativeLuminance2(u, f, C));
    for (; I < o && (c < 255 || h < 255 || d < 255); ) c = Math.min(255, c + Math.ceil((255 - c) * 0.1)), h = Math.min(255, h + Math.ceil((255 - h) * 0.1)), d = Math.min(255, d + Math.ceil((255 - d) * 0.1)), I = F(v.relativeLuminance2(c, h, d), v.relativeLuminance2(u, f, C));
    return (c << 24 | h << 16 | d << 8 | 255) >>> 0;
  }
  a.increaseLuminance = t;
  function r(s) {
    return [s >> 24 & 255, s >> 16 & 255, s >> 8 & 255, s & 255];
  }
  a.toChannels = r;
})(B ||= {});
function w(l) {
  let n = l.toString(16);
  return n.length < 2 ? "0" + n : n;
}
function F(l, n) {
  return l < n ? (n + 0.05) / (l + 0.05) : (l + 0.05) / (n + 0.05);
}
var T = Object.freeze((() => {
  let l = [x.toColor("#2e3436"), x.toColor("#cc0000"), x.toColor("#4e9a06"), x.toColor("#c4a000"), x.toColor("#3465a4"), x.toColor("#75507b"), x.toColor("#06989a"), x.toColor("#d3d7cf"), x.toColor("#555753"), x.toColor("#ef2929"), x.toColor("#8ae234"), x.toColor("#fce94f"), x.toColor("#729fcf"), x.toColor("#ad7fa8"), x.toColor("#34e2e2"), x.toColor("#eeeeec")], n = [0, 95, 135, 175, 215, 255];
  for (let e = 0; e < 216; e++) {
    let t = n[e / 36 % 6 | 0], r = n[e / 6 % 6 | 0], a = n[e % 6];
    l.push({ css: g.toCss(t, r, a), rgba: g.toRgba(t, r, a) });
  }
  for (let e = 0; e < 24; e++) {
    let t = 8 + e * 10;
    l.push({ css: g.toCss(t, t, t), rgba: g.toRgba(t, t, t) });
  }
  return l;
})());
function M(l, n, e) {
  return Math.max(n, Math.min(l, e));
}
function z(l) {
  switch (l) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
  }
  return l;
}
var S = class {
  constructor(n) {
    this._buffer = n;
  }
  serialize(n, e) {
    let t = this._buffer.getNullCell(), r = this._buffer.getNullCell(), a = t, s = n.start.y, i = n.end.y, o = n.start.x, u = n.end.x;
    this._beforeSerialize(i - s, s, i);
    for (let f = s; f <= i; f++) {
      let C = this._buffer.getLine(f);
      if (C) {
        let c = f === n.start.y ? o : 0, h = f === n.end.y ? u : C.length;
        for (let d = c; d < h; d++) {
          let I = C.getCell(d, a === t ? r : t);
          if (!I) {
            console.warn(`Can't get cell at row=${f}, col=${d}`);
            continue;
          }
          this._nextCell(I, a, f, d), a = I;
        }
      }
      this._rowEnd(f, f === i);
    }
    return this._afterSerialize(), this._serializeString(e);
  }
  _nextCell(n, e, t, r) {
  }
  _rowEnd(n, e) {
  }
  _beforeSerialize(n, e, t) {
  }
  _afterSerialize() {
  }
  _serializeString(n) {
    return "";
  }
};
function A(l, n) {
  return l.getFgColorMode() === n.getFgColorMode() && l.getFgColor() === n.getFgColor();
}
function R(l, n) {
  return l.getBgColorMode() === n.getBgColorMode() && l.getBgColor() === n.getBgColor();
}
function H(l, n) {
  if (!l.isUnderline() && !n.isUnderline()) return true;
  let e = l, t = n;
  return e.getUnderlineStyle() === t.getUnderlineStyle() && e.getUnderlineColor() === t.getUnderlineColor() && e.getUnderlineColorMode() === t.getUnderlineColorMode();
}
function O(l, n) {
  return l.isInverse() === n.isInverse() && l.isBold() === n.isBold() && l.isUnderline() === n.isUnderline() && H(l, n) && l.isOverline() === n.isOverline() && l.isBlink() === n.isBlink() && l.isInvisible() === n.isInvisible() && l.isItalic() === n.isItalic() && l.isDim() === n.isDim() && l.isStrikethrough() === n.isStrikethrough();
}
var y = class extends S {
  constructor(e, t) {
    super(e);
    this._terminal = t;
    this._rowIndex = 0;
    this._allRows = new Array();
    this._allRowSeparators = new Array();
    this._currentRow = "";
    this._nullCellCount = 0;
    this._cursorStyle = this._buffer.getNullCell();
    this._cursorStyleRow = 0;
    this._cursorStyleCol = 0;
    this._backgroundCell = this._buffer.getNullCell();
    this._firstRow = 0;
    this._lastCursorRow = 0;
    this._lastCursorCol = 0;
    this._lastContentCursorRow = 0;
    this._lastContentCursorCol = 0;
    this._thisRowLastChar = this._buffer.getNullCell();
    this._thisRowLastSecondChar = this._buffer.getNullCell();
    this._nextRowFirstChar = this._buffer.getNullCell();
  }
  _beforeSerialize(e, t, r) {
    this._allRows = new Array(e), this._lastContentCursorRow = t, this._lastCursorRow = t, this._firstRow = t;
  }
  _rowEnd(e, t) {
    this._nullCellCount > 0 && !R(this._cursorStyle, this._backgroundCell) && (this._currentRow += `\x1B[${this._nullCellCount}X`);
    let r = "";
    if (!t) {
      e - this._firstRow >= this._terminal.rows && this._buffer.getLine(this._cursorStyleRow)?.getCell(this._cursorStyleCol, this._backgroundCell);
      let a = this._buffer.getLine(e), s = this._buffer.getLine(e + 1);
      if (!s.isWrapped) r = `\r
`, this._lastCursorRow = e + 1, this._lastCursorCol = 0;
      else {
        r = "";
        let i = a.getCell(a.length - 1, this._thisRowLastChar), o = a.getCell(a.length - 2, this._thisRowLastSecondChar), u = s.getCell(0, this._nextRowFirstChar), f = u.getWidth() > 1, C = false;
        (u.getChars() && f ? this._nullCellCount <= 1 : this._nullCellCount <= 0) && ((i.getChars() || i.getWidth() === 0) && R(i, u) && (C = true), f && (o.getChars() || o.getWidth() === 0) && R(i, u) && R(o, u) && (C = true)), C || (r = "-".repeat(this._nullCellCount + 1), r += "\x1B[1D\x1B[1X", this._nullCellCount > 0 && (r += "\x1B[A", r += `\x1B[${a.length - this._nullCellCount}C`, r += `\x1B[${this._nullCellCount}X`, r += `\x1B[${a.length - this._nullCellCount}D`, r += "\x1B[B"), this._lastContentCursorRow = e + 1, this._lastContentCursorCol = 0, this._lastCursorRow = e + 1, this._lastCursorCol = 0);
      }
    }
    this._allRows[this._rowIndex] = this._currentRow, this._allRowSeparators[this._rowIndex++] = r, this._currentRow = "", this._nullCellCount = 0;
  }
  _diffStyle(e, t) {
    let r = [], a = !A(e, t), s = !R(e, t), i = !O(e, t);
    if (a || s || i) if (e.isAttributeDefault()) t.isAttributeDefault() || r.push(0);
    else {
      if (a) {
        let o = e.getFgColor();
        e.isFgRGB() ? r.push(38, 2, o >>> 16 & 255, o >>> 8 & 255, o & 255) : e.isFgPalette() ? o >= 16 ? r.push(38, 5, o) : r.push(o & 8 ? 90 + (o & 7) : 30 + (o & 7)) : r.push(39);
      }
      if (s) {
        let o = e.getBgColor();
        e.isBgRGB() ? r.push(48, 2, o >>> 16 & 255, o >>> 8 & 255, o & 255) : e.isBgPalette() ? o >= 16 ? r.push(48, 5, o) : r.push(o & 8 ? 100 + (o & 7) : 40 + (o & 7)) : r.push(49);
      }
      if (i) {
        if (e.isInverse() !== t.isInverse() && r.push(e.isInverse() ? 7 : 27), e.isBold() !== t.isBold() && r.push(e.isBold() ? 1 : 22), H(e, t)) e.isUnderline() !== t.isUnderline() && r.push(e.isUnderline() ? 4 : 24);
        else {
          let o = e, u = o.getUnderlineStyle();
          if (u === 0) r.push(24);
          else if (r.push("4:" + u), !o.isUnderlineColorDefault()) {
            let f = o.getUnderlineColor();
            o.isUnderlineColorRGB() ? r.push("58:2::" + (f >>> 16 & 255) + ":" + (f >>> 8 & 255) + ":" + (f & 255)) : r.push("58:5:" + f);
          }
        }
        e.isOverline() !== t.isOverline() && r.push(e.isOverline() ? 53 : 55), e.isBlink() !== t.isBlink() && r.push(e.isBlink() ? 5 : 25), e.isInvisible() !== t.isInvisible() && r.push(e.isInvisible() ? 8 : 28), e.isItalic() !== t.isItalic() && r.push(e.isItalic() ? 3 : 23), e.isDim() !== t.isDim() && r.push(e.isDim() ? 2 : 22), e.isStrikethrough() !== t.isStrikethrough() && r.push(e.isStrikethrough() ? 9 : 29);
      }
    }
    return r;
  }
  _nextCell(e, t, r, a) {
    if (e.getWidth() === 0) return;
    let i = e.getChars() === "", o = this._diffStyle(e, this._cursorStyle);
    if (i ? !R(this._cursorStyle, e) : o.length > 0) {
      this._nullCellCount > 0 && (R(this._cursorStyle, this._backgroundCell) || (this._currentRow += `\x1B[${this._nullCellCount}X`), this._currentRow += `\x1B[${this._nullCellCount}C`, this._nullCellCount = 0), this._lastContentCursorRow = this._lastCursorRow = r, this._lastContentCursorCol = this._lastCursorCol = a, this._currentRow += `\x1B[${o.join(";")}m`;
      let f = this._buffer.getLine(r);
      f !== void 0 && (f.getCell(a, this._cursorStyle), this._cursorStyleRow = r, this._cursorStyleCol = a);
    }
    i ? this._nullCellCount += e.getWidth() : (this._nullCellCount > 0 && (R(this._cursorStyle, this._backgroundCell) ? this._currentRow += `\x1B[${this._nullCellCount}C` : (this._currentRow += `\x1B[${this._nullCellCount}X`, this._currentRow += `\x1B[${this._nullCellCount}C`), this._nullCellCount = 0), this._currentRow += e.getChars(), this._lastContentCursorRow = this._lastCursorRow = r, this._lastContentCursorCol = this._lastCursorCol = a + e.getWidth());
  }
  _serializeString(e) {
    let t = this._allRows.length;
    this._buffer.length - this._firstRow <= this._terminal.rows && (t = this._lastContentCursorRow + 1 - this._firstRow, this._lastCursorCol = this._lastContentCursorCol, this._lastCursorRow = this._lastContentCursorRow);
    let r = "";
    for (let i = 0; i < t; i++) r += this._allRows[i], i + 1 < t && (r += this._allRowSeparators[i]);
    if (!e) {
      let i = this._buffer.baseY + this._buffer.cursorY, o = this._buffer.cursorX, u = i !== this._lastCursorRow || o !== this._lastCursorCol, f = (c) => {
        c > 0 ? r += `\x1B[${c}C` : c < 0 && (r += `\x1B[${-c}D`);
      };
      u && (((c) => {
        c > 0 ? r += `\x1B[${c}B` : c < 0 && (r += `\x1B[${-c}A`);
      })(i - this._lastCursorRow), f(o - this._lastCursorCol));
    }
    let a = this._terminal._core._inputHandler._curAttrData, s = this._diffStyle(a, this._cursorStyle);
    return s.length > 0 && (r += `\x1B[${s.join(";")}m`), r;
  }
}, k = class {
  activate(n) {
    this._terminal = n;
  }
  _serializeBufferByScrollback(n, e, t) {
    let r = e.length, a = t === void 0 ? r : M(t + n.rows, 0, r);
    return this._serializeBufferByRange(n, e, { start: r - a, end: r - 1 }, false);
  }
  _serializeBufferByRange(n, e, t, r) {
    return new y(e, n).serialize({ start: { x: 0, y: typeof t.start == "number" ? t.start : t.start.line }, end: { x: n.cols, y: typeof t.end == "number" ? t.end : t.end.line } }, r);
  }
  _serializeBufferAsHTML(n, e) {
    let t = n.buffer.active, r = new D(t, n, e), a = e.onlySelection ?? false, s = e.range;
    if (s) return r.serialize({ start: { x: s.startCol, y: (typeof s.startLine == "number", s.startLine) }, end: { x: n.cols, y: (typeof s.endLine == "number", s.endLine) } });
    if (!a) {
      let o = t.length, u = e.scrollback, f = u === void 0 ? o : M(u + n.rows, 0, o);
      return r.serialize({ start: { x: 0, y: o - f }, end: { x: n.cols, y: o - 1 } });
    }
    let i = this._terminal?.getSelectionPosition();
    return i !== void 0 ? r.serialize({ start: { x: i.start.x, y: i.start.y }, end: { x: i.end.x, y: i.end.y } }) : "";
  }
  _serializeScrollRegion(n) {
    let e = n._core.buffer, t = e.scrollTop, r = e.scrollBottom;
    return t !== 0 || r !== n.rows - 1 ? `\x1B[${t + 1};${r + 1}r` : "";
  }
  _serializeModes(n) {
    let e = "", t = n.modes;
    if (t.applicationCursorKeysMode && (e += "\x1B[?1h"), t.applicationKeypadMode && (e += "\x1B[?66h"), t.bracketedPasteMode && (e += "\x1B[?2004h"), t.insertMode && (e += "\x1B[4h"), t.originMode && (e += "\x1B[?6h"), t.reverseWraparoundMode && (e += "\x1B[?45h"), t.sendFocusMode && (e += "\x1B[?1004h"), t.wraparoundMode === false && (e += "\x1B[?7l"), t.mouseTrackingMode !== "none") switch (t.mouseTrackingMode) {
      case "x10":
        e += "\x1B[?9h";
        break;
      case "vt200":
        e += "\x1B[?1000h";
        break;
      case "drag":
        e += "\x1B[?1002h";
        break;
      case "any":
        e += "\x1B[?1003h";
        break;
    }
    return t.showCursor || (e += "\x1B[?25l"), e;
  }
  serialize(n) {
    if (!this._terminal) throw new Error("Cannot use addon until it has been loaded");
    let e = n?.range ? this._serializeBufferByRange(this._terminal, this._terminal.buffer.normal, n.range, true) : this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.normal, n?.scrollback);
    if (!n?.excludeAltBuffer && this._terminal.buffer.active.type === "alternate") {
      let t = this._serializeBufferByScrollback(this._terminal, this._terminal.buffer.alternate, void 0);
      e += `\x1B[?1049h\x1B[H${t}`;
    }
    return n?.excludeModes || (e += this._serializeModes(this._terminal), e += this._serializeScrollRegion(this._terminal)), e;
  }
  serializeAsHTML(n) {
    if (!this._terminal) throw new Error("Cannot use addon until it has been loaded");
    return this._serializeBufferAsHTML(this._terminal, n ?? {});
  }
  dispose() {
  }
}, D = class extends S {
  constructor(e, t, r) {
    super(e);
    this._terminal = t;
    this._options = r;
    this._currentRow = "";
    this._htmlContent = "";
    t._core._themeService ? this._ansiColors = t._core._themeService.colors.ansi : this._ansiColors = T;
  }
  _beforeSerialize(e, t, r) {
    this._htmlContent += "<html><body><!--StartFragment--><pre>";
    let a = "#000000", s = "#ffffff";
    (this._options.includeGlobalBackground ?? false) && (a = this._terminal.options.theme?.foreground ?? "#ffffff", s = this._terminal.options.theme?.background ?? "#000000");
    let i = [];
    i.push("color: " + a + ";"), i.push("background-color: " + s + ";"), i.push("font-family: " + this._terminal.options.fontFamily + ";"), i.push("font-size: " + this._terminal.options.fontSize + "px;"), this._htmlContent += "<div style='" + i.join(" ") + "'>";
  }
  _afterSerialize() {
    this._htmlContent += "</div>", this._htmlContent += "</pre><!--EndFragment--></body></html>";
  }
  _rowEnd(e, t) {
    this._htmlContent += "<div><span>" + this._currentRow + "</span></div>", this._currentRow = "";
  }
  _getHexColor(e, t) {
    let r = t ? e.getFgColor() : e.getBgColor();
    if (t ? e.isFgRGB() : e.isBgRGB()) return "#" + [r >> 16 & 255, r >> 8 & 255, r & 255].map((s) => s.toString(16).padStart(2, "0")).join("");
    if (t ? e.isFgPalette() : e.isBgPalette()) return this._ansiColors[r].css;
  }
  _getUnderlineColor(e) {
    let t = e;
    if (t.isUnderlineColorDefault()) return;
    let r = t.getUnderlineColor();
    return t.isUnderlineColorRGB() ? "#" + [r >> 16 & 255, r >> 8 & 255, r & 255].map((s) => s.toString(16).padStart(2, "0")).join("") : this._ansiColors[r].css;
  }
  _getUnderlineStyle(e) {
    switch (e.getUnderlineStyle()) {
      case 1:
        return "underline";
      case 2:
        return "underline double";
      case 3:
        return "underline wavy";
      case 4:
        return "underline dotted";
      case 5:
        return "underline dashed";
      default:
        return "underline";
    }
  }
  _diffStyle(e, t) {
    let r = [], a = !A(e, t), s = !R(e, t), i = !O(e, t);
    if (a || s || i) {
      let o = this._getHexColor(e, true);
      o && r.push("color: " + o + ";");
      let u = this._getHexColor(e, false);
      u && r.push("background-color: " + u + ";"), e.isInverse() && r.push("color: #000000; background-color: #BFBFBF;"), e.isBold() && r.push("font-weight: bold;");
      let f = [];
      if (e.isUnderline() && f.push(this._getUnderlineStyle(e)), e.isOverline() && f.push("overline"), e.isStrikethrough() && f.push("line-through"), e.isBlink() && f.push("blink"), f.length > 0 && r.push("text-decoration: " + f.join(" ") + ";"), e.isUnderline()) {
        let C = this._getUnderlineColor(e);
        C && r.push("text-decoration-color: " + C + ";");
      }
      return e.isInvisible() && r.push("visibility: hidden;"), e.isItalic() && r.push("font-style: italic;"), e.isDim() && r.push("opacity: 0.5;"), r;
    }
  }
  _nextCell(e, t, r, a) {
    if (e.getWidth() === 0) return;
    let i = e.getChars() === "", o = this._diffStyle(e, t);
    o && (this._currentRow += o.length === 0 ? "</span><span>" : "</span><span style='" + o.join(" ") + "'>"), i ? this._currentRow += " " : this._currentRow += z(e.getChars());
  }
  _serializeString() {
    return this._htmlContent;
  }
};
var xtermHeadless = {};
var hasRequiredXtermHeadless;
function requireXtermHeadless() {
  if (hasRequiredXtermHeadless) return xtermHeadless;
  hasRequiredXtermHeadless = 1;
  (function(exports$1) {
    (() => {
      var e = { 25(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.InstantiationService = t2.ServiceCollection = void 0;
        const s2 = i2(501), r2 = i2(201);
        class n2 {
          constructor(...e3) {
            this._entries = /* @__PURE__ */ new Map();
            for (const [t3, i3] of e3) this.set(t3, i3);
          }
          set(e3, t3) {
            const i3 = this._entries.get(e3);
            return this._entries.set(e3, t3), i3;
          }
          forEach(e3) {
            for (const [t3, i3] of this._entries.entries()) e3(t3, i3);
          }
          has(e3) {
            return this._entries.has(e3);
          }
          get(e3) {
            return this._entries.get(e3);
          }
        }
        t2.ServiceCollection = n2, t2.InstantiationService = class {
          constructor() {
            this._services = new n2(), this._services.set(s2.IInstantiationService, this);
          }
          setService(e3, t3) {
            this._services.set(e3, t3);
          }
          getService(e3) {
            return this._services.get(e3);
          }
          createInstance(e3, ...t3) {
            const i3 = (0, r2.getServiceDependencies)(e3).sort((e4, t4) => e4.index - t4.index), s3 = [];
            for (const t4 of i3) {
              const i4 = this._services.get(t4.id);
              if (!i4) throw new Error(`[createInstance] ${e3.name} depends on UNKNOWN service ${t4.id._id}.`);
              s3.push(i4);
            }
            const n3 = i3.length > 0 ? i3[0].index : t3.length;
            if (t3.length !== n3) throw new Error(`[createInstance] First service dependency of ${e3.name} at position ${n3 + 1} conflicts with ${t3.length} static arguments`);
            return new e3(...[...t3, ...s3]);
          }
        };
      }, 27(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.AddonManager = void 0, t2.AddonManager = class {
          constructor() {
            this._addons = [];
          }
          dispose() {
            for (let e3 = this._addons.length - 1; e3 >= 0; e3--) this._addons[e3].instance.dispose();
          }
          loadAddon(e3, t3) {
            const i2 = { instance: t3, dispose: t3.dispose, isDisposed: false };
            this._addons.push(i2), t3.dispose = () => this._wrappedAddonDispose(i2), t3.activate(e3);
          }
          _wrappedAddonDispose(e3) {
            if (e3.isDisposed) return;
            let t3 = -1;
            for (let i2 = 0; i2 < this._addons.length; i2++) if (this._addons[i2] === e3) {
              t3 = i2;
              break;
            }
            if (-1 === t3) throw new Error("Could not dispose an addon that has not been loaded");
            e3.isDisposed = true, e3.dispose.apply(e3.instance), this._addons.splice(t3, 1);
          }
        };
      }, 55(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CellData = void 0;
        const s2 = i2(726), r2 = i2(938), n2 = i2(451);
        class a extends n2.AttributeData {
          constructor() {
            super(...arguments), this.content = 0, this.fg = 0, this.bg = 0, this.extended = new n2.ExtendedAttrs(), this.combinedData = "";
          }
          static fromCharData(e3) {
            const t3 = new a();
            return t3.setFromCharData(e3), t3;
          }
          isCombined() {
            return 2097152 & this.content;
          }
          getWidth() {
            return this.content >> 22;
          }
          getChars() {
            return 2097152 & this.content ? this.combinedData : 2097151 & this.content ? (0, s2.stringFromCodePoint)(2097151 & this.content) : "";
          }
          getCode() {
            return this.isCombined() ? this.combinedData.charCodeAt(this.combinedData.length - 1) : 2097151 & this.content;
          }
          setFromCharData(e3) {
            this.fg = e3[r2.CHAR_DATA_ATTR_INDEX], this.bg = 0;
            let t3 = false;
            if (e3[r2.CHAR_DATA_CHAR_INDEX].length > 2) t3 = true;
            else if (2 === e3[r2.CHAR_DATA_CHAR_INDEX].length) {
              const i3 = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(0);
              if (55296 <= i3 && i3 <= 56319) {
                const s3 = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(1);
                56320 <= s3 && s3 <= 57343 ? this.content = 1024 * (i3 - 55296) + s3 - 56320 + 65536 | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22 : t3 = true;
              } else t3 = true;
            } else this.content = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22;
            t3 && (this.combinedData = e3[r2.CHAR_DATA_CHAR_INDEX], this.content = 2097152 | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22);
          }
          getAsCharData() {
            return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
          }
        }
        t2.CellData = a;
      }, 56(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OptionsService = t2.DEFAULT_OPTIONS = void 0;
        const s2 = i2(812), r2 = i2(701), n2 = i2(636);
        t2.DEFAULT_OPTIONS = { cols: 80, rows: 24, showCursorImmediately: false, cursorBlink: false, blinkIntervalDuration: 0, cursorStyle: "block", cursorWidth: 1, cursorInactiveStyle: "outline", drawBoldTextInBrightColors: true, documentOverride: null, fastScrollSensitivity: 5, fontFamily: "monospace", fontSize: 15, fontWeight: "normal", fontWeightBold: "bold", ignoreBracketedPasteMode: false, lineHeight: 1, letterSpacing: 0, linkHandler: null, logLevel: "info", logger: null, scrollback: 1e3, scrollbar: { showScrollbar: true }, scrollOnEraseInDisplay: false, scrollOnUserInput: true, scrollSensitivity: 1, screenReaderMode: false, smoothScrollDuration: 0, macOptionIsMeta: false, macOptionClickForcesSelection: false, minimumContrastRatio: 1, disableStdin: false, allowProposedApi: false, allowTransparency: false, tabStopWidth: 8, theme: {}, reflowCursorLine: false, rescaleOverlappingGlyphs: false, rightClickSelectsWord: r2.isMac, windowOptions: {}, windowsPty: {}, wordSeparator: " ()[]{}',\"`", altClickMovesCursor: true, convertEol: false, termName: "xterm", quirks: {}, vtExtensions: {} };
        const a = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
        class o extends s2.Disposable {
          constructor(e3) {
            super(), this._onOptionChange = this._register(new n2.Emitter()), this.onOptionChange = this._onOptionChange.event;
            const i3 = { ...t2.DEFAULT_OPTIONS };
            for (const t3 in e3) if (t3 in i3) try {
              const s3 = e3[t3];
              i3[t3] = this._sanitizeAndValidateOption(t3, s3);
            } catch (e4) {
              console.error(e4);
            }
            this.rawOptions = i3, this.options = { ...i3 }, this._setupOptions(), this._register((0, s2.toDisposable)(() => {
              this.rawOptions.linkHandler = null, this.rawOptions.documentOverride = null;
            }));
          }
          onSpecificOptionChange(e3, t3) {
            return this.onOptionChange((i3) => {
              i3 === e3 && t3(this.rawOptions[e3]);
            });
          }
          onMultipleOptionChange(e3, t3) {
            return this.onOptionChange((i3) => {
              -1 !== e3.indexOf(i3) && t3();
            });
          }
          _setupOptions() {
            const e3 = (e4) => {
              if (!(e4 in t2.DEFAULT_OPTIONS)) throw new Error(`No option with key "${e4}"`);
              return this.rawOptions[e4];
            }, i3 = (e4, i4) => {
              if (!(e4 in t2.DEFAULT_OPTIONS)) throw new Error(`No option with key "${e4}"`);
              i4 = this._sanitizeAndValidateOption(e4, i4), this.rawOptions[e4] !== i4 && (this.rawOptions[e4] = i4, this._onOptionChange.fire(e4));
            };
            for (const t3 in this.rawOptions) {
              const s3 = { get: e3.bind(this, t3), set: i3.bind(this, t3) };
              Object.defineProperty(this.options, t3, s3);
            }
          }
          _sanitizeAndValidateOption(e3, i3) {
            switch (e3) {
              case "cursorStyle":
                if (i3 || (i3 = t2.DEFAULT_OPTIONS[e3]), !/* @__PURE__ */ (function(e4) {
                  return "block" === e4 || "underline" === e4 || "bar" === e4;
                })(i3)) throw new Error(`"${i3}" is not a valid value for ${e3}`);
                break;
              case "wordSeparator":
                i3 || (i3 = t2.DEFAULT_OPTIONS[e3]);
                break;
              case "fontWeight":
              case "fontWeightBold":
                if ("number" == typeof i3 && 1 <= i3 && i3 <= 1e3) break;
                i3 = a.includes(i3) ? i3 : t2.DEFAULT_OPTIONS[e3];
                break;
              case "blinkIntervalDuration":
                if ((i3 = Math.floor(i3)) < 0) throw new Error(`${e3} cannot be less than 0, value: ${i3}`);
                break;
              case "cursorWidth":
                i3 = Math.floor(i3);
              case "lineHeight":
              case "tabStopWidth":
                if (i3 < 1) throw new Error(`${e3} cannot be less than 1, value: ${i3}`);
                break;
              case "minimumContrastRatio":
                i3 = Math.max(1, Math.min(21, Math.round(10 * i3) / 10));
                break;
              case "scrollback":
                if ((i3 = Math.min(i3, 4294967295)) < 0) throw new Error(`${e3} cannot be less than 0, value: ${i3}`);
                break;
              case "fastScrollSensitivity":
              case "scrollSensitivity":
                if (i3 <= 0) throw new Error(`${e3} cannot be less than or equal to 0, value: ${i3}`);
                break;
              case "rows":
              case "cols":
                if (!i3 && 0 !== i3) throw new Error(`${e3} must be numeric, value: ${i3}`);
                break;
              case "windowsPty":
                i3 = i3 ?? {};
            }
            return i3;
          }
        }
        t2.OptionsService = o;
      }, 71(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CoreService = void 0;
        const n2 = i2(453), a = i2(812), o = i2(501), h = i2(636), c = Object.freeze({ insertMode: false }), l = Object.freeze({ applicationCursorKeys: false, applicationKeypad: false, bracketedPasteMode: false, colorSchemeUpdates: false, cursorBlink: void 0, cursorStyle: void 0, origin: false, reverseWraparound: false, sendFocus: false, synchronizedOutput: false, win32InputMode: false, wraparound: true });
        let _2 = class extends a.Disposable {
          constructor(e3, t3, i3) {
            super(), this._bufferService = e3, this._logService = t3, this._optionsService = i3, this.isCursorHidden = false, this._onData = this._register(new h.Emitter()), this.onData = this._onData.event, this._onUserInput = this._register(new h.Emitter()), this.onUserInput = this._onUserInput.event, this._onBinary = this._register(new h.Emitter()), this.onBinary = this._onBinary.event, this._onRequestScrollToBottom = this._register(new h.Emitter()), this.onRequestScrollToBottom = this._onRequestScrollToBottom.event, this.isCursorInitialized = i3.rawOptions.showCursorImmediately ?? false, this.modes = (0, n2.clone)(c), this.decPrivateModes = (0, n2.clone)(l), this.kittyKeyboard = { flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] };
          }
          reset() {
            this.modes = (0, n2.clone)(c), this.decPrivateModes = (0, n2.clone)(l), this.kittyKeyboard = { flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] };
          }
          triggerDataEvent(e3, t3 = false) {
            if (this._optionsService.rawOptions.disableStdin) return;
            const i3 = this._bufferService.buffer;
            t3 && this._optionsService.rawOptions.scrollOnUserInput && i3.ybase !== i3.ydisp && this._onRequestScrollToBottom.fire(), t3 && this._onUserInput.fire(), this._logService.debug(`sending data "${e3}"`), this._logService.trace("sending data (codes)", () => e3.split("").map((e4) => e4.charCodeAt(0))), this._onData.fire(e3);
          }
          triggerBinaryEvent(e3) {
            this._optionsService.rawOptions.disableStdin || (this._logService.debug(`sending binary "${e3}"`), this._logService.trace("sending binary (codes)", () => e3.split("").map((e4) => e4.charCodeAt(0))), this._onBinary.fire(e3));
          }
        };
        t2.CoreService = _2, t2.CoreService = _2 = s2([r2(0, o.IBufferService), r2(1, o.ILogService), r2(2, o.IOptionsService)], _2);
      }, 73(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Buffer = t2.MAX_BUFFER_SIZE = void 0;
        const s2 = i2(639), r2 = i2(168), n2 = i2(451), a = i2(107), o = i2(732), h = i2(55), c = i2(938), l = i2(158), _2 = i2(760);
        t2.MAX_BUFFER_SIZE = 4294967295, t2.Buffer = class {
          constructor(e3, t3, i3, n3) {
            this._hasScrollback = e3, this._optionsService = t3, this._bufferService = i3, this._logService = n3, this.ydisp = 0, this.ybase = 0, this.y = 0, this.x = 0, this.tabs = {}, this.savedY = 0, this.savedX = 0, this.savedCurAttrData = a.DEFAULT_ATTR_DATA.clone(), this.savedCharset = _2.DEFAULT_CHARSET, this.savedCharsets = [], this.savedGlevel = 0, this.savedOriginMode = false, this.savedWraparoundMode = true, this.markers = [], this._nullCell = h.CellData.fromCharData([0, c.NULL_CELL_CHAR, c.NULL_CELL_WIDTH, c.NULL_CELL_CODE]), this._whitespaceCell = h.CellData.fromCharData([0, c.WHITESPACE_CELL_CHAR, c.WHITESPACE_CELL_WIDTH, c.WHITESPACE_CELL_CODE]), this._isClearing = false, this._memoryCleanupPosition = 0, this._cols = this._bufferService.cols, this._rows = this._bufferService.rows, this.lines = new s2.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops(), this._memoryCleanupQueue = new r2.IdleTaskQueue(this._logService);
          }
          getNullCell(e3) {
            return e3 ? (this._nullCell.fg = e3.fg, this._nullCell.bg = e3.bg, this._nullCell.extended = e3.extended) : (this._nullCell.fg = 0, this._nullCell.bg = 0, this._nullCell.extended = new n2.ExtendedAttrs()), this._nullCell;
          }
          getWhitespaceCell(e3) {
            return e3 ? (this._whitespaceCell.fg = e3.fg, this._whitespaceCell.bg = e3.bg, this._whitespaceCell.extended = e3.extended) : (this._whitespaceCell.fg = 0, this._whitespaceCell.bg = 0, this._whitespaceCell.extended = new n2.ExtendedAttrs()), this._whitespaceCell;
          }
          getBlankLine(e3, t3) {
            return new a.BufferLine(this._bufferService.cols, this.getNullCell(e3), t3);
          }
          get hasScrollback() {
            return this._hasScrollback && this.lines.maxLength > this._rows;
          }
          get isCursorInViewport() {
            const e3 = this.ybase + this.y - this.ydisp;
            return e3 >= 0 && e3 < this._rows;
          }
          _getCorrectBufferLength(e3) {
            if (!this._hasScrollback) return e3;
            const i3 = e3 + this._optionsService.rawOptions.scrollback;
            return i3 > t2.MAX_BUFFER_SIZE ? t2.MAX_BUFFER_SIZE : i3;
          }
          fillViewportRows(e3) {
            if (0 === this.lines.length) {
              e3 ??= a.DEFAULT_ATTR_DATA;
              let t3 = this._rows;
              for (; t3--; ) this.lines.push(this.getBlankLine(e3));
            }
          }
          clear() {
            this.ydisp = 0, this.ybase = 0, this.y = 0, this.x = 0, this.lines = new s2.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops();
          }
          resize(e3, t3) {
            const i3 = this.getNullCell(a.DEFAULT_ATTR_DATA);
            let s3 = 0;
            const r3 = this._getCorrectBufferLength(t3);
            if (r3 > this.lines.maxLength && (this.lines.maxLength = r3), this.lines.length > 0) {
              if (this._cols < e3) for (let t4 = 0; t4 < this.lines.length; t4++) s3 += +this.lines.get(t4).resize(e3, i3);
              let n3 = 0;
              if (this._rows < t3) for (let s4 = this._rows; s4 < t3; s4++) this.lines.length < t3 + this.ybase && (void 0 !== this._optionsService.rawOptions.windowsPty.backend || void 0 !== this._optionsService.rawOptions.windowsPty.buildNumber ? this.lines.push(new a.BufferLine(e3, i3)) : this.ybase > 0 && this.lines.length <= this.ybase + this.y + n3 + 1 ? (this.ybase--, n3++, this.ydisp > 0 && this.ydisp--) : this.lines.push(new a.BufferLine(e3, i3)));
              else for (let e4 = this._rows; e4 > t3; e4--) this.lines.length > t3 + this.ybase && (this.lines.length > this.ybase + this.y + 1 ? this.lines.pop() : (this.ybase++, this.ydisp++));
              if (r3 < this.lines.maxLength) {
                const e4 = this.lines.length - r3;
                e4 > 0 && (this.lines.trimStart(e4), this.ybase = Math.max(this.ybase - e4, 0), this.ydisp = Math.max(this.ydisp - e4, 0), this.savedY = Math.max(this.savedY - e4, 0)), this.lines.maxLength = r3;
              }
              this.x = Math.min(this.x, e3 - 1), this.y = Math.min(this.y, t3 - 1), n3 && (this.y += n3), this.savedX = Math.min(this.savedX, e3 - 1), this.scrollTop = 0;
            }
            if (this.scrollBottom = t3 - 1, this._isReflowEnabled && (this._reflow(e3, t3), this._cols > e3)) for (let t4 = 0; t4 < this.lines.length; t4++) s3 += +this.lines.get(t4).resize(e3, i3);
            if (this._cols = e3, this._rows = t3, this.lines.length > 0) {
              const e4 = Math.max(0, this.lines.length - this.ybase - 1);
              this.y = Math.min(this.y, e4);
            }
            this._memoryCleanupQueue.clear(), s3 > 0.1 * this.lines.length && (this._memoryCleanupPosition = 0, this._memoryCleanupQueue.enqueue(() => this._batchedMemoryCleanup()));
          }
          _batchedMemoryCleanup() {
            let e3 = true;
            this._memoryCleanupPosition >= this.lines.length && (this._memoryCleanupPosition = 0, e3 = false);
            let t3 = 0;
            for (; this._memoryCleanupPosition < this.lines.length; ) if (t3 += this.lines.get(this._memoryCleanupPosition++).cleanupMemory(), t3 > 100) return true;
            return e3;
          }
          get _isReflowEnabled() {
            const e3 = this._optionsService.rawOptions.windowsPty;
            return e3 && e3.buildNumber ? this._hasScrollback && "conpty" === e3.backend && e3.buildNumber >= 21376 : this._hasScrollback;
          }
          _reflow(e3, t3) {
            this._cols !== e3 && (e3 > this._cols ? this._reflowLarger(e3, t3) : this._reflowSmaller(e3, t3));
          }
          _reflowLarger(e3, t3) {
            const i3 = this._optionsService.rawOptions.reflowCursorLine, s3 = (0, o.reflowLargerGetLinesToRemove)(this.lines, this._cols, e3, this.ybase + this.y, this.getNullCell(a.DEFAULT_ATTR_DATA), i3);
            if (s3.length > 0) {
              const i4 = (0, o.reflowLargerCreateNewLayout)(this.lines, s3);
              (0, o.reflowLargerApplyNewLayout)(this.lines, i4.layout), this._reflowLargerAdjustViewport(e3, t3, i4.countRemoved);
            }
          }
          _reflowLargerAdjustViewport(e3, t3, i3) {
            const s3 = this.getNullCell(a.DEFAULT_ATTR_DATA);
            let r3 = i3;
            for (; r3-- > 0; ) 0 === this.ybase ? (this.y > 0 && this.y--, this.lines.length < t3 && this.lines.push(new a.BufferLine(e3, s3))) : (this.ydisp === this.ybase && this.ydisp--, this.ybase--);
            this.savedY = Math.max(this.savedY - i3, 0);
          }
          _reflowSmaller(e3, t3) {
            const i3 = this._optionsService.rawOptions.reflowCursorLine, s3 = this.getNullCell(a.DEFAULT_ATTR_DATA), r3 = [];
            let n3 = 0;
            for (let h2 = this.lines.length - 1; h2 >= 0; h2--) {
              let c2 = this.lines.get(h2);
              if (!c2 || !c2.isWrapped && c2.getTrimmedLength() <= e3) continue;
              const l2 = [c2];
              for (; c2.isWrapped && h2 > 0; ) c2 = this.lines.get(--h2), l2.unshift(c2);
              if (!i3) {
                const e4 = this.ybase + this.y;
                if (e4 >= h2 && e4 < h2 + l2.length) continue;
              }
              const _3 = l2[l2.length - 1].getTrimmedLength(), d = (0, o.reflowSmallerGetNewLineLengths)(l2, this._cols, e3), f = d.length - l2.length;
              let u;
              u = 0 === this.ybase && this.y !== this.lines.length - 1 ? Math.max(0, this.y - this.lines.maxLength + f) : Math.max(0, this.lines.length - this.lines.maxLength + f);
              const p2 = [];
              for (let e4 = 0; e4 < f; e4++) {
                const e5 = this.getBlankLine(a.DEFAULT_ATTR_DATA, true);
                p2.push(e5);
              }
              p2.length > 0 && (r3.push({ start: h2 + l2.length + n3, newLines: p2 }), n3 += p2.length), l2.push(...p2);
              let g2 = d.length - 1, v2 = d[g2];
              0 === v2 && (g2--, v2 = d[g2]);
              let b2 = l2.length - f - 1, S2 = _3;
              for (; b2 >= 0; ) {
                const e4 = Math.min(S2, v2);
                if (void 0 === l2[g2]) break;
                if (l2[g2].copyCellsFrom(l2[b2], S2 - e4, v2 - e4, e4, true), v2 -= e4, 0 === v2 && (g2--, v2 = d[g2]), S2 -= e4, 0 === S2) {
                  b2--;
                  const e5 = Math.max(b2, 0);
                  S2 = (0, o.getWrappedLineTrimmedLength)(l2, e5, this._cols);
                }
              }
              for (let t4 = 0; t4 < l2.length; t4++) d[t4] < e3 && l2[t4].setCell(d[t4], s3);
              let m2 = f - u;
              for (; m2-- > 0; ) 0 === this.ybase ? this.y < t3 - 1 ? (this.y++, this.lines.pop()) : (this.ybase++, this.ydisp++) : this.ybase < Math.min(this.lines.maxLength, this.lines.length + n3) - t3 && (this.ybase === this.ydisp && this.ydisp++, this.ybase++);
              this.savedY = Math.min(this.savedY + f, this.ybase + t3 - 1);
            }
            if (r3.length > 0) {
              const e4 = [], t4 = [];
              for (let e5 = 0; e5 < this.lines.length; e5++) t4.push(this.lines.get(e5));
              const i4 = this.lines.length;
              let s4 = i4 - 1, a2 = 0, o2 = r3[a2];
              this.lines.length = Math.min(this.lines.maxLength, this.lines.length + n3);
              let h2 = 0;
              for (let c3 = Math.min(this.lines.maxLength - 1, i4 + n3 - 1); c3 >= 0; c3--) if (o2 && o2.start > s4 + h2) {
                for (let e5 = o2.newLines.length - 1; e5 >= 0; e5--) this.lines.set(c3--, o2.newLines[e5]);
                c3++, e4.push({ index: s4 + 1, amount: o2.newLines.length }), h2 += o2.newLines.length, o2 = r3[++a2];
              } else this.lines.set(c3, t4[s4--]);
              let c2 = 0;
              for (let t5 = e4.length - 1; t5 >= 0; t5--) e4[t5].index += c2, this.lines.onInsertEmitter.fire(e4[t5]), c2 += e4[t5].amount;
              const l2 = Math.max(0, i4 + n3 - this.lines.maxLength);
              l2 > 0 && this.lines.onTrimEmitter.fire(l2);
            }
          }
          translateBufferLineToString(e3, t3, i3 = 0, s3) {
            const r3 = this.lines.get(e3);
            return r3 ? r3.translateToString(t3, i3, s3) : "";
          }
          getWrappedRangeForLine(e3) {
            let t3 = e3, i3 = e3;
            for (; t3 > 0 && this.lines.get(t3).isWrapped; ) t3--;
            for (; i3 + 1 < this.lines.length && this.lines.get(i3 + 1).isWrapped; ) i3++;
            return { first: t3, last: i3 };
          }
          setupTabStops(e3) {
            for (null != e3 ? this.tabs[e3] || (e3 = this.prevStop(e3)) : (this.tabs = {}, e3 = 0); e3 < this._cols; e3 += this._optionsService.rawOptions.tabStopWidth) this.tabs[e3] = true;
          }
          prevStop(e3) {
            for (e3 ??= this.x; !this.tabs[--e3] && e3 > 0; ) ;
            return e3 >= this._cols ? this._cols - 1 : e3 < 0 ? 0 : e3;
          }
          nextStop(e3) {
            for (e3 ??= this.x; !this.tabs[++e3] && e3 < this._cols; ) ;
            return e3 >= this._cols ? this._cols - 1 : e3 < 0 ? 0 : e3;
          }
          clearMarkers(e3) {
            this._isClearing = true;
            for (let t3 = 0; t3 < this.markers.length; t3++) this.markers[t3].line === e3 && (this.markers[t3].dispose(), this.markers.splice(t3--, 1));
            this._isClearing = false;
          }
          clearAllMarkers() {
            this._isClearing = true;
            for (let e3 = 0; e3 < this.markers.length; e3++) this.markers[e3].dispose();
            this.markers.length = 0, this._isClearing = false;
          }
          addMarker(e3) {
            const t3 = new l.Marker(e3);
            return this.markers.push(t3), t3.register(this.lines.onTrim((e4) => {
              t3.line -= e4, t3.line < 0 && t3.dispose();
            })), t3.register(this.lines.onInsert((e4) => {
              t3.line >= e4.index && (t3.line += e4.amount);
            })), t3.register(this.lines.onDelete((e4) => {
              t3.line >= e4.index && t3.line < e4.index + e4.amount && t3.dispose(), t3.line > e4.index && (t3.line -= e4.amount);
            })), t3.register(t3.onDispose(() => this._removeMarker(t3))), t3;
          }
          _removeMarker(e3) {
            this._isClearing || this.markers.splice(this.markers.indexOf(e3), 1);
          }
        };
      }, 97(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ParserApi = void 0, t2.ParserApi = class {
          constructor(e3) {
            this._core = e3;
          }
          registerCsiHandler(e3, t3) {
            return this._core.registerCsiHandler(e3, (e4) => t3(e4.toArray()));
          }
          addCsiHandler(e3, t3) {
            return this.registerCsiHandler(e3, t3);
          }
          registerDcsHandler(e3, t3) {
            return this._core.registerDcsHandler(e3, (e4, i2) => t3(e4, i2.toArray()));
          }
          addDcsHandler(e3, t3) {
            return this.registerDcsHandler(e3, t3);
          }
          registerEscHandler(e3, t3) {
            return this._core.registerEscHandler(e3, t3);
          }
          addEscHandler(e3, t3) {
            return this.registerEscHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._core.registerOscHandler(e3, t3);
          }
          addOscHandler(e3, t3) {
            return this.registerOscHandler(e3, t3);
          }
          registerApcHandler(e3, t3) {
            return this._core.registerApcHandler(e3, t3);
          }
        };
      }, 101(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferNamespaceApi = void 0;
        const s2 = i2(235), r2 = i2(812), n2 = i2(636);
        class a extends r2.Disposable {
          constructor(e3) {
            super(), this._core = e3, this._onBufferChange = this._register(new n2.Emitter()), this.onBufferChange = this._onBufferChange.event, this._normal = new s2.BufferApiView(this._core.buffers.normal, "normal"), this._alternate = new s2.BufferApiView(this._core.buffers.alt, "alternate"), this._core.buffers.onBufferActivate(() => this._onBufferChange.fire(this.active));
          }
          get active() {
            if (this._core.buffers.active === this._core.buffers.normal) return this.normal;
            if (this._core.buffers.active === this._core.buffers.alt) return this.alternate;
            throw new Error("Active buffer is neither normal nor alternate");
          }
          get normal() {
            return this._normal.init(this._core.buffers.normal);
          }
          get alternate() {
            return this._alternate.init(this._core.buffers.alt);
          }
        }
        t2.BufferNamespaceApi = a;
      }, 107(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferLine = t2.DEFAULT_ATTR_DATA = void 0;
        const s2 = i2(451), r2 = i2(55), n2 = i2(938), a = i2(726);
        t2.DEFAULT_ATTR_DATA = Object.freeze(new s2.AttributeData());
        let o = 0;
        const h = new r2.CellData();
        class c {
          constructor(e3, t3, i3 = false) {
            this.isWrapped = i3, this._combined = {}, this._extendedAttrs = {}, this._data = new Uint32Array(3 * e3);
            const s3 = t3 ?? r2.CellData.fromCharData([0, n2.NULL_CELL_CHAR, n2.NULL_CELL_WIDTH, n2.NULL_CELL_CODE]);
            for (let t4 = 0; t4 < e3; ++t4) this.setCell(t4, s3);
            this.length = e3;
          }
          get(e3) {
            const t3 = this._data[3 * e3 + 0], i3 = 2097151 & t3;
            return [this._data[3 * e3 + 1], 2097152 & t3 ? this._combined[e3] : i3 ? (0, a.stringFromCodePoint)(i3) : "", t3 >> 22, 2097152 & t3 ? this._combined[e3].charCodeAt(this._combined[e3].length - 1) : i3];
          }
          set(e3, t3) {
            this._data[3 * e3 + 1] = t3[n2.CHAR_DATA_ATTR_INDEX], t3[n2.CHAR_DATA_CHAR_INDEX].length > 1 ? (this._combined[e3] = t3[1], this._data[3 * e3 + 0] = 2097152 | e3 | t3[n2.CHAR_DATA_WIDTH_INDEX] << 22) : this._data[3 * e3 + 0] = t3[n2.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | t3[n2.CHAR_DATA_WIDTH_INDEX] << 22;
          }
          getWidth(e3) {
            return this._data[3 * e3 + 0] >> 22;
          }
          hasWidth(e3) {
            return 12582912 & this._data[3 * e3 + 0];
          }
          getFg(e3) {
            return this._data[3 * e3 + 1];
          }
          getBg(e3) {
            return this._data[3 * e3 + 2];
          }
          hasContent(e3) {
            return 4194303 & this._data[3 * e3 + 0];
          }
          getCodePoint(e3) {
            const t3 = this._data[3 * e3 + 0];
            return 2097152 & t3 ? this._combined[e3].charCodeAt(this._combined[e3].length - 1) : 2097151 & t3;
          }
          isCombined(e3) {
            return 2097152 & this._data[3 * e3 + 0];
          }
          getString(e3) {
            const t3 = this._data[3 * e3 + 0];
            return 2097152 & t3 ? this._combined[e3] : 2097151 & t3 ? (0, a.stringFromCodePoint)(2097151 & t3) : "";
          }
          isProtected(e3) {
            return 536870912 & this._data[3 * e3 + 2];
          }
          loadCell(e3, t3) {
            return o = 3 * e3, t3.content = this._data[o + 0], t3.fg = this._data[o + 1], t3.bg = this._data[o + 2], 2097152 & t3.content && (t3.combinedData = this._combined[e3]), 268435456 & t3.bg && (t3.extended = this._extendedAttrs[e3]), t3;
          }
          setCell(e3, t3) {
            2097152 & t3.content && (this._combined[e3] = t3.combinedData), 268435456 & t3.bg && (this._extendedAttrs[e3] = t3.extended), this._data[3 * e3 + 0] = t3.content, this._data[3 * e3 + 1] = t3.fg, this._data[3 * e3 + 2] = t3.bg;
          }
          setCellFromCodepoint(e3, t3, i3, s3) {
            268435456 & s3.bg && (this._extendedAttrs[e3] = s3.extended), this._data[3 * e3 + 0] = t3 | i3 << 22, this._data[3 * e3 + 1] = s3.fg, this._data[3 * e3 + 2] = s3.bg;
          }
          addCodepointToCell(e3, t3, i3) {
            let s3 = this._data[3 * e3 + 0];
            2097152 & s3 ? this._combined[e3] += (0, a.stringFromCodePoint)(t3) : 2097151 & s3 ? (this._combined[e3] = (0, a.stringFromCodePoint)(2097151 & s3) + (0, a.stringFromCodePoint)(t3), s3 &= -2097152, s3 |= 2097152) : s3 = t3 | 1 << 22, i3 && (s3 &= -12582913, s3 |= i3 << 22), this._data[3 * e3 + 0] = s3;
          }
          insertCells(e3, t3, i3) {
            if ((e3 %= this.length) && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length - e3) {
              for (let i4 = this.length - e3 - t3 - 1; i4 >= 0; --i4) this.setCell(e3 + t3 + i4, this.loadCell(e3 + i4, h));
              for (let s3 = 0; s3 < t3; ++s3) this.setCell(e3 + s3, i3);
            } else for (let t4 = e3; t4 < this.length; ++t4) this.setCell(t4, i3);
            2 === this.getWidth(this.length - 1) && this.setCellFromCodepoint(this.length - 1, 0, 1, i3);
          }
          deleteCells(e3, t3, i3) {
            if (e3 %= this.length, t3 < this.length - e3) {
              for (let i4 = 0; i4 < this.length - e3 - t3; ++i4) this.setCell(e3 + i4, this.loadCell(e3 + t3 + i4, h));
              for (let e4 = this.length - t3; e4 < this.length; ++e4) this.setCell(e4, i3);
            } else for (let t4 = e3; t4 < this.length; ++t4) this.setCell(t4, i3);
            e3 && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), 0 !== this.getWidth(e3) || this.hasContent(e3) || this.setCellFromCodepoint(e3, 0, 1, i3);
          }
          replaceCells(e3, t3, i3, s3 = false) {
            if (s3) for (e3 && 2 === this.getWidth(e3 - 1) && !this.isProtected(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length && 2 === this.getWidth(t3 - 1) && !this.isProtected(t3) && this.setCellFromCodepoint(t3, 0, 1, i3); e3 < t3 && e3 < this.length; ) this.isProtected(e3) || this.setCell(e3, i3), e3++;
            else for (e3 && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length && 2 === this.getWidth(t3 - 1) && this.setCellFromCodepoint(t3, 0, 1, i3); e3 < t3 && e3 < this.length; ) this.setCell(e3++, i3);
          }
          resize(e3, t3) {
            if (e3 === this.length) return 4 * this._data.length * 2 < this._data.buffer.byteLength;
            const i3 = 3 * e3;
            if (e3 > this.length) {
              if (this._data.buffer.byteLength >= 4 * i3) this._data = new Uint32Array(this._data.buffer, 0, i3);
              else {
                const e4 = new Uint32Array(i3);
                e4.set(this._data), this._data = e4;
              }
              for (let i4 = this.length; i4 < e3; ++i4) this.setCell(i4, t3);
            } else {
              this._data = this._data.subarray(0, i3);
              const t4 = Object.keys(this._combined);
              for (let i4 = 0; i4 < t4.length; i4++) {
                const s4 = parseInt(t4[i4], 10);
                s4 >= e3 && delete this._combined[s4];
              }
              const s3 = Object.keys(this._extendedAttrs);
              for (let t5 = 0; t5 < s3.length; t5++) {
                const i4 = parseInt(s3[t5], 10);
                i4 >= e3 && delete this._extendedAttrs[i4];
              }
            }
            return this.length = e3, 4 * i3 * 2 < this._data.buffer.byteLength;
          }
          cleanupMemory() {
            if (4 * this._data.length * 2 < this._data.buffer.byteLength) {
              const e3 = new Uint32Array(this._data.length);
              return e3.set(this._data), this._data = e3, 1;
            }
            return 0;
          }
          fill(e3, t3 = false) {
            if (t3) for (let t4 = 0; t4 < this.length; ++t4) this.isProtected(t4) || this.setCell(t4, e3);
            else {
              this._combined = {}, this._extendedAttrs = {};
              for (let t4 = 0; t4 < this.length; ++t4) this.setCell(t4, e3);
            }
          }
          copyFrom(e3) {
            this.length !== e3.length ? this._data = new Uint32Array(e3._data) : this._data.set(e3._data), this.length = e3.length, this._combined = {};
            for (const t3 in e3._combined) this._combined[t3] = e3._combined[t3];
            this._extendedAttrs = {};
            for (const t3 in e3._extendedAttrs) this._extendedAttrs[t3] = e3._extendedAttrs[t3];
            this.isWrapped = e3.isWrapped;
          }
          clone() {
            const e3 = new c(0);
            e3._data = new Uint32Array(this._data), e3.length = this.length;
            for (const t3 in this._combined) e3._combined[t3] = this._combined[t3];
            for (const t3 in this._extendedAttrs) e3._extendedAttrs[t3] = this._extendedAttrs[t3];
            return e3.isWrapped = this.isWrapped, e3;
          }
          getTrimmedLength() {
            for (let e3 = this.length - 1; e3 >= 0; --e3) if (4194303 & this._data[3 * e3 + 0]) return e3 + (this._data[3 * e3 + 0] >> 22);
            return 0;
          }
          getNoBgTrimmedLength() {
            for (let e3 = this.length - 1; e3 >= 0; --e3) if (4194303 & this._data[3 * e3 + 0] || 50331648 & this._data[3 * e3 + 2]) return e3 + (this._data[3 * e3 + 0] >> 22);
            return 0;
          }
          copyCellsFrom(e3, t3, i3, s3, r3) {
            const n3 = e3._data;
            if (r3) for (let r4 = s3 - 1; r4 >= 0; r4--) {
              for (let e4 = 0; e4 < 3; e4++) this._data[3 * (i3 + r4) + e4] = n3[3 * (t3 + r4) + e4];
              268435456 & n3[3 * (t3 + r4) + 2] && (this._extendedAttrs[i3 + r4] = e3._extendedAttrs[t3 + r4]);
            }
            else for (let r4 = 0; r4 < s3; r4++) {
              for (let e4 = 0; e4 < 3; e4++) this._data[3 * (i3 + r4) + e4] = n3[3 * (t3 + r4) + e4];
              268435456 & n3[3 * (t3 + r4) + 2] && (this._extendedAttrs[i3 + r4] = e3._extendedAttrs[t3 + r4]);
            }
            const a2 = Object.keys(e3._combined);
            for (let s4 = 0; s4 < a2.length; s4++) {
              const r4 = parseInt(a2[s4], 10);
              r4 >= t3 && (this._combined[r4 - t3 + i3] = e3._combined[r4]);
            }
          }
          translateToString(e3, t3, i3, s3) {
            t3 = t3 ?? 0, i3 = i3 ?? this.length, e3 && (i3 = Math.min(i3, this.getTrimmedLength())), s3 && (s3.length = 0);
            let r3 = "";
            for (; t3 < i3; ) {
              const e4 = this._data[3 * t3 + 0], i4 = 2097151 & e4, o2 = 2097152 & e4 ? this._combined[t3] : i4 ? (0, a.stringFromCodePoint)(i4) : n2.WHITESPACE_CELL_CHAR;
              if (r3 += o2, s3) for (let e5 = 0; e5 < o2.length; ++e5) s3.push(t3);
              t3 += e4 >> 22 || 1;
            }
            return s3 && s3.push(t3), r3;
          }
        }
        t2.BufferLine = c;
      }, 158(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Marker = void 0;
        const s2 = i2(636), r2 = i2(812);
        class n2 {
          get id() {
            return this._id;
          }
          constructor(e3) {
            this.line = e3, this.isDisposed = false, this._disposables = [], this._id = n2._nextId++, this._onDispose = this.register(new s2.Emitter()), this.onDispose = this._onDispose.event;
          }
          dispose() {
            this.isDisposed || (this.isDisposed = true, this.line = -1, this._onDispose.fire(), (0, r2.dispose)(this._disposables), this._disposables.length = 0);
          }
          register(e3) {
            return this._disposables.push(e3), e3;
          }
        }
        t2.Marker = n2, n2._nextId = 1;
      }, 168(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DebouncedIdleTask = t2.IdleTaskQueue = t2.PriorityTaskQueue = void 0;
        const s2 = i2(701);
        class r2 {
          constructor(e3) {
            this._tasks = [], this._i = 0, this._logService = e3;
          }
          enqueue(e3) {
            this._tasks.push(e3), this._start();
          }
          flush() {
            for (; this._i < this._tasks.length; ) this._tasks[this._i]() || this._i++;
            this.clear();
          }
          clear() {
            this._idleCallback && (this._cancelCallback(this._idleCallback), this._idleCallback = void 0), this._i = 0, this._tasks.length = 0;
          }
          _start() {
            this._idleCallback || (this._idleCallback = this._requestCallback(this._process.bind(this)));
          }
          _process(e3) {
            this._idleCallback = void 0;
            let t3 = 0, i3 = 0, s3 = e3.timeRemaining(), r3 = 0;
            for (; this._i < this._tasks.length; ) {
              if (t3 = performance.now(), this._tasks[this._i]() || this._i++, t3 = Math.max(1, performance.now() - t3), i3 = Math.max(t3, i3), r3 = e3.timeRemaining(), 1.5 * i3 > r3) return s3 - t3 < -20 && this._logService.warn(`task queue exceeded allotted deadline by ${Math.abs(Math.round(s3 - t3))}ms`), void this._start();
              s3 = r3;
            }
            this.clear();
          }
        }
        class n2 extends r2 {
          _requestCallback(e3) {
            return setTimeout(() => e3(this._createDeadline(16)));
          }
          _cancelCallback(e3) {
            clearTimeout(e3);
          }
          _createDeadline(e3) {
            const t3 = performance.now() + e3;
            return { timeRemaining: () => Math.max(0, t3 - performance.now()) };
          }
        }
        t2.PriorityTaskQueue = n2, t2.IdleTaskQueue = !s2.isNode && "requestIdleCallback" in window ? class extends r2 {
          _requestCallback(e3) {
            return requestIdleCallback(e3);
          }
          _cancelCallback(e3) {
            cancelIdleCallback(e3);
          }
        } : n2, t2.DebouncedIdleTask = class {
          constructor(e3) {
            this._queue = new t2.IdleTaskQueue(e3);
          }
          set(e3) {
            this._queue.clear(), this._queue.enqueue(e3);
          }
          flush() {
            this._queue.flush();
          }
        };
      }, 201(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.serviceRegistry = void 0, t2.getServiceDependencies = function(e3) {
          return e3[s2] || [];
        }, t2.createDecorator = function(e3) {
          if (t2.serviceRegistry.has(e3)) return t2.serviceRegistry.get(e3);
          const r2 = function(e4, t3, n2) {
            if (3 !== arguments.length) throw new Error("@IServiceName-decorator can only be used to decorate a parameter");
            !(function(e5, t4, r3) {
              t4[i2] === t4 ? t4[s2].push({ id: e5, index: r3 }) : (t4[s2] = [{ id: e5, index: r3 }], t4[i2] = t4);
            })(r2, e4, n2);
          };
          return r2._id = e3, t2.serviceRegistry.set(e3, r2), r2;
        };
        const i2 = "di$target", s2 = "di$dependencies";
        t2.serviceRegistry = /* @__PURE__ */ new Map();
      }, 235(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferApiView = void 0;
        const s2 = i2(793), r2 = i2(55);
        t2.BufferApiView = class {
          constructor(e3, t3) {
            this._buffer = e3, this.type = t3;
          }
          init(e3) {
            return this._buffer = e3, this;
          }
          get cursorY() {
            return this._buffer.y;
          }
          get cursorX() {
            return this._buffer.x;
          }
          get viewportY() {
            return this._buffer.ydisp;
          }
          get baseY() {
            return this._buffer.ybase;
          }
          get length() {
            return this._buffer.lines.length;
          }
          getLine(e3) {
            const t3 = this._buffer.lines.get(e3);
            if (t3) return new s2.BufferLineApiView(t3);
          }
          getNullCell() {
            return new r2.CellData();
          }
        };
      }, 262(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Params = void 0;
        const i2 = 2147483647;
        class s2 {
          static fromArray(e3) {
            const t3 = new s2();
            if (!e3.length) return t3;
            for (let i3 = Array.isArray(e3[0]) ? 1 : 0; i3 < e3.length; ++i3) {
              const s3 = e3[i3];
              if (Array.isArray(s3)) for (let e4 = 0; e4 < s3.length; ++e4) t3.addSubParam(s3[e4]);
              else t3.addParam(s3);
            }
            return t3;
          }
          constructor(e3 = 32, t3 = 32) {
            if (this.maxLength = e3, this.maxSubParamsLength = t3, t3 > 256) throw new Error("maxSubParamsLength must not be greater than 256");
            this.params = new Int32Array(e3), this.length = 0, this._subParams = new Int32Array(t3), this._subParamsLength = 0, this._subParamsIdx = new Uint16Array(e3), this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
          }
          clone() {
            const e3 = new s2(this.maxLength, this.maxSubParamsLength);
            return e3.params.set(this.params), e3.length = this.length, e3._subParams.set(this._subParams), e3._subParamsLength = this._subParamsLength, e3._subParamsIdx.set(this._subParamsIdx), e3._rejectDigits = this._rejectDigits, e3._rejectSubDigits = this._rejectSubDigits, e3._digitIsSub = this._digitIsSub, e3;
          }
          toArray() {
            const e3 = [];
            for (let t3 = 0; t3 < this.length; ++t3) {
              e3.push(this.params[t3]);
              const i3 = this._subParamsIdx[t3] >> 8, s3 = 255 & this._subParamsIdx[t3];
              s3 - i3 > 0 && e3.push(Array.prototype.slice.call(this._subParams, i3, s3));
            }
            return e3;
          }
          reset() {
            this.length = 0, this._subParamsLength = 0, this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
          }
          addParam(e3) {
            if (this._digitIsSub = false, this.length >= this.maxLength) this._rejectDigits = true;
            else {
              if (e3 < -1) throw new Error("values lesser than -1 are not allowed");
              this._subParamsIdx[this.length] = this._subParamsLength << 8 | this._subParamsLength, this.params[this.length++] = e3 > i2 ? i2 : e3;
            }
          }
          addSubParam(e3) {
            if (this._digitIsSub = true, this.length) if (this._rejectDigits || this._subParamsLength >= this.maxSubParamsLength) this._rejectSubDigits = true;
            else {
              if (e3 < -1) throw new Error("values lesser than -1 are not allowed");
              this._subParams[this._subParamsLength++] = e3 > i2 ? i2 : e3, this._subParamsIdx[this.length - 1]++;
            }
          }
          hasSubParams(e3) {
            return (255 & this._subParamsIdx[e3]) - (this._subParamsIdx[e3] >> 8) > 0;
          }
          getSubParams(e3) {
            const t3 = this._subParamsIdx[e3] >> 8, i3 = 255 & this._subParamsIdx[e3];
            return i3 - t3 > 0 ? this._subParams.subarray(t3, i3) : null;
          }
          getSubParamsAll() {
            const e3 = {};
            for (let t3 = 0; t3 < this.length; ++t3) {
              const i3 = this._subParamsIdx[t3] >> 8, s3 = 255 & this._subParamsIdx[t3];
              s3 - i3 > 0 && (e3[t3] = this._subParams.slice(i3, s3));
            }
            return e3;
          }
          addDigit(e3) {
            let t3;
            if (this._rejectDigits || !(t3 = this._digitIsSub ? this._subParamsLength : this.length) || this._digitIsSub && this._rejectSubDigits) return;
            const s3 = this._digitIsSub ? this._subParams : this.params, r2 = s3[t3 - 1];
            s3[t3 - 1] = ~r2 ? Math.min(10 * r2 + e3, i2) : e3;
          }
        }
        t2.Params = s2;
      }, 276(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.LogService = void 0;
        const n2 = i2(812), a = i2(501), o = { trace: a.LogLevelEnum.TRACE, debug: a.LogLevelEnum.DEBUG, info: a.LogLevelEnum.INFO, warn: a.LogLevelEnum.WARN, error: a.LogLevelEnum.ERROR, off: a.LogLevelEnum.OFF };
        let h = class extends n2.Disposable {
          get logLevel() {
            return this._logLevel;
          }
          constructor(e3) {
            super(), this._optionsService = e3, this._logLevel = a.LogLevelEnum.OFF, this._updateLogLevel(), this._register(this._optionsService.onSpecificOptionChange("logLevel", () => this._updateLogLevel()));
          }
          _updateLogLevel() {
            this._logLevel = o[this._optionsService.rawOptions.logLevel];
          }
          _evalLazyOptionalParams(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) "function" == typeof e3[t3] && (e3[t3] = e3[t3]());
          }
          _log(e3, t3, i3) {
            this._evalLazyOptionalParams(i3), e3.call(console, (this._optionsService.options.logger ? "" : "xterm.js: ") + t3, ...i3);
          }
          trace(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.TRACE && this._log(this._optionsService.options.logger?.trace.bind(this._optionsService.options.logger) ?? console.log, e3, t3);
          }
          debug(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.DEBUG && this._log(this._optionsService.options.logger?.debug.bind(this._optionsService.options.logger) ?? console.log, e3, t3);
          }
          info(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.INFO && this._log(this._optionsService.options.logger?.info.bind(this._optionsService.options.logger) ?? console.info, e3, t3);
          }
          warn(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.WARN && this._log(this._optionsService.options.logger?.warn.bind(this._optionsService.options.logger) ?? console.warn, e3, t3);
          }
          error(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.ERROR && this._log(this._optionsService.options.logger?.error.bind(this._optionsService.options.logger) ?? console.error, e3, t3);
          }
        };
        t2.LogService = h, t2.LogService = h = s2([r2(0, a.IOptionsService)], h);
      }, 335(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeApi = void 0, t2.UnicodeApi = class {
          constructor(e3) {
            this._core = e3;
          }
          register(e3) {
            this._core.unicodeService.register(e3);
          }
          get versions() {
            return this._core.unicodeService.versions;
          }
          get activeVersion() {
            return this._core.unicodeService.activeVersion;
          }
          set activeVersion(e3) {
            this._core.unicodeService.activeVersion = e3;
          }
        };
      }, 346(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OscHandler = t2.OscParser = void 0;
        const s2 = i2(726), r2 = [];
        t2.OscParser = class {
          constructor() {
            this._state = 0, this._active = r2, this._id = -1, this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._stack = { paused: false, loopPosition: 0, fallThrough: false };
          }
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = r2;
          }
          reset() {
            if (2 === this._state) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].end(false);
            this._stack.paused = false, this._active = r2, this._id = -1, this._state = 0;
          }
          _start() {
            if (this._active = this._handlers[this._id] || r2, this._active.length) for (let e3 = this._active.length - 1; e3 >= 0; e3--) this._active[e3].start();
            else this._handlerFb(this._id, "START");
          }
          _put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._id, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          start() {
            this.reset(), this._state = 1;
          }
          put(e3, t3, i3) {
            if (3 !== this._state) {
              if (1 === this._state) for (; t3 < i3; ) {
                const i4 = e3[t3++];
                if (59 === i4) {
                  this._state = 2, this._start();
                  break;
                }
                if (i4 < 48 || 57 < i4) return void (this._state = 3);
                -1 === this._id && (this._id = 0), this._id = 10 * this._id + i4 - 48;
              }
              2 === this._state && i3 - t3 > 0 && this._put(e3, t3, i3);
            }
          }
          end(e3, t3 = true) {
            if (0 !== this._state) {
              if (3 !== this._state) if (1 === this._state && this._start(), this._active.length) {
                let i3 = false, s3 = this._active.length - 1, r3 = false;
                if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                  for (; s3 >= 0 && (i3 = this._active[s3].end(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                  s3--;
                }
                for (; s3 >= 0; s3--) if (i3 = this._active[s3].end(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
              } else this._handlerFb(this._id, "END", e3);
              this._active = r2, this._id = -1, this._state = 0;
            }
          }
        };
        class n2 {
          constructor(e3) {
            this._handler = e3, this._data = "", this._hitLimit = false;
          }
          start() {
            this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > n2._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          end(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data), t3 instanceof Promise)) return t3.then((e4) => (this._data = "", this._hitLimit = false, e4));
            return this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.OscHandler = n2, n2._payloadLimit = 1e7;
      }, 415(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeService = void 0;
        const s2 = i2(428), r2 = i2(636);
        class n2 {
          static extractShouldJoin(e3) {
            return !!(1 & e3);
          }
          static extractWidth(e3) {
            return e3 >> 1 & 3;
          }
          static extractCharKind(e3) {
            return e3 >> 3;
          }
          static createPropertyValue(e3, t3, i3 = false) {
            return (16777215 & e3) << 3 | (3 & t3) << 1 | (i3 ? 1 : 0);
          }
          constructor() {
            this._providers = /* @__PURE__ */ Object.create(null), this._active = "", this._onChange = new r2.Emitter(), this.onChange = this._onChange.event;
            const e3 = new s2.UnicodeV6();
            this.register(e3), this._active = e3.version, this._activeProvider = e3;
          }
          dispose() {
            this._onChange.dispose();
          }
          get versions() {
            return Object.keys(this._providers);
          }
          get activeVersion() {
            return this._active;
          }
          set activeVersion(e3) {
            if (!this._providers[e3]) throw new Error(`unknown Unicode version "${e3}"`);
            this._active = e3, this._activeProvider = this._providers[e3], this._onChange.fire(e3);
          }
          register(e3) {
            this._providers[e3.version] = e3;
          }
          wcwidth(e3) {
            return this._activeProvider.wcwidth(e3);
          }
          getStringCellWidth(e3) {
            let t3 = 0, i3 = 0;
            const s3 = e3.length;
            for (let r3 = 0; r3 < s3; ++r3) {
              let a = e3.charCodeAt(r3);
              if (55296 <= a && a <= 56319) {
                if (++r3 >= s3) return t3 + this.wcwidth(a);
                const i4 = e3.charCodeAt(r3);
                56320 <= i4 && i4 <= 57343 ? a = 1024 * (a - 55296) + i4 - 56320 + 65536 : t3 += this.wcwidth(i4);
              }
              const o = this.charProperties(a, i3);
              let h = n2.extractWidth(o);
              n2.extractShouldJoin(o) && (h -= n2.extractWidth(i3)), t3 += h, i3 = o;
            }
            return t3;
          }
          charProperties(e3, t3) {
            return this._activeProvider.charProperties(e3, t3);
          }
        }
        t2.UnicodeService = n2;
      }, 428(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeV6 = void 0;
        const s2 = i2(415), r2 = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395], [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769], [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607], [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238], [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046], [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]], n2 = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];
        let a;
        t2.UnicodeV6 = class {
          constructor() {
            if (this.version = "6", !a) {
              a = new Uint8Array(65536), a.fill(1), a[0] = 0, a.fill(0, 1, 32), a.fill(0, 127, 160), a.fill(2, 4352, 4448), a[9001] = 2, a[9002] = 2, a.fill(2, 11904, 42192), a[12351] = 1, a.fill(2, 44032, 55204), a.fill(2, 63744, 64256), a.fill(2, 65040, 65050), a.fill(2, 65072, 65136), a.fill(2, 65280, 65377), a.fill(2, 65504, 65511);
              for (let e3 = 0; e3 < r2.length; ++e3) a.fill(0, r2[e3][0], r2[e3][1] + 1);
            }
          }
          wcwidth(e3) {
            return e3 < 32 ? 0 : e3 < 127 ? 1 : e3 < 65536 ? a[e3] : (function(e4, t3) {
              let i3, s3 = 0, r3 = t3.length - 1;
              if (e4 < t3[0][0] || e4 > t3[r3][1]) return false;
              for (; r3 >= s3; ) if (i3 = s3 + r3 >> 1, e4 > t3[i3][1]) s3 = i3 + 1;
              else {
                if (!(e4 < t3[i3][0])) return true;
                r3 = i3 - 1;
              }
              return false;
            })(e3, n2) ? 0 : e3 >= 131072 && e3 <= 196605 || e3 >= 196608 && e3 <= 262141 ? 2 : 1;
          }
          charProperties(e3, t3) {
            let i3 = this.wcwidth(e3), r3 = 0 === i3 && 0 !== t3;
            if (r3) {
              const e4 = s2.UnicodeService.extractWidth(t3);
              0 === e4 ? r3 = false : e4 > i3 && (i3 = e4);
            }
            return s2.UnicodeService.createPropertyValue(0, i3, r3);
          }
        };
      }, 451(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ExtendedAttrs = t2.AttributeData = void 0;
        class i2 {
          constructor() {
            this.fg = 0, this.bg = 0, this.extended = new s2();
          }
          static toColorRGB(e3) {
            return [e3 >>> 16 & 255, e3 >>> 8 & 255, 255 & e3];
          }
          static fromColorRGB(e3) {
            return (255 & e3[0]) << 16 | (255 & e3[1]) << 8 | 255 & e3[2];
          }
          clone() {
            const e3 = new i2();
            return e3.fg = this.fg, e3.bg = this.bg, e3.extended = this.extended.clone(), e3;
          }
          isInverse() {
            return 67108864 & this.fg;
          }
          isBold() {
            return 134217728 & this.fg;
          }
          isUnderline() {
            return this.hasExtendedAttrs() && 0 !== this.extended.underlineStyle ? 1 : 268435456 & this.fg;
          }
          isBlink() {
            return 536870912 & this.fg;
          }
          isInvisible() {
            return 1073741824 & this.fg;
          }
          isItalic() {
            return 67108864 & this.bg;
          }
          isDim() {
            return 134217728 & this.bg;
          }
          isStrikethrough() {
            return 2147483648 & this.fg;
          }
          isProtected() {
            return 536870912 & this.bg;
          }
          isOverline() {
            return 1073741824 & this.bg;
          }
          getFgColorMode() {
            return 50331648 & this.fg;
          }
          getBgColorMode() {
            return 50331648 & this.bg;
          }
          isFgRGB() {
            return !(50331648 & ~this.fg);
          }
          isBgRGB() {
            return !(50331648 & ~this.bg);
          }
          isFgPalette() {
            return 16777216 == (50331648 & this.fg) || 33554432 == (50331648 & this.fg);
          }
          isBgPalette() {
            return 16777216 == (50331648 & this.bg) || 33554432 == (50331648 & this.bg);
          }
          isFgDefault() {
            return !(50331648 & this.fg);
          }
          isBgDefault() {
            return !(50331648 & this.bg);
          }
          isAttributeDefault() {
            return 0 === this.fg && 0 === this.bg;
          }
          getFgColor() {
            switch (50331648 & this.fg) {
              case 16777216:
              case 33554432:
                return 255 & this.fg;
              case 50331648:
                return 16777215 & this.fg;
              default:
                return -1;
            }
          }
          getBgColor() {
            switch (50331648 & this.bg) {
              case 16777216:
              case 33554432:
                return 255 & this.bg;
              case 50331648:
                return 16777215 & this.bg;
              default:
                return -1;
            }
          }
          hasExtendedAttrs() {
            return 268435456 & this.bg;
          }
          updateExtended() {
            this.extended.isEmpty() ? this.bg &= -268435457 : this.bg |= 268435456;
          }
          getUnderlineColor() {
            if (268435456 & this.bg && ~this.extended.underlineColor) switch (50331648 & this.extended.underlineColor) {
              case 16777216:
              case 33554432:
                return 255 & this.extended.underlineColor;
              case 50331648:
                return 16777215 & this.extended.underlineColor;
              default:
                return this.getFgColor();
            }
            return this.getFgColor();
          }
          getUnderlineColorMode() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? 50331648 & this.extended.underlineColor : this.getFgColorMode();
          }
          isUnderlineColorRGB() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & ~this.extended.underlineColor) : this.isFgRGB();
          }
          isUnderlineColorPalette() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? 16777216 == (50331648 & this.extended.underlineColor) || 33554432 == (50331648 & this.extended.underlineColor) : this.isFgPalette();
          }
          isUnderlineColorDefault() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & this.extended.underlineColor) : this.isFgDefault();
          }
          getUnderlineStyle() {
            return 268435456 & this.fg ? 268435456 & this.bg ? this.extended.underlineStyle : 1 : 0;
          }
          getUnderlineVariantOffset() {
            return this.extended.underlineVariantOffset;
          }
        }
        t2.AttributeData = i2;
        class s2 {
          get ext() {
            return this._urlId ? -469762049 & this._ext | this.underlineStyle << 26 : this._ext;
          }
          set ext(e3) {
            this._ext = e3;
          }
          get underlineStyle() {
            return this._urlId ? 5 : (469762048 & this._ext) >> 26;
          }
          set underlineStyle(e3) {
            this._ext &= -469762049, this._ext |= e3 << 26 & 469762048;
          }
          get underlineColor() {
            return 67108863 & this._ext;
          }
          set underlineColor(e3) {
            this._ext &= -67108864, this._ext |= 67108863 & e3;
          }
          get urlId() {
            return this._urlId;
          }
          set urlId(e3) {
            this._urlId = e3;
          }
          get underlineVariantOffset() {
            const e3 = (3758096384 & this._ext) >> 29;
            return e3 < 0 ? 4294967288 ^ e3 : e3;
          }
          set underlineVariantOffset(e3) {
            this._ext &= 536870911, this._ext |= e3 << 29 & 3758096384;
          }
          constructor(e3 = 0, t3 = 0) {
            this._ext = 0, this._urlId = 0, this._ext = e3, this._urlId = t3;
          }
          clone() {
            return new s2(this._ext, this._urlId);
          }
          isEmpty() {
            return 0 === this.underlineStyle && 0 === this._urlId;
          }
        }
        t2.ExtendedAttrs = s2;
      }, 453(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.clone = function e3(t3, i2 = 5) {
          if ("object" != typeof t3) return t3;
          const s2 = Array.isArray(t3) ? [] : {};
          for (const r2 in t3) s2[r2] = i2 <= 1 ? t3[r2] : t3[r2] && e3(t3[r2], i2 - 1);
          return s2;
        };
      }, 478(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferSet = void 0;
        const s2 = i2(812), r2 = i2(73), n2 = i2(636);
        class a extends s2.Disposable {
          constructor(e3, t3, i3) {
            super(), this._optionsService = e3, this._bufferService = t3, this._logService = i3, this._onBufferActivate = this._register(new n2.Emitter()), this.onBufferActivate = this._onBufferActivate.event, this.reset(), this._register(this._optionsService.onSpecificOptionChange("scrollback", () => this.resize(this._bufferService.cols, this._bufferService.rows))), this._register(this._optionsService.onSpecificOptionChange("tabStopWidth", () => this.setupTabStops()));
          }
          reset() {
            this._normal = new r2.Buffer(true, this._optionsService, this._bufferService, this._logService), this._normal.fillViewportRows(), this._alt = new r2.Buffer(false, this._optionsService, this._bufferService, this._logService), this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }), this.setupTabStops();
          }
          get alt() {
            return this._alt;
          }
          get active() {
            return this._activeBuffer;
          }
          get normal() {
            return this._normal;
          }
          activateNormalBuffer() {
            this._activeBuffer !== this._normal && (this._normal.x = this._alt.x, this._normal.y = this._alt.y, this._alt.clearAllMarkers(), this._alt.clear(), this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }));
          }
          activateAltBuffer(e3) {
            this._activeBuffer !== this._alt && (this._alt.fillViewportRows(e3), this._alt.x = this._normal.x, this._alt.y = this._normal.y, this._activeBuffer = this._alt, this._onBufferActivate.fire({ activeBuffer: this._alt, inactiveBuffer: this._normal }));
          }
          resize(e3, t3) {
            this._normal.resize(e3, t3), this._alt.resize(e3, t3), this.setupTabStops(e3);
          }
          setupTabStops(e3) {
            this._normal.setupTabStops(e3), this._alt.setupTabStops(e3);
          }
        }
        t2.BufferSet = a;
      }, 486(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.InputHandler = t2.WindowsOptionsReportType = void 0, t2.isValidColorIndex = L;
        const n2 = i2(760), a = i2(717), o = i2(812), h = i2(726), c = i2(107), l = i2(938), _2 = i2(55), d = i2(451), f = i2(501), u = i2(415), p2 = i2(346), g2 = i2(823), v2 = i2(607), b2 = i2(693), S2 = i2(636), m2 = i2(804), y2 = { "(": 0, ")": 1, "*": 2, "+": 3, "-": 1, ".": 2 }, C = 131072;
        function w2(e3, t3) {
          if (e3 > 24) return t3.setWinLines || false;
          switch (e3) {
            case 1:
              return !!t3.restoreWin;
            case 2:
              return !!t3.minimizeWin;
            case 3:
              return !!t3.setWinPosition;
            case 4:
              return !!t3.setWinSizePixels;
            case 5:
              return !!t3.raiseWin;
            case 6:
              return !!t3.lowerWin;
            case 7:
              return !!t3.refreshWin;
            case 8:
              return !!t3.setWinSizeChars;
            case 9:
              return !!t3.maximizeWin;
            case 10:
              return !!t3.fullscreenWin;
            case 11:
              return !!t3.getWinState;
            case 13:
              return !!t3.getWinPosition;
            case 14:
              return !!t3.getWinSizePixels;
            case 15:
              return !!t3.getScreenSizePixels;
            case 16:
              return !!t3.getCellSizePixels;
            case 18:
              return !!t3.getWinSizeChars;
            case 19:
              return !!t3.getScreenSizeChars;
            case 20:
              return !!t3.getIconTitle;
            case 21:
              return !!t3.getWinTitle;
            case 22:
              return !!t3.pushTitle;
            case 23:
              return !!t3.popTitle;
            case 24:
              return !!t3.setWinLines;
          }
          return false;
        }
        var B2;
        !(function(e3) {
          e3[e3.GET_WIN_SIZE_PIXELS = 0] = "GET_WIN_SIZE_PIXELS", e3[e3.GET_CELL_SIZE_PIXELS = 1] = "GET_CELL_SIZE_PIXELS";
        })(B2 || (t2.WindowsOptionsReportType = B2 = {}));
        let k2 = 0;
        class A2 extends o.Disposable {
          getAttrData() {
            return this._curAttrData;
          }
          constructor(e3, t3, i3, s3, r3, o2, l2, _3, d2 = new a.EscapeSequenceParser()) {
            super(), this._bufferService = e3, this._charsetService = t3, this._coreService = i3, this._logService = s3, this._optionsService = r3, this._oscLinkService = o2, this._coreMouseService = l2, this._unicodeService = _3, this._parser = d2, this._parseBuffer = new Uint32Array(4096), this._stringDecoder = new h.StringToUtf32(), this._utf8Decoder = new h.Utf8ToUtf32(), this._windowTitle = "", this._iconName = "", this._windowTitleStack = [], this._iconNameStack = [], this._curAttrData = c.DEFAULT_ATTR_DATA.clone(), this._eraseAttrDataInternal = c.DEFAULT_ATTR_DATA.clone(), this._onRequestBell = this._register(new S2.Emitter()), this.onRequestBell = this._onRequestBell.event, this._onRequestRefreshRows = this._register(new S2.Emitter()), this.onRequestRefreshRows = this._onRequestRefreshRows.event, this._onRequestReset = this._register(new S2.Emitter()), this.onRequestReset = this._onRequestReset.event, this._onRequestSendFocus = this._register(new S2.Emitter()), this.onRequestSendFocus = this._onRequestSendFocus.event, this._onRequestSyncScrollBar = this._register(new S2.Emitter()), this.onRequestSyncScrollBar = this._onRequestSyncScrollBar.event, this._onRequestWindowsOptionsReport = this._register(new S2.Emitter()), this.onRequestWindowsOptionsReport = this._onRequestWindowsOptionsReport.event, this._onA11yChar = this._register(new S2.Emitter()), this.onA11yChar = this._onA11yChar.event, this._onA11yTab = this._register(new S2.Emitter()), this.onA11yTab = this._onA11yTab.event, this._onCursorMove = this._register(new S2.Emitter()), this.onCursorMove = this._onCursorMove.event, this._onLineFeed = this._register(new S2.Emitter()), this.onLineFeed = this._onLineFeed.event, this._onScroll = this._register(new S2.Emitter()), this.onScroll = this._onScroll.event, this._onTitleChange = this._register(new S2.Emitter()), this.onTitleChange = this._onTitleChange.event, this._onColor = this._register(new S2.Emitter()), this.onColor = this._onColor.event, this._onRequestColorSchemeQuery = this._register(new S2.Emitter()), this.onRequestColorSchemeQuery = this._onRequestColorSchemeQuery.event, this._parseStack = { paused: false, cursorStartX: 0, cursorStartY: 0, decodedLength: 0, position: 0 }, this._specialColors = [256, 257, 258], this._register(this._parser), this._dirtyRowTracker = new E(this._bufferService), this._activeBuffer = this._bufferService.buffer, this._register(this._bufferService.buffers.onBufferActivate((e4) => this._activeBuffer = e4.activeBuffer)), this._parser.setCsiHandlerFallback((e4, t4) => {
              this._logService.debug("Unknown CSI code: ", { identifier: this._parser.identToString(e4), params: t4.toArray() });
            }), this._parser.setEscHandlerFallback((e4) => {
              this._logService.debug("Unknown ESC code: ", { identifier: this._parser.identToString(e4) });
            }), this._parser.setExecuteHandlerFallback((e4) => {
              this._logService.debug("Unknown EXECUTE code: ", { code: e4 });
            }), this._parser.setOscHandlerFallback((e4, t4, i4) => {
              this._logService.debug("Unknown OSC code: ", { identifier: e4, action: t4, data: i4 });
            }), this._parser.setDcsHandlerFallback((e4, t4, i4) => {
              "HOOK" === t4 && (i4 = i4.toArray()), this._logService.debug("Unknown DCS code: ", { identifier: this._parser.identToString(e4), action: t4, payload: i4 });
            }), this._parser.setPrintHandler((e4, t4, i4) => this.print(e4, t4, i4)), this._parser.registerCsiHandler({ final: "@" }, (e4) => this.insertChars(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "@" }, (e4) => this.scrollLeft(e4)), this._parser.registerCsiHandler({ final: "A" }, (e4) => this.cursorUp(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "A" }, (e4) => this.scrollRight(e4)), this._parser.registerCsiHandler({ final: "B" }, (e4) => this.cursorDown(e4)), this._parser.registerCsiHandler({ final: "C" }, (e4) => this.cursorForward(e4)), this._parser.registerCsiHandler({ final: "D" }, (e4) => this.cursorBackward(e4)), this._parser.registerCsiHandler({ final: "E" }, (e4) => this.cursorNextLine(e4)), this._parser.registerCsiHandler({ final: "F" }, (e4) => this.cursorPrecedingLine(e4)), this._parser.registerCsiHandler({ final: "G" }, (e4) => this.cursorCharAbsolute(e4)), this._parser.registerCsiHandler({ final: "H" }, (e4) => this.cursorPosition(e4)), this._parser.registerCsiHandler({ final: "I" }, (e4) => this.cursorForwardTab(e4)), this._parser.registerCsiHandler({ final: "J" }, (e4) => this.eraseInDisplay(e4, false)), this._parser.registerCsiHandler({ prefix: "?", final: "J" }, (e4) => this.eraseInDisplay(e4, true)), this._parser.registerCsiHandler({ final: "K" }, (e4) => this.eraseInLine(e4, false)), this._parser.registerCsiHandler({ prefix: "?", final: "K" }, (e4) => this.eraseInLine(e4, true)), this._parser.registerCsiHandler({ final: "L" }, (e4) => this.insertLines(e4)), this._parser.registerCsiHandler({ final: "M" }, (e4) => this.deleteLines(e4)), this._parser.registerCsiHandler({ final: "P" }, (e4) => this.deleteChars(e4)), this._parser.registerCsiHandler({ final: "S" }, (e4) => this.scrollUp(e4)), this._parser.registerCsiHandler({ final: "T" }, (e4) => this.scrollDown(e4)), this._parser.registerCsiHandler({ final: "X" }, (e4) => this.eraseChars(e4)), this._parser.registerCsiHandler({ final: "Z" }, (e4) => this.cursorBackwardTab(e4)), this._parser.registerCsiHandler({ final: "^" }, (e4) => this.scrollDown(e4)), this._parser.registerCsiHandler({ final: "`" }, (e4) => this.charPosAbsolute(e4)), this._parser.registerCsiHandler({ final: "a" }, (e4) => this.hPositionRelative(e4)), this._parser.registerCsiHandler({ final: "b" }, (e4) => this.repeatPrecedingCharacter(e4)), this._parser.registerCsiHandler({ final: "c" }, (e4) => this.sendDeviceAttributesPrimary(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "c" }, (e4) => this.sendDeviceAttributesSecondary(e4)), this._parser.registerCsiHandler({ final: "d" }, (e4) => this.linePosAbsolute(e4)), this._parser.registerCsiHandler({ final: "e" }, (e4) => this.vPositionRelative(e4)), this._parser.registerCsiHandler({ final: "f" }, (e4) => this.hVPosition(e4)), this._parser.registerCsiHandler({ final: "g" }, (e4) => this.tabClear(e4)), this._parser.registerCsiHandler({ final: "h" }, (e4) => this.setMode(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "h" }, (e4) => this.setModePrivate(e4)), this._parser.registerCsiHandler({ final: "l" }, (e4) => this.resetMode(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "l" }, (e4) => this.resetModePrivate(e4)), this._parser.registerCsiHandler({ final: "m" }, (e4) => this.charAttributes(e4)), this._parser.registerCsiHandler({ final: "n" }, (e4) => this.deviceStatus(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "n" }, (e4) => this.deviceStatusPrivate(e4)), this._parser.registerCsiHandler({ intermediates: "!", final: "p" }, (e4) => this.softReset(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "q" }, (e4) => this.sendXtVersion(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "q" }, (e4) => this.setCursorStyle(e4)), this._parser.registerCsiHandler({ final: "r" }, (e4) => this.setScrollRegion(e4)), this._parser.registerCsiHandler({ final: "s" }, (e4) => this.saveCursor(e4)), this._parser.registerCsiHandler({ final: "t" }, (e4) => this.windowOptions(e4)), this._parser.registerCsiHandler({ final: "u" }, (e4) => this.restoreCursor(e4)), this._parser.registerCsiHandler({ intermediates: "'", final: "}" }, (e4) => this.insertColumns(e4)), this._parser.registerCsiHandler({ intermediates: "'", final: "~" }, (e4) => this.deleteColumns(e4)), this._parser.registerCsiHandler({ intermediates: '"', final: "q" }, (e4) => this.selectProtected(e4)), this._parser.registerCsiHandler({ intermediates: "$", final: "p" }, (e4) => this.requestMode(e4, true)), this._parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (e4) => this.requestMode(e4, false)), this._parser.registerCsiHandler({ prefix: "=", final: "u" }, (e4) => this.kittyKeyboardSet(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "u" }, (e4) => this.kittyKeyboardQuery(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "u" }, (e4) => this.kittyKeyboardPush(e4)), this._parser.registerCsiHandler({ prefix: "<", final: "u" }, (e4) => this.kittyKeyboardPop(e4)), this._parser.setExecuteHandler("\x07", () => this.bell()), this._parser.setExecuteHandler("\n", () => this.lineFeed()), this._parser.setExecuteHandler("\v", () => this.lineFeed()), this._parser.setExecuteHandler("\f", () => this.lineFeed()), this._parser.setExecuteHandler("\r", () => this.carriageReturn()), this._parser.setExecuteHandler("\b", () => this.backspace()), this._parser.setExecuteHandler("	", () => this.tab()), this._parser.setExecuteHandler("", () => this.shiftOut()), this._parser.setExecuteHandler("", () => this.shiftIn()), this._parser.setExecuteHandler("", () => this.index()), this._parser.setExecuteHandler("", () => this.nextLine()), this._parser.setExecuteHandler("", () => this.tabSet()), this._parser.registerOscHandler(0, new p2.OscHandler((e4) => (this.setTitle(e4), this.setIconName(e4), true))), this._parser.registerOscHandler(1, new p2.OscHandler((e4) => this.setIconName(e4))), this._parser.registerOscHandler(2, new p2.OscHandler((e4) => this.setTitle(e4))), this._parser.registerOscHandler(4, new p2.OscHandler((e4) => this.setOrReportIndexedColor(e4))), this._parser.registerOscHandler(8, new p2.OscHandler((e4) => this.setHyperlink(e4))), this._parser.registerOscHandler(10, new p2.OscHandler((e4) => this.setOrReportFgColor(e4))), this._parser.registerOscHandler(11, new p2.OscHandler((e4) => this.setOrReportBgColor(e4))), this._parser.registerOscHandler(12, new p2.OscHandler((e4) => this.setOrReportCursorColor(e4))), this._parser.registerOscHandler(104, new p2.OscHandler((e4) => this.restoreIndexedColor(e4))), this._parser.registerOscHandler(110, new p2.OscHandler((e4) => this.restoreFgColor(e4))), this._parser.registerOscHandler(111, new p2.OscHandler((e4) => this.restoreBgColor(e4))), this._parser.registerOscHandler(112, new p2.OscHandler((e4) => this.restoreCursorColor(e4))), this._parser.registerEscHandler({ final: "7" }, () => this.saveCursor()), this._parser.registerEscHandler({ final: "8" }, () => this.restoreCursor()), this._parser.registerEscHandler({ final: "D" }, () => this.index()), this._parser.registerEscHandler({ final: "E" }, () => this.nextLine()), this._parser.registerEscHandler({ final: "H" }, () => this.tabSet()), this._parser.registerEscHandler({ final: "M" }, () => this.reverseIndex()), this._parser.registerEscHandler({ final: "=" }, () => this.keypadApplicationMode()), this._parser.registerEscHandler({ final: ">" }, () => this.keypadNumericMode()), this._parser.registerEscHandler({ final: "c" }, () => this.fullReset()), this._parser.registerEscHandler({ final: "n" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "o" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "|" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "}" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "~" }, () => this.setgLevel(1)), this._parser.registerEscHandler({ intermediates: "%", final: "@" }, () => this.selectDefaultCharset()), this._parser.registerEscHandler({ intermediates: "%", final: "G" }, () => this.selectDefaultCharset());
            for (const e4 in n2.CHARSETS) this._parser.registerEscHandler({ intermediates: "(", final: e4 }, () => this.selectCharset("(" + e4)), this._parser.registerEscHandler({ intermediates: ")", final: e4 }, () => this.selectCharset(")" + e4)), this._parser.registerEscHandler({ intermediates: "*", final: e4 }, () => this.selectCharset("*" + e4)), this._parser.registerEscHandler({ intermediates: "+", final: e4 }, () => this.selectCharset("+" + e4)), this._parser.registerEscHandler({ intermediates: "-", final: e4 }, () => this.selectCharset("-" + e4)), this._parser.registerEscHandler({ intermediates: ".", final: e4 }, () => this.selectCharset("." + e4)), this._parser.registerEscHandler({ intermediates: "/", final: e4 }, () => this.selectCharset("/" + e4));
            this._parser.registerEscHandler({ intermediates: "#", final: "8" }, () => this.screenAlignmentPattern()), this._parser.setErrorHandler((e4) => (this._logService.error("Parsing error: ", e4), e4)), this._parser.registerDcsHandler({ intermediates: "$", final: "q" }, new g2.DcsHandler((e4, t4) => this.requestStatusString(e4, t4)));
          }
          _preserveStack(e3, t3, i3, s3) {
            this._parseStack.paused = true, this._parseStack.cursorStartX = e3, this._parseStack.cursorStartY = t3, this._parseStack.decodedLength = i3, this._parseStack.position = s3;
          }
          _logSlowResolvingAsync(e3) {
            if (this._logService.logLevel <= f.LogLevelEnum.WARN) {
              let t3;
              const i3 = new Promise((e4, i4) => {
                t3 = setTimeout(() => i4("#SLOW_TIMEOUT"), 5e3);
              });
              Promise.race([e3, i3]).then(() => {
                void 0 !== t3 && clearTimeout(t3);
              }, (e4) => {
                if (void 0 !== t3 && clearTimeout(t3), "#SLOW_TIMEOUT" !== e4) throw e4;
                console.warn("async parser handler taking longer than 5000 ms");
              });
            }
          }
          _getCurrentLinkId() {
            return this._curAttrData.extended.urlId;
          }
          parse(e3, t3) {
            let i3, s3 = this._activeBuffer.x, r3 = this._activeBuffer.y, n3 = 0;
            const a2 = this._parseStack.paused;
            if (a2) {
              if (i3 = this._parser.parse(this._parseBuffer, this._parseStack.decodedLength, t3)) return this._logSlowResolvingAsync(i3), i3;
              s3 = this._parseStack.cursorStartX, r3 = this._parseStack.cursorStartY, this._parseStack.paused = false, e3.length > C && (n3 = this._parseStack.position + C);
            }
            if (this._logService.logLevel <= f.LogLevelEnum.DEBUG && this._logService.debug("parsing data " + ("string" == typeof e3 ? ` "${e3}"` : ` "${Array.prototype.map.call(e3, (e4) => String.fromCharCode(e4)).join("")}"`)), this._logService.logLevel === f.LogLevelEnum.TRACE && this._logService.trace("parsing data (codes)", "string" == typeof e3 ? e3.split("").map((e4) => e4.charCodeAt(0)) : e3), this._parseBuffer.length < e3.length && this._parseBuffer.length < C && (this._parseBuffer = new Uint32Array(Math.min(e3.length, C))), a2 || this._dirtyRowTracker.clearRange(), e3.length > C) for (let t4 = n3; t4 < e3.length; t4 += C) {
              const n4 = t4 + C < e3.length ? t4 + C : e3.length, a3 = "string" == typeof e3 ? this._stringDecoder.decode(e3.substring(t4, n4), this._parseBuffer) : this._utf8Decoder.decode(e3.subarray(t4, n4), this._parseBuffer);
              if (i3 = this._parser.parse(this._parseBuffer, a3)) return this._preserveStack(s3, r3, a3, t4), this._logSlowResolvingAsync(i3), i3;
            }
            else if (!a2) {
              const t4 = "string" == typeof e3 ? this._stringDecoder.decode(e3, this._parseBuffer) : this._utf8Decoder.decode(e3, this._parseBuffer);
              if (i3 = this._parser.parse(this._parseBuffer, t4)) return this._preserveStack(s3, r3, t4, 0), this._logSlowResolvingAsync(i3), i3;
            }
            this._activeBuffer.x === s3 && this._activeBuffer.y === r3 || this._onCursorMove.fire();
            const o2 = this._dirtyRowTracker.end + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp), h2 = this._dirtyRowTracker.start + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
            h2 < this._bufferService.rows && this._onRequestRefreshRows.fire({ start: Math.min(h2, this._bufferService.rows - 1), end: Math.min(o2, this._bufferService.rows - 1) });
          }
          print(e3, t3, i3) {
            let s3, r3;
            const n3 = this._charsetService.charset, a2 = this._optionsService.rawOptions.screenReaderMode, o2 = this._bufferService.cols, _3 = this._coreService.decPrivateModes.wraparound, d2 = this._coreService.modes.insertMode, f2 = this._curAttrData;
            let p3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            if (!p3) return;
            this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._activeBuffer.x && i3 - t3 > 0 && 2 === p3.getWidth(this._activeBuffer.x - 1) && p3.setCellFromCodepoint(this._activeBuffer.x - 1, 0, 1, f2);
            let g3 = this._parser.precedingJoinState;
            for (let v3 = t3; v3 < i3; ++v3) {
              if (s3 = e3[v3], 173 === s3) continue;
              if (s3 < 127 && n3) {
                const e4 = n3[String.fromCharCode(s3)];
                e4 && (s3 = e4.charCodeAt(0));
              }
              const t4 = this._unicodeService.charProperties(s3, g3);
              r3 = u.UnicodeService.extractWidth(t4);
              const i4 = u.UnicodeService.extractShouldJoin(t4), b3 = i4 ? u.UnicodeService.extractWidth(g3) : 0;
              if (g3 = t4, a2 && this._onA11yChar.fire((0, h.stringFromCodePoint)(s3)), this._getCurrentLinkId() && this._oscLinkService.addLineToLink(this._getCurrentLinkId(), this._activeBuffer.ybase + this._activeBuffer.y), this._activeBuffer.x + r3 - b3 > o2) {
                if (_3) {
                  const e4 = p3;
                  let t5 = this._activeBuffer.x - b3;
                  if (this._activeBuffer.x = b3, this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData(), true)) : (this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = true), p3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y), !p3) return;
                  for (b3 > 0 && p3 instanceof c.BufferLine && p3.copyCellsFrom(e4, t5, 0, b3, false); t5 < o2; ) e4.setCellFromCodepoint(t5++, 0, 1, f2);
                } else if (this._activeBuffer.x = o2 - 1, 2 === r3) continue;
              }
              if (i4 && this._activeBuffer.x) {
                const e4 = p3.getWidth(this._activeBuffer.x - 1) ? 1 : 2;
                p3.addCodepointToCell(this._activeBuffer.x - e4, s3, r3);
                for (let e5 = r3 - b3; --e5 >= 0; ) p3.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f2);
                continue;
              }
              if (d2 && (p3.insertCells(this._activeBuffer.x, r3 - b3, this._activeBuffer.getNullCell(f2)), 2 === p3.getWidth(o2 - 1) && p3.setCellFromCodepoint(o2 - 1, l.NULL_CELL_CODE, l.NULL_CELL_WIDTH, f2)), p3.setCellFromCodepoint(this._activeBuffer.x++, s3, r3, f2), r3 > 0) for (; --r3; ) p3.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f2);
            }
            this._parser.precedingJoinState = g3, this._activeBuffer.x < o2 && i3 - t3 > 0 && 0 === p3.getWidth(this._activeBuffer.x) && !p3.hasContent(this._activeBuffer.x) && p3.setCellFromCodepoint(this._activeBuffer.x, 0, 1, f2), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          registerCsiHandler(e3, t3) {
            return "t" !== e3.final || e3.prefix || e3.intermediates ? this._parser.registerCsiHandler(e3, t3) : this._parser.registerCsiHandler(e3, (e4) => !w2(e4.params[0], this._optionsService.rawOptions.windowOptions) || t3(e4));
          }
          registerDcsHandler(e3, t3) {
            return this._parser.registerDcsHandler(e3, new g2.DcsHandler(t3));
          }
          registerEscHandler(e3, t3) {
            return this._parser.registerEscHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._parser.registerOscHandler(e3, new p2.OscHandler(t3));
          }
          registerApcHandler(e3, t3) {
            return this._parser.registerApcHandler(e3, new v2.ApcHandler(t3));
          }
          bell() {
            return this._onRequestBell.fire(), true;
          }
          lineFeed() {
            return this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._optionsService.rawOptions.convertEol && (this._activeBuffer.x = 0), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows ? this._activeBuffer.y = this._bufferService.rows - 1 : this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.x >= this._bufferService.cols && this._activeBuffer.x--, this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._onLineFeed.fire(), true;
          }
          carriageReturn() {
            return this._activeBuffer.x = 0, true;
          }
          backspace() {
            if (!this._coreService.decPrivateModes.reverseWraparound) return this._restrictCursor(), this._activeBuffer.x > 0 && this._activeBuffer.x--, true;
            if (this._restrictCursor(this._bufferService.cols), this._activeBuffer.x > 0) this._activeBuffer.x--;
            else if (0 === this._activeBuffer.x && this._activeBuffer.y > this._activeBuffer.scrollTop && this._activeBuffer.y <= this._activeBuffer.scrollBottom && this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y)?.isWrapped) {
              this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.y--, this._activeBuffer.x = this._bufferService.cols - 1;
              const e3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
              e3.hasWidth(this._activeBuffer.x) && !e3.hasContent(this._activeBuffer.x) && this._activeBuffer.x--;
            }
            return this._restrictCursor(), true;
          }
          tab() {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            const e3 = this._activeBuffer.x;
            return this._activeBuffer.x = this._activeBuffer.nextStop(), this._optionsService.rawOptions.screenReaderMode && this._onA11yTab.fire(this._activeBuffer.x - e3), true;
          }
          shiftOut() {
            return this._charsetService.setgLevel(1), true;
          }
          shiftIn() {
            return this._charsetService.setgLevel(0), true;
          }
          _restrictCursor(e3 = this._bufferService.cols - 1) {
            this._activeBuffer.x = Math.min(e3, Math.max(0, this._activeBuffer.x)), this._activeBuffer.y = this._coreService.decPrivateModes.origin ? Math.min(this._activeBuffer.scrollBottom, Math.max(this._activeBuffer.scrollTop, this._activeBuffer.y)) : Math.min(this._bufferService.rows - 1, Math.max(0, this._activeBuffer.y)), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          _setCursor(e3, t3) {
            this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._coreService.decPrivateModes.origin ? (this._activeBuffer.x = e3, this._activeBuffer.y = this._activeBuffer.scrollTop + t3) : (this._activeBuffer.x = e3, this._activeBuffer.y = t3), this._restrictCursor(), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          _moveCursor(e3, t3) {
            this._restrictCursor(), this._setCursor(this._activeBuffer.x + e3, this._activeBuffer.y + t3);
          }
          cursorUp(e3) {
            const t3 = this._activeBuffer.y - this._activeBuffer.scrollTop;
            return t3 >= 0 ? this._moveCursor(0, -Math.min(t3, e3.params[0] || 1)) : this._moveCursor(0, -(e3.params[0] || 1)), true;
          }
          cursorDown(e3) {
            const t3 = this._activeBuffer.scrollBottom - this._activeBuffer.y;
            return t3 >= 0 ? this._moveCursor(0, Math.min(t3, e3.params[0] || 1)) : this._moveCursor(0, e3.params[0] || 1), true;
          }
          cursorForward(e3) {
            return this._moveCursor(e3.params[0] || 1, 0), true;
          }
          cursorBackward(e3) {
            return this._moveCursor(-(e3.params[0] || 1), 0), true;
          }
          cursorNextLine(e3) {
            return this.cursorDown(e3), this._activeBuffer.x = 0, true;
          }
          cursorPrecedingLine(e3) {
            return this.cursorUp(e3), this._activeBuffer.x = 0, true;
          }
          cursorCharAbsolute(e3) {
            return this._setCursor((e3.params[0] || 1) - 1, this._activeBuffer.y), true;
          }
          cursorPosition(e3) {
            return this._setCursor(e3.length >= 2 ? (e3.params[1] || 1) - 1 : 0, (e3.params[0] || 1) - 1), true;
          }
          charPosAbsolute(e3) {
            return this._setCursor((e3.params[0] || 1) - 1, this._activeBuffer.y), true;
          }
          hPositionRelative(e3) {
            return this._moveCursor(e3.params[0] || 1, 0), true;
          }
          linePosAbsolute(e3) {
            return this._setCursor(this._activeBuffer.x, (e3.params[0] || 1) - 1), true;
          }
          vPositionRelative(e3) {
            return this._moveCursor(0, e3.params[0] || 1), true;
          }
          hVPosition(e3) {
            return this.cursorPosition(e3), true;
          }
          tabClear(e3) {
            const t3 = e3.params[0];
            return 0 === t3 ? delete this._activeBuffer.tabs[this._activeBuffer.x] : 3 === t3 && (this._activeBuffer.tabs = {}), true;
          }
          cursorForwardTab(e3) {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.x = this._activeBuffer.nextStop();
            return true;
          }
          cursorBackwardTab(e3) {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.x = this._activeBuffer.prevStop();
            return true;
          }
          selectProtected(e3) {
            const t3 = e3.params[0];
            return 1 === t3 && (this._curAttrData.bg |= 536870912), 2 !== t3 && 0 !== t3 || (this._curAttrData.bg &= -536870913), true;
          }
          _eraseInBufferLine(e3, t3, i3, s3 = false, r3 = false) {
            const n3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e3);
            n3 && (n3.replaceCells(t3, i3, this._activeBuffer.getNullCell(this._eraseAttrData()), r3), s3 && (n3.isWrapped = false));
          }
          _resetBufferLine(e3, t3 = false) {
            const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e3);
            i3 && (i3.fill(this._activeBuffer.getNullCell(this._eraseAttrData()), t3), this._bufferService.buffer.clearMarkers(this._activeBuffer.ybase + e3), i3.isWrapped = false);
          }
          eraseInDisplay(e3, t3 = false) {
            let i3;
            switch (this._restrictCursor(this._bufferService.cols), e3.params[0]) {
              case 0:
                for (i3 = this._activeBuffer.y, this._dirtyRowTracker.markDirty(i3), this._eraseInBufferLine(i3++, this._activeBuffer.x, this._bufferService.cols, 0 === this._activeBuffer.x, t3); i3 < this._bufferService.rows; i3++) this._resetBufferLine(i3, t3);
                this._dirtyRowTracker.markDirty(i3);
                break;
              case 1:
                if (i3 = this._activeBuffer.y, this._dirtyRowTracker.markDirty(i3), this._eraseInBufferLine(i3, 0, this._activeBuffer.x + 1, true, t3), this._activeBuffer.x + 1 >= this._bufferService.cols) {
                  const e5 = this._activeBuffer.lines.get(i3 + 1);
                  e5 && (e5.isWrapped = false);
                }
                for (; i3--; ) this._resetBufferLine(i3, t3);
                this._dirtyRowTracker.markDirty(0);
                break;
              case 2:
                if (this._optionsService.rawOptions.scrollOnEraseInDisplay) {
                  for (i3 = this._bufferService.rows, this._dirtyRowTracker.markRangeDirty(0, i3 - 1); i3--; ) {
                    const e5 = this._activeBuffer.lines.get(this._activeBuffer.ybase + i3);
                    if (e5?.getTrimmedLength()) break;
                  }
                  for (; i3 >= 0; i3--) this._bufferService.scroll(this._eraseAttrData());
                } else {
                  for (i3 = this._bufferService.rows, this._dirtyRowTracker.markDirty(i3 - 1); i3--; ) this._resetBufferLine(i3, t3);
                  this._dirtyRowTracker.markDirty(0);
                }
                break;
              case 3:
                const e4 = this._activeBuffer.lines.length - this._bufferService.rows;
                e4 > 0 && (this._activeBuffer.lines.trimStart(e4), this._activeBuffer.ybase = Math.max(this._activeBuffer.ybase - e4, 0), this._activeBuffer.ydisp = Math.max(this._activeBuffer.ydisp - e4, 0), this._onScroll.fire(0));
            }
            return true;
          }
          eraseInLine(e3, t3 = false) {
            switch (this._restrictCursor(this._bufferService.cols), e3.params[0]) {
              case 0:
                this._eraseInBufferLine(this._activeBuffer.y, this._activeBuffer.x, this._bufferService.cols, 0 === this._activeBuffer.x, t3);
                break;
              case 1:
                this._eraseInBufferLine(this._activeBuffer.y, 0, this._activeBuffer.x + 1, false, t3);
                break;
              case 2:
                this._eraseInBufferLine(this._activeBuffer.y, 0, this._bufferService.cols, true, t3);
            }
            return this._dirtyRowTracker.markDirty(this._activeBuffer.y), true;
          }
          insertLines(e3) {
            this._restrictCursor();
            let t3 = e3.params[0] || 1;
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const i3 = this._activeBuffer.ybase + this._activeBuffer.y, s3 = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, r3 = this._bufferService.rows - 1 + this._activeBuffer.ybase - s3 + 1;
            for (; t3--; ) this._activeBuffer.lines.splice(r3 - 1, 1), this._activeBuffer.lines.splice(i3, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
          }
          deleteLines(e3) {
            this._restrictCursor();
            let t3 = e3.params[0] || 1;
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const i3 = this._activeBuffer.ybase + this._activeBuffer.y;
            let s3;
            for (s3 = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, s3 = this._bufferService.rows - 1 + this._activeBuffer.ybase - s3; t3--; ) this._activeBuffer.lines.splice(i3, 1), this._activeBuffer.lines.splice(s3, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
          }
          insertChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.insertCells(this._activeBuffer.x, e3.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          deleteChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.deleteCells(this._activeBuffer.x, e3.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          scrollUp(e3) {
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollDown(e3) {
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 0, this._activeBuffer.getBlankLine(c.DEFAULT_ATTR_DATA));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollLeft(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.deleteCells(0, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollRight(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.insertCells(0, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          insertColumns(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.insertCells(this._activeBuffer.x, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          deleteColumns(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.deleteCells(this._activeBuffer.x, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          eraseChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.replaceCells(this._activeBuffer.x, this._activeBuffer.x + (e3.params[0] || 1), this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          repeatPrecedingCharacter(e3) {
            const t3 = this._parser.precedingJoinState;
            if (!t3) return true;
            const i3 = e3.params[0] || 1, s3 = u.UnicodeService.extractWidth(t3), r3 = this._activeBuffer.x - s3, n3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).getString(r3), a2 = new Uint32Array(n3.length * i3);
            let o2 = 0;
            for (let e4 = 0; e4 < n3.length; ) {
              const t4 = n3.codePointAt(e4) || 0;
              a2[o2++] = t4, e4 += t4 > 65535 ? 2 : 1;
            }
            let h2 = o2;
            for (let e4 = 1; e4 < i3; ++e4) a2.copyWithin(h2, 0, o2), h2 += o2;
            return this.print(a2, 0, h2), true;
          }
          sendDeviceAttributesPrimary(e3) {
            return e3.params[0] > 0 || (this._is("xterm") || this._is("rxvt-unicode") || this._is("screen") ? this._coreService.triggerDataEvent("\x1B[?1;2c") : this._is("linux") && this._coreService.triggerDataEvent("\x1B[?6c")), true;
          }
          sendDeviceAttributesSecondary(e3) {
            return e3.params[0] > 0 || (this._is("xterm") ? this._coreService.triggerDataEvent("\x1B[>0;276;0c") : this._is("rxvt-unicode") ? this._coreService.triggerDataEvent("\x1B[>85;95;0c") : this._is("linux") ? this._coreService.triggerDataEvent(e3.params[0] + "c") : this._is("screen") && this._coreService.triggerDataEvent("\x1B[>83;40003;0c")), true;
          }
          sendXtVersion(e3) {
            return e3.params[0] > 0 || this._coreService.triggerDataEvent(`\x1BP>|xterm.js(${m2.XTERM_VERSION})\x1B\\`), true;
          }
          _is(e3) {
            return (this._optionsService.rawOptions.termName + "").startsWith(e3);
          }
          setMode(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 4:
                this._coreService.modes.insertMode = true;
                break;
              case 20:
                this._optionsService.options.convertEol = true;
            }
            return true;
          }
          setModePrivate(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = true;
                break;
              case 2:
                this._charsetService.setgCharset(0, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(1, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(2, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(3, n2.DEFAULT_CHARSET);
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(132, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = true, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = true;
                break;
              case 12:
                this._optionsService.rawOptions.quirks?.allowSetCursorBlink && (this._optionsService.options.cursorBlink = true);
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = true;
                break;
              case 66:
                this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
                this._coreMouseService.activeProtocol = "X10";
                break;
              case 1e3:
                this._coreMouseService.activeProtocol = "VT200";
                break;
              case 1002:
                this._coreMouseService.activeProtocol = "DRAG";
                break;
              case 1003:
                this._coreMouseService.activeProtocol = "ANY";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = true, this._onRequestSendFocus.fire();
                break;
              case 1005:
                this._logService.debug("DECSET 1005 not supported (see #2507)");
                break;
              case 1006:
                this._coreMouseService.activeEncoding = "SGR";
                break;
              case 1015:
                this._logService.debug("DECSET 1015 not supported (see #2507)");
                break;
              case 1016:
                this._coreMouseService.activeEncoding = "SGR_PIXELS";
                break;
              case 25:
                this._coreService.isCursorHidden = false;
                break;
              case 1048:
                this.saveCursor();
                break;
              case 1049:
                this.saveCursor();
              case 47:
              case 1047:
                if (this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) {
                  const e4 = this._coreService.kittyKeyboard;
                  e4.mainFlags = e4.flags, e4.flags = e4.altFlags;
                }
                this._bufferService.buffers.activateAltBuffer(this._eraseAttrData()), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(void 0), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = true;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = true;
                break;
              case 2031:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && (this._coreService.decPrivateModes.colorSchemeUpdates = true);
                break;
              case 9001:
                this._optionsService.rawOptions.vtExtensions?.win32InputMode && (this._coreService.decPrivateModes.win32InputMode = true);
            }
            return true;
          }
          resetMode(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 4:
                this._coreService.modes.insertMode = false;
                break;
              case 20:
                this._optionsService.options.convertEol = false;
            }
            return true;
          }
          resetModePrivate(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = false;
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(80, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = false, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = false;
                break;
              case 12:
                this._optionsService.rawOptions.quirks?.allowSetCursorBlink && (this._optionsService.options.cursorBlink = false);
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = false;
                break;
              case 66:
                this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
              case 1e3:
              case 1002:
              case 1003:
                this._coreMouseService.activeProtocol = "NONE";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = false;
                break;
              case 1005:
                this._logService.debug("DECRST 1005 not supported (see #2507)");
                break;
              case 1006:
              case 1016:
                this._coreMouseService.activeEncoding = "DEFAULT";
                break;
              case 1015:
                this._logService.debug("DECRST 1015 not supported (see #2507)");
                break;
              case 25:
                this._coreService.isCursorHidden = true;
                break;
              case 1048:
                this.restoreCursor();
                break;
              case 1049:
              case 47:
              case 1047:
                if (this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) {
                  const e4 = this._coreService.kittyKeyboard;
                  e4.altFlags = e4.flags, e4.flags = e4.mainFlags;
                }
                this._bufferService.buffers.activateNormalBuffer(), 1049 === e3.params[t3] && this.restoreCursor(), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(void 0), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = false;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = false, this._onRequestRefreshRows.fire(void 0);
                break;
              case 2031:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && (this._coreService.decPrivateModes.colorSchemeUpdates = false);
                break;
              case 9001:
                this._optionsService.rawOptions.vtExtensions?.win32InputMode && (this._coreService.decPrivateModes.win32InputMode = false);
            }
            return true;
          }
          requestMode(e3, t3) {
            const i3 = this._coreService.decPrivateModes, { activeProtocol: s3, activeEncoding: r3 } = this._coreMouseService, n3 = this._coreService, { buffers: a2, cols: o2 } = this._bufferService, { active: h2, alt: c2 } = a2, l2 = this._optionsService.rawOptions, _3 = (e4, i4) => (n3.triggerDataEvent(`\x1B[${t3 ? "" : "?"}${e4};${i4}$y`), true), d2 = (e4) => e4 ? 1 : 2, f2 = e3.params[0];
            return t3 ? _3(f2, 2 === f2 ? 4 : 4 === f2 ? d2(n3.modes.insertMode) : 12 === f2 ? 3 : 20 === f2 ? d2(l2.convertEol) : 0) : 1 === f2 ? _3(f2, d2(i3.applicationCursorKeys)) : 3 === f2 ? _3(f2, l2.windowOptions.setWinLines ? 80 === o2 ? 2 : 132 === o2 ? 1 : 0 : 0) : 6 === f2 ? _3(f2, d2(i3.origin)) : 7 === f2 ? _3(f2, d2(i3.wraparound)) : 8 === f2 ? _3(f2, 3) : 9 === f2 ? _3(f2, d2("X10" === s3)) : 12 === f2 ? _3(f2, d2(l2.cursorBlink)) : 25 === f2 ? _3(f2, d2(!n3.isCursorHidden)) : 45 === f2 ? _3(f2, d2(i3.reverseWraparound)) : 66 === f2 ? _3(f2, d2(i3.applicationKeypad)) : 67 === f2 ? _3(f2, 4) : 1e3 === f2 ? _3(f2, d2("VT200" === s3)) : 1002 === f2 ? _3(f2, d2("DRAG" === s3)) : 1003 === f2 ? _3(f2, d2("ANY" === s3)) : 1004 === f2 ? _3(f2, d2(i3.sendFocus)) : 1005 === f2 ? _3(f2, 4) : 1006 === f2 ? _3(f2, d2("SGR" === r3)) : 1015 === f2 ? _3(f2, 4) : 1016 === f2 ? _3(f2, d2("SGR_PIXELS" === r3)) : 1048 === f2 ? _3(f2, 1) : 47 === f2 || 1047 === f2 || 1049 === f2 ? _3(f2, d2(h2 === c2)) : 2004 === f2 ? _3(f2, d2(i3.bracketedPasteMode)) : 2026 === f2 ? _3(f2, d2(i3.synchronizedOutput)) : 9001 === f2 && this._optionsService.rawOptions.vtExtensions?.win32InputMode ? _3(f2, d2(i3.win32InputMode)) : _3(f2, 0);
          }
          _updateAttrColor(e3, t3, i3, s3, r3) {
            return 2 === t3 ? (e3 |= 50331648, e3 &= -16777216, e3 |= d.AttributeData.fromColorRGB([i3, s3, r3])) : 5 === t3 && (e3 &= -50331904, e3 |= 33554432 | 255 & i3), e3;
          }
          _extractColor(e3, t3, i3) {
            const s3 = [0, 0, -1, 0, 0, 0];
            let r3 = 0, n3 = 0;
            do {
              if (s3[n3 + r3] = e3.params[t3 + n3], e3.hasSubParams(t3 + n3)) {
                const i4 = e3.getSubParams(t3 + n3);
                let a2 = 0;
                do {
                  5 === s3[1] && (r3 = 1), s3[n3 + a2 + 1 + r3] = i4[a2];
                } while (++a2 < i4.length && a2 + n3 + 1 + r3 < s3.length);
                break;
              }
              if (5 === s3[1] && n3 + r3 >= 2 || 2 === s3[1] && n3 + r3 >= 5) break;
              s3[1] && (r3 = 1);
            } while (++n3 + t3 < e3.length && n3 + r3 < s3.length);
            for (let e4 = 2; e4 < s3.length; ++e4) -1 === s3[e4] && (s3[e4] = 0);
            switch (s3[0]) {
              case 38:
                i3.fg = this._updateAttrColor(i3.fg, s3[1], s3[3], s3[4], s3[5]);
                break;
              case 48:
                i3.bg = this._updateAttrColor(i3.bg, s3[1], s3[3], s3[4], s3[5]);
                break;
              case 58:
                i3.extended = i3.extended.clone(), i3.extended.underlineColor = this._updateAttrColor(i3.extended.underlineColor, s3[1], s3[3], s3[4], s3[5]);
            }
            return n3;
          }
          _processUnderline(e3, t3) {
            t3.extended = t3.extended.clone(), (!~e3 || e3 > 5) && (e3 = 1), t3.extended.underlineStyle = e3, t3.fg |= 268435456, 0 === e3 && (t3.fg &= -268435457), t3.updateExtended();
          }
          _processSGR0(e3) {
            e3.fg = c.DEFAULT_ATTR_DATA.fg, e3.bg = c.DEFAULT_ATTR_DATA.bg, e3.extended = e3.extended.clone(), e3.extended.underlineStyle = 0, e3.extended.underlineColor &= -67108864, e3.updateExtended();
          }
          charAttributes(e3) {
            if (1 === e3.length && 0 === e3.params[0]) return this._processSGR0(this._curAttrData), true;
            const t3 = e3.length;
            let i3;
            const s3 = this._curAttrData;
            for (let r3 = 0; r3 < t3; r3++) i3 = e3.params[r3], i3 >= 30 && i3 <= 37 ? (s3.fg &= -50331904, s3.fg |= 16777216 | i3 - 30) : i3 >= 40 && i3 <= 47 ? (s3.bg &= -50331904, s3.bg |= 16777216 | i3 - 40) : i3 >= 90 && i3 <= 97 ? (s3.fg &= -50331904, s3.fg |= 16777224 | i3 - 90) : i3 >= 100 && i3 <= 107 ? (s3.bg &= -50331904, s3.bg |= 16777224 | i3 - 100) : 0 === i3 ? this._processSGR0(s3) : 1 === i3 ? s3.fg |= 134217728 : 3 === i3 ? s3.bg |= 67108864 : 4 === i3 ? (s3.fg |= 268435456, this._processUnderline(e3.hasSubParams(r3) ? e3.getSubParams(r3)[0] : 1, s3)) : 5 === i3 ? s3.fg |= 536870912 : 7 === i3 ? s3.fg |= 67108864 : 8 === i3 ? s3.fg |= 1073741824 : 9 === i3 ? s3.fg |= 2147483648 : 2 === i3 ? s3.bg |= 134217728 : 21 === i3 ? this._processUnderline(2, s3) : 22 === i3 ? (s3.fg &= -134217729, s3.bg &= -134217729) : 23 === i3 ? s3.bg &= -67108865 : 24 === i3 ? (s3.fg &= -268435457, this._processUnderline(0, s3)) : 25 === i3 ? s3.fg &= -536870913 : 27 === i3 ? s3.fg &= -67108865 : 28 === i3 ? s3.fg &= -1073741825 : 29 === i3 ? s3.fg &= 2147483647 : 39 === i3 ? (s3.fg &= -67108864, s3.fg |= 16777215 & c.DEFAULT_ATTR_DATA.fg) : 49 === i3 ? (s3.bg &= -67108864, s3.bg |= 16777215 & c.DEFAULT_ATTR_DATA.bg) : 38 === i3 || 48 === i3 || 58 === i3 ? r3 += this._extractColor(e3, r3, s3) : 53 === i3 ? s3.bg |= 1073741824 : 55 === i3 ? s3.bg &= -1073741825 : 221 === i3 && (this._optionsService.rawOptions.vtExtensions?.kittySgrBoldFaintControl ?? 1) ? s3.fg &= -134217729 : 222 === i3 && (this._optionsService.rawOptions.vtExtensions?.kittySgrBoldFaintControl ?? 1) ? s3.bg &= -134217729 : 59 === i3 ? (s3.extended = s3.extended.clone(), s3.extended.underlineColor = -1, s3.updateExtended()) : this._logService.debug("Unknown SGR attribute: %d.", i3);
            return true;
          }
          deviceStatus(e3) {
            switch (e3.params[0]) {
              case 5:
                this._coreService.triggerDataEvent("\x1B[0n");
                break;
              case 6:
                const e4 = this._activeBuffer.y + 1, t3 = this._activeBuffer.x + 1;
                this._coreService.triggerDataEvent(`\x1B[${e4};${t3}R`);
            }
            return true;
          }
          deviceStatusPrivate(e3) {
            switch (e3.params[0]) {
              case 6:
                const e4 = this._activeBuffer.y + 1, t3 = this._activeBuffer.x + 1;
                this._coreService.triggerDataEvent(`\x1B[?${e4};${t3}R`);
                break;
              case 15:
              case 25:
              case 26:
              case 53:
                break;
              case 996:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && this._onRequestColorSchemeQuery.fire();
            }
            return true;
          }
          softReset(e3) {
            return this._coreService.isCursorHidden = false, this._onRequestSyncScrollBar.fire(), this._activeBuffer.scrollTop = 0, this._activeBuffer.scrollBottom = this._bufferService.rows - 1, this._curAttrData = c.DEFAULT_ATTR_DATA.clone(), this._coreService.reset(), this._charsetService.reset(), this._activeBuffer.savedX = 0, this._activeBuffer.savedY = this._activeBuffer.ybase, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, this._coreService.decPrivateModes.origin = false, true;
          }
          setCursorStyle(e3) {
            const t3 = 0 === e3.length ? 1 : e3.params[0];
            if (0 === t3) this._coreService.decPrivateModes.cursorStyle = void 0, this._coreService.decPrivateModes.cursorBlink = void 0;
            else {
              switch (t3) {
                case 1:
                case 2:
                  this._coreService.decPrivateModes.cursorStyle = "block";
                  break;
                case 3:
                case 4:
                  this._coreService.decPrivateModes.cursorStyle = "underline";
                  break;
                case 5:
                case 6:
                  this._coreService.decPrivateModes.cursorStyle = "bar";
              }
              const e4 = t3 % 2 == 1;
              this._coreService.decPrivateModes.cursorBlink = e4;
            }
            return true;
          }
          setScrollRegion(e3) {
            const t3 = e3.params[0] || 1;
            let i3;
            return (e3.length < 2 || (i3 = e3.params[1]) > this._bufferService.rows || 0 === i3) && (i3 = this._bufferService.rows), i3 > t3 && (this._activeBuffer.scrollTop = t3 - 1, this._activeBuffer.scrollBottom = i3 - 1, this._setCursor(0, 0)), true;
          }
          windowOptions(e3) {
            if (!w2(e3.params[0], this._optionsService.rawOptions.windowOptions)) return true;
            const t3 = e3.length > 1 ? e3.params[1] : 0;
            switch (e3.params[0]) {
              case 14:
                2 !== t3 && this._onRequestWindowsOptionsReport.fire(B2.GET_WIN_SIZE_PIXELS);
                break;
              case 16:
                this._onRequestWindowsOptionsReport.fire(B2.GET_CELL_SIZE_PIXELS);
                break;
              case 18:
                this._bufferService && this._coreService.triggerDataEvent(`\x1B[8;${this._bufferService.rows};${this._bufferService.cols}t`);
                break;
              case 22:
                0 !== t3 && 2 !== t3 || (this._windowTitleStack.push(this._windowTitle), this._windowTitleStack.length > 10 && this._windowTitleStack.shift()), 0 !== t3 && 1 !== t3 || (this._iconNameStack.push(this._iconName), this._iconNameStack.length > 10 && this._iconNameStack.shift());
                break;
              case 23:
                0 !== t3 && 2 !== t3 || this._windowTitleStack.length && this.setTitle(this._windowTitleStack.pop()), 0 !== t3 && 1 !== t3 || this._iconNameStack.length && this.setIconName(this._iconNameStack.pop());
            }
            return true;
          }
          saveCursor(e3) {
            return this._activeBuffer.savedX = this._activeBuffer.x, this._activeBuffer.savedY = this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, this._activeBuffer.savedCharsets = this._charsetService.charsets.slice(), this._activeBuffer.savedGlevel = this._charsetService.glevel, this._activeBuffer.savedOriginMode = this._coreService.decPrivateModes.origin, this._activeBuffer.savedWraparoundMode = this._coreService.decPrivateModes.wraparound, true;
          }
          restoreCursor(e3) {
            this._activeBuffer.x = this._activeBuffer.savedX || 0, this._activeBuffer.y = Math.max(this._activeBuffer.savedY - this._activeBuffer.ybase, 0), this._curAttrData.fg = this._activeBuffer.savedCurAttrData.fg, this._curAttrData.bg = this._activeBuffer.savedCurAttrData.bg;
            for (let e4 = 0; e4 < this._activeBuffer.savedCharsets.length; e4++) this._charsetService.setgCharset(e4, this._activeBuffer.savedCharsets[e4]);
            return this._charsetService.setgLevel(this._activeBuffer.savedGlevel), this._coreService.decPrivateModes.origin = this._activeBuffer.savedOriginMode, this._coreService.decPrivateModes.wraparound = this._activeBuffer.savedWraparoundMode, this._restrictCursor(), true;
          }
          setTitle(e3) {
            return this._windowTitle = e3, this._onTitleChange.fire(e3), true;
          }
          setIconName(e3) {
            return this._iconName = e3, true;
          }
          setOrReportIndexedColor(e3) {
            const t3 = [], i3 = e3.split(";");
            for (; i3.length > 1; ) {
              const e4 = i3.shift(), s3 = i3.shift();
              if (/^\d+$/.exec(e4)) {
                const i4 = parseInt(e4);
                if (L(i4)) if ("?" === s3) t3.push({ type: 0, index: i4 });
                else {
                  const e5 = (0, b2.parseColor)(s3);
                  e5 && t3.push({ type: 1, index: i4, color: e5 });
                }
              }
            }
            return t3.length && this._onColor.fire(t3), true;
          }
          setHyperlink(e3) {
            const t3 = e3.indexOf(";");
            if (-1 === t3) return true;
            const i3 = e3.slice(0, t3).trim(), s3 = e3.slice(t3 + 1);
            return s3 ? this._createHyperlink(i3, s3) : !i3.trim() && this._finishHyperlink();
          }
          _createHyperlink(e3, t3) {
            this._getCurrentLinkId() && this._finishHyperlink();
            const i3 = e3.split(":");
            let s3;
            const r3 = i3.findIndex((e4) => e4.startsWith("id="));
            return -1 !== r3 && (s3 = i3[r3].slice(3) || void 0), this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = this._oscLinkService.registerLink({ id: s3, uri: t3 }), this._curAttrData.updateExtended(), true;
          }
          _finishHyperlink() {
            return this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = 0, this._curAttrData.updateExtended(), true;
          }
          _setOrReportSpecialColor(e3, t3) {
            const i3 = e3.split(";");
            for (let e4 = 0; e4 < i3.length && !(t3 >= this._specialColors.length); ++e4, ++t3) if ("?" === i3[e4]) this._onColor.fire([{ type: 0, index: this._specialColors[t3] }]);
            else {
              const s3 = (0, b2.parseColor)(i3[e4]);
              s3 && this._onColor.fire([{ type: 1, index: this._specialColors[t3], color: s3 }]);
            }
            return true;
          }
          setOrReportFgColor(e3) {
            return this._setOrReportSpecialColor(e3, 0);
          }
          setOrReportBgColor(e3) {
            return this._setOrReportSpecialColor(e3, 1);
          }
          setOrReportCursorColor(e3) {
            return this._setOrReportSpecialColor(e3, 2);
          }
          restoreIndexedColor(e3) {
            if (!e3) return this._onColor.fire([{ type: 2 }]), true;
            const t3 = [], i3 = e3.split(";");
            for (let e4 = 0; e4 < i3.length; ++e4) if (/^\d+$/.exec(i3[e4])) {
              const s3 = parseInt(i3[e4]);
              L(s3) && t3.push({ type: 2, index: s3 });
            }
            return t3.length && this._onColor.fire(t3), true;
          }
          restoreFgColor(e3) {
            return this._onColor.fire([{ type: 2, index: 256 }]), true;
          }
          restoreBgColor(e3) {
            return this._onColor.fire([{ type: 2, index: 257 }]), true;
          }
          restoreCursorColor(e3) {
            return this._onColor.fire([{ type: 2, index: 258 }]), true;
          }
          nextLine() {
            return this._activeBuffer.x = 0, this.index(), true;
          }
          keypadApplicationMode() {
            return this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire(), true;
          }
          keypadNumericMode() {
            return this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire(), true;
          }
          selectDefaultCharset() {
            return this._charsetService.setgLevel(0), this._charsetService.setgCharset(0, n2.DEFAULT_CHARSET), true;
          }
          selectCharset(e3) {
            return 2 !== e3.length ? (this.selectDefaultCharset(), true) : ("/" === e3[0] || this._charsetService.setgCharset(y2[e3[0]], n2.CHARSETS[e3[1]] ?? n2.DEFAULT_CHARSET), true);
          }
          index() {
            return this._restrictCursor(), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._restrictCursor(), true;
          }
          tabSet() {
            return this._activeBuffer.tabs[this._activeBuffer.x] = true, true;
          }
          reverseIndex() {
            if (this._restrictCursor(), this._activeBuffer.y === this._activeBuffer.scrollTop) {
              const e3 = this._activeBuffer.scrollBottom - this._activeBuffer.scrollTop;
              this._activeBuffer.lines.shiftElements(this._activeBuffer.ybase + this._activeBuffer.y, e3, 1), this._activeBuffer.lines.set(this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.getBlankLine(this._eraseAttrData())), this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom);
            } else this._activeBuffer.y--, this._restrictCursor();
            return true;
          }
          fullReset() {
            return this._parser.reset(), this._onRequestReset.fire(), true;
          }
          reset() {
            this._curAttrData = c.DEFAULT_ATTR_DATA.clone(), this._eraseAttrDataInternal = c.DEFAULT_ATTR_DATA.clone();
          }
          _eraseAttrData() {
            return this._eraseAttrDataInternal.bg &= -67108864, this._eraseAttrDataInternal.bg |= 67108863 & this._curAttrData.bg, this._eraseAttrDataInternal;
          }
          setgLevel(e3) {
            return this._charsetService.setgLevel(e3), true;
          }
          screenAlignmentPattern() {
            const e3 = new _2.CellData();
            e3.content = 1 << 22 | "E".charCodeAt(0), e3.fg = this._curAttrData.fg, e3.bg = this._curAttrData.bg, this._setCursor(0, 0);
            for (let t3 = 0; t3 < this._bufferService.rows; ++t3) {
              const i3 = this._activeBuffer.ybase + this._activeBuffer.y + t3, s3 = this._activeBuffer.lines.get(i3);
              s3 && (s3.fill(e3), s3.isWrapped = false);
            }
            return this._dirtyRowTracker.markAllDirty(), this._setCursor(0, 0), true;
          }
          requestStatusString(e3, t3) {
            const i3 = this._bufferService.buffer, s3 = this._optionsService.rawOptions;
            return ((e4) => (this._coreService.triggerDataEvent(`\x1B${e4}\x1B\\`), true))('"q' === e3 ? `P1$r${this._curAttrData.isProtected() ? 1 : 0}"q` : '"p' === e3 ? 'P1$r61;1"p' : "r" === e3 ? `P1$r${i3.scrollTop + 1};${i3.scrollBottom + 1}r` : "m" === e3 ? "P1$r0m" : " q" === e3 ? `P1$r${{ block: 2, underline: 4, bar: 6 }[s3.cursorStyle] - (s3.cursorBlink ? 1 : 0)} q` : "P0$r");
          }
          markRangeDirty(e3, t3) {
            this._dirtyRowTracker.markRangeDirty(e3, t3);
          }
          kittyKeyboardSet(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = e3.params[0] || 0, i3 = e3.params[1] || 1, s3 = this._coreService.kittyKeyboard;
            switch (i3) {
              case 1:
                s3.flags = t3;
                break;
              case 2:
                s3.flags |= t3;
                break;
              case 3:
                s3.flags &= ~t3;
            }
            return true;
          }
          kittyKeyboardQuery(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = this._coreService.kittyKeyboard.flags;
            return this._coreService.triggerDataEvent(`\x1B[?${t3}u`), true;
          }
          kittyKeyboardPush(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = e3.params[0] || 0, i3 = this._coreService.kittyKeyboard, s3 = this._bufferService.buffer === this._bufferService.buffers.alt ? i3.altStack : i3.mainStack;
            return s3.length >= 16 && s3.shift(), s3.push(i3.flags), i3.flags = t3, true;
          }
          kittyKeyboardPop(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = Math.max(1, e3.params[0] || 1), i3 = this._coreService.kittyKeyboard, s3 = this._bufferService.buffer === this._bufferService.buffers.alt ? i3.altStack : i3.mainStack;
            for (let e4 = 0; e4 < t3 && s3.length > 0; e4++) i3.flags = s3.pop();
            return 0 === s3.length && t3 > 0 && (i3.flags = 0), true;
          }
        }
        t2.InputHandler = A2;
        let E = class {
          constructor(e3) {
            this._bufferService = e3, this.clearRange();
          }
          clearRange() {
            this.start = this._bufferService.buffer.y, this.end = this._bufferService.buffer.y;
          }
          markDirty(e3) {
            e3 < this.start ? this.start = e3 : e3 > this.end && (this.end = e3);
          }
          markRangeDirty(e3, t3) {
            e3 > t3 && (k2 = e3, e3 = t3, t3 = k2), e3 < this.start && (this.start = e3), t3 > this.end && (this.end = t3);
          }
          markAllDirty() {
            this.markRangeDirty(0, this._bufferService.rows - 1);
          }
        };
        function L(e3) {
          return 0 <= e3 && e3 < 256;
        }
        E = s2([r2(0, f.IBufferService)], E);
      }, 501(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.IDecorationService = t2.IUnicodeService = t2.IOscLinkService = t2.IOptionsService = t2.ILogService = t2.LogLevelEnum = t2.IInstantiationService = t2.ICharsetService = t2.ICoreService = t2.ICoreMouseService = t2.IBufferService = void 0;
        const s2 = i2(201);
        var r2;
        t2.IBufferService = (0, s2.createDecorator)("BufferService"), t2.ICoreMouseService = (0, s2.createDecorator)("CoreMouseService"), t2.ICoreService = (0, s2.createDecorator)("CoreService"), t2.ICharsetService = (0, s2.createDecorator)("CharsetService"), t2.IInstantiationService = (0, s2.createDecorator)("InstantiationService"), (function(e3) {
          e3[e3.TRACE = 0] = "TRACE", e3[e3.DEBUG = 1] = "DEBUG", e3[e3.INFO = 2] = "INFO", e3[e3.WARN = 3] = "WARN", e3[e3.ERROR = 4] = "ERROR", e3[e3.OFF = 5] = "OFF";
        })(r2 || (t2.LogLevelEnum = r2 = {})), t2.ILogService = (0, s2.createDecorator)("LogService"), t2.IOptionsService = (0, s2.createDecorator)("OptionsService"), t2.IOscLinkService = (0, s2.createDecorator)("OscLinkService"), t2.IUnicodeService = (0, s2.createDecorator)("UnicodeService"), t2.IDecorationService = (0, s2.createDecorator)("DecorationService");
      }, 562(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.WriteBuffer = void 0;
        const s2 = i2(812), r2 = i2(636);
        class n2 extends s2.Disposable {
          constructor(e3) {
            super(), this._action = e3, this._writeBuffer = [], this._callbacks = [], this._pendingData = 0, this._bufferOffset = 0, this._isSyncWriting = false, this._syncCalls = 0, this._didUserInput = false, this._onWriteParsed = this._register(new r2.Emitter()), this.onWriteParsed = this._onWriteParsed.event;
          }
          handleUserInput() {
            this._didUserInput = true;
          }
          flushSync() {
            if (this._isSyncWriting) return;
            let e3;
            for (this._isSyncWriting = true; e3 = this._writeBuffer.shift(); ) {
              this._action(e3);
              const t3 = this._callbacks.shift();
              t3 && t3();
            }
            this._pendingData = 0, this._bufferOffset = 2147483647, this._writeBuffer.length = 0, this._callbacks.length = 0, this._isSyncWriting = false;
          }
          writeSync(e3, t3) {
            if (void 0 !== t3 && this._syncCalls > t3) return void (this._syncCalls = 0);
            if (this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(void 0), this._syncCalls++, this._isSyncWriting) return;
            let i3;
            for (this._isSyncWriting = true; i3 = this._writeBuffer.shift(); ) {
              this._action(i3);
              const e4 = this._callbacks.shift();
              e4 && e4();
            }
            this._pendingData = 0, this._bufferOffset = 2147483647, this._isSyncWriting = false, this._syncCalls = 0;
          }
          write(e3, t3) {
            if (this._pendingData > 5e7) throw new Error("write data discarded, use flow control to avoid losing data");
            if (!this._writeBuffer.length) {
              if (this._bufferOffset = 0, this._didUserInput) return this._didUserInput = false, this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(t3), void this._innerWrite();
              setTimeout(() => this._innerWrite());
            }
            this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(t3);
          }
          _innerWrite(e3 = 0, t3 = true) {
            const i3 = e3 || performance.now();
            for (; this._writeBuffer.length > this._bufferOffset; ) {
              const e4 = this._writeBuffer[this._bufferOffset], s3 = this._action(e4, t3);
              if (s3) {
                const e5 = (e6) => performance.now() - i3 >= 12 ? setTimeout(() => this._innerWrite(0, e6)) : this._innerWrite(i3, e6);
                return void s3.catch((e6) => (queueMicrotask(() => {
                  throw e6;
                }), Promise.resolve(false))).then(e5);
              }
              const r3 = this._callbacks[this._bufferOffset];
              if (r3 && r3(), this._bufferOffset++, this._pendingData -= e4.length, performance.now() - i3 >= 12) break;
            }
            this._writeBuffer.length > this._bufferOffset ? (this._bufferOffset > 50 && (this._writeBuffer = this._writeBuffer.slice(this._bufferOffset), this._callbacks = this._callbacks.slice(this._bufferOffset), this._bufferOffset = 0), setTimeout(() => this._innerWrite())) : (this._writeBuffer.length = 0, this._callbacks.length = 0, this._pendingData = 0, this._bufferOffset = 0), this._onWriteParsed.fire();
          }
        }
        t2.WriteBuffer = n2;
      }, 607(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ApcHandler = t2.ApcParser = void 0;
        const s2 = i2(726), r2 = [];
        t2.ApcParser = class {
          constructor() {
            this._state = 0, this._active = r2, this._id = -1, this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._stack = { paused: false, loopPosition: 0, fallThrough: false };
          }
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = r2;
          }
          reset() {
            if (2 === this._state) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].end(false);
            this._stack.paused = false, this._active = r2, this._id = -1, this._state = 0;
          }
          _start() {
            if (this._active = this._handlers[this._id] || r2, this._active.length) for (let e3 = this._active.length - 1; e3 >= 0; e3--) this._active[e3].start();
            else this._handlerFb(this._id, "START");
          }
          _put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._id, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          start() {
            this.reset(), this._state = 1;
          }
          put(e3, t3, i3) {
            3 !== this._state && (1 === this._state && t3 < i3 && (this._id = e3[t3++], this._state = 2, this._start()), 2 === this._state && i3 - t3 > 0 && this._put(e3, t3, i3));
          }
          end(e3, t3 = true) {
            if (0 !== this._state) {
              if (3 !== this._state) {
                if (1 === this._state) return this._active = r2, this._id = -1, void (this._state = 0);
                if (this._active.length) {
                  let i3 = false, s3 = this._active.length - 1, r3 = false;
                  if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                    for (; s3 >= 0 && (i3 = this._active[s3].end(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                    s3--;
                  }
                  for (; s3 >= 0; s3--) if (i3 = this._active[s3].end(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
                } else this._handlerFb(this._id, "END", e3);
              }
              this._active = r2, this._id = -1, this._state = 0;
            }
          }
        };
        class n2 {
          constructor(e3) {
            this._handler = e3, this._data = "", this._hitLimit = false;
          }
          start() {
            this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > n2._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          end(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data), t3 instanceof Promise)) return t3.then((e4) => (this._data = "", this._hitLimit = false, e4));
            return this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.ApcHandler = n2, n2._payloadLimit = 1e7;
      }, 636(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.EventUtils = t2.Emitter = void 0;
        const s2 = i2(812);
        var r2;
        t2.Emitter = class {
          constructor() {
            this._listeners = [], this._disposed = false;
          }
          get event() {
            return this._event || (this._event = (e3, t3, i3) => {
              if (this._disposed) return (0, s2.toDisposable)(() => {
              });
              const r3 = { fn: e3, thisArgs: t3 };
              this._listeners.push(r3);
              const n2 = (0, s2.toDisposable)(() => {
                const e4 = this._listeners.indexOf(r3);
                -1 !== e4 && this._listeners.splice(e4, 1);
              });
              return i3 && (Array.isArray(i3) ? i3.push(n2) : i3.add(n2)), n2;
            }), this._event;
          }
          fire(e3) {
            if (!this._disposed) switch (this._listeners.length) {
              case 0:
                return;
              case 1: {
                const { fn: t3, thisArgs: i3 } = this._listeners[0];
                return void t3.call(i3, e3);
              }
              default: {
                const t3 = this._listeners.slice();
                for (const { fn: i3, thisArgs: s3 } of t3) i3.call(s3, e3);
              }
            }
          }
          dispose() {
            this._disposed || (this._disposed = true, this._listeners.length = 0);
          }
        }, (function(e3) {
          e3.forward = function(e4, t3) {
            return e4((e5) => t3.fire(e5));
          }, e3.map = function(e4, t3) {
            return (i3, s3, r3) => e4((e5) => i3.call(s3, t3(e5)), void 0, r3);
          }, e3.any = function(...e4) {
            return (t3, i3, r3) => {
              const n2 = new s2.DisposableStore();
              for (const s3 of e4) n2.add(s3((e5) => t3.call(i3, e5)));
              return r3 && (Array.isArray(r3) ? r3.push(n2) : r3.add(n2)), n2;
            };
          }, e3.runAndSubscribe = function(e4, t3, i3) {
            return t3(i3), e4((e5) => t3(e5));
          };
        })(r2 || (t2.EventUtils = r2 = {}));
      }, 639(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CircularList = void 0;
        const s2 = i2(812), r2 = i2(636);
        class n2 extends s2.Disposable {
          constructor(e3) {
            super(), this._maxLength = e3, this.onDeleteEmitter = this._register(new r2.Emitter()), this.onDelete = this.onDeleteEmitter.event, this.onInsertEmitter = this._register(new r2.Emitter()), this.onInsert = this.onInsertEmitter.event, this.onTrimEmitter = this._register(new r2.Emitter()), this.onTrim = this.onTrimEmitter.event, this._array = new Array(this._maxLength), this._startIndex = 0, this._length = 0;
          }
          get maxLength() {
            return this._maxLength;
          }
          set maxLength(e3) {
            if (this._maxLength === e3) return;
            const t3 = new Array(e3);
            for (let i3 = 0; i3 < Math.min(e3, this.length); i3++) t3[i3] = this._array[this._getCyclicIndex(i3)];
            this._array = t3, this._maxLength = e3, this._startIndex = 0;
          }
          get length() {
            return this._length;
          }
          set length(e3) {
            if (e3 > this._length) for (let t3 = this._length; t3 < e3; t3++) this._array[t3] = void 0;
            this._length = e3;
          }
          get(e3) {
            return this._array[this._getCyclicIndex(e3)];
          }
          set(e3, t3) {
            this._array[this._getCyclicIndex(e3)] = t3;
          }
          push(e3) {
            this._array[this._getCyclicIndex(this._length)] = e3, this._length === this._maxLength ? (this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1)) : this._length++;
          }
          recycle() {
            if (this._length !== this._maxLength) throw new Error("Can only recycle when the buffer is full");
            return this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1), this._array[this._getCyclicIndex(this._length - 1)];
          }
          get isFull() {
            return this._length === this._maxLength;
          }
          pop() {
            return this._array[this._getCyclicIndex(this._length-- - 1)];
          }
          splice(e3, t3, ...i3) {
            if (t3) {
              for (let i4 = e3; i4 < this._length - t3; i4++) this._array[this._getCyclicIndex(i4)] = this._array[this._getCyclicIndex(i4 + t3)];
              this._length -= t3, this.onDeleteEmitter.fire({ index: e3, amount: t3 });
            }
            for (let t4 = this._length - 1; t4 >= e3; t4--) this._array[this._getCyclicIndex(t4 + i3.length)] = this._array[this._getCyclicIndex(t4)];
            for (let t4 = 0; t4 < i3.length; t4++) this._array[this._getCyclicIndex(e3 + t4)] = i3[t4];
            if (i3.length && this.onInsertEmitter.fire({ index: e3, amount: i3.length }), this._length + i3.length > this._maxLength) {
              const e4 = this._length + i3.length - this._maxLength;
              this._startIndex += e4, this._length = this._maxLength, this.onTrimEmitter.fire(e4);
            } else this._length += i3.length;
          }
          trimStart(e3) {
            e3 > this._length && (e3 = this._length), this._startIndex += e3, this._length -= e3, this.onTrimEmitter.fire(e3);
          }
          shiftElements(e3, t3, i3) {
            if (!(t3 <= 0)) {
              if (e3 < 0 || e3 >= this._length) throw new Error("start argument out of range");
              if (e3 + i3 < 0) throw new Error("Cannot shift elements in list beyond index 0");
              if (i3 > 0) {
                for (let s4 = t3 - 1; s4 >= 0; s4--) this.set(e3 + s4 + i3, this.get(e3 + s4));
                const s3 = e3 + t3 + i3 - this._length;
                if (s3 > 0) for (this._length += s3; this._length > this._maxLength; ) this._length--, this._startIndex++, this.onTrimEmitter.fire(1);
              } else for (let s3 = 0; s3 < t3; s3++) this.set(e3 + s3 + i3, this.get(e3 + s3));
            }
          }
          _getCyclicIndex(e3) {
            return (this._startIndex + e3) % this._maxLength;
          }
        }
        t2.CircularList = n2;
      }, 640(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferService = t2.MINIMUM_ROWS = t2.MINIMUM_COLS = void 0;
        const n2 = i2(812), a = i2(478), o = i2(501), h = i2(636);
        t2.MINIMUM_COLS = 2, t2.MINIMUM_ROWS = 1;
        let c = class extends n2.Disposable {
          get buffer() {
            return this.buffers.active;
          }
          constructor(e3, i3) {
            super(), this.isUserScrolling = false, this._onResize = this._register(new h.Emitter()), this.onResize = this._onResize.event, this._onScroll = this._register(new h.Emitter()), this.onScroll = this._onScroll.event, this.cols = Math.max(e3.rawOptions.cols || 0, t2.MINIMUM_COLS), this.rows = Math.max(e3.rawOptions.rows || 0, t2.MINIMUM_ROWS), this.buffers = this._register(new a.BufferSet(e3, this, i3)), this._register(this.buffers.onBufferActivate((e4) => {
              this._onScroll.fire(e4.activeBuffer.ydisp);
            }));
          }
          resize(e3, t3) {
            const i3 = this.cols !== e3, s3 = this.rows !== t3;
            this.cols = e3, this.rows = t3, this.buffers.resize(e3, t3), this._onResize.fire({ cols: e3, rows: t3, colsChanged: i3, rowsChanged: s3 });
          }
          reset() {
            this.buffers.reset(), this.isUserScrolling = false;
          }
          scroll(e3, t3 = false) {
            const i3 = this.buffer;
            let s3;
            s3 = this._cachedBlankLine, s3 && s3.length === this.cols && s3.getFg(0) === e3.fg && s3.getBg(0) === e3.bg || (s3 = i3.getBlankLine(e3, t3), this._cachedBlankLine = s3), s3.isWrapped = t3;
            const r3 = i3.ybase + i3.scrollTop, n3 = i3.ybase + i3.scrollBottom;
            if (0 === i3.scrollTop) {
              const e4 = i3.lines.isFull;
              n3 === i3.lines.length - 1 ? e4 ? i3.lines.recycle().copyFrom(s3) : i3.lines.push(s3.clone()) : i3.lines.splice(n3 + 1, 0, s3.clone()), e4 ? this.isUserScrolling && (i3.ydisp = Math.max(i3.ydisp - 1, 0)) : (i3.ybase++, this.isUserScrolling || i3.ydisp++);
            } else {
              const e4 = n3 - r3 + 1;
              i3.lines.shiftElements(r3 + 1, e4 - 1, -1), i3.lines.set(n3, s3.clone());
            }
            this.isUserScrolling || (i3.ydisp = i3.ybase), this._onScroll.fire(i3.ydisp);
          }
          scrollLines(e3, t3) {
            const i3 = this.buffer;
            if (e3 < 0) {
              if (0 === i3.ydisp) return;
              this.isUserScrolling = true;
            } else e3 + i3.ydisp >= i3.ybase && (this.isUserScrolling = false);
            const s3 = i3.ydisp;
            i3.ydisp = Math.max(Math.min(i3.ydisp + e3, i3.ybase), 0), s3 !== i3.ydisp && (t3 || this._onScroll.fire(i3.ydisp));
          }
        };
        t2.BufferService = c, t2.BufferService = c = s2([r2(0, o.IOptionsService), r2(1, o.ILogService)], c);
      }, 693(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.parseColor = function(e3) {
          if (!e3) return;
          let t3 = e3.toLowerCase();
          if (t3.startsWith("rgb:")) {
            t3 = t3.slice(4);
            const e4 = i2.exec(t3);
            if (e4) {
              const t4 = e4[1] ? 15 : e4[4] ? 255 : e4[7] ? 4095 : 65535;
              return [Math.round(parseInt(e4[1] || e4[4] || e4[7] || e4[10], 16) / t4 * 255), Math.round(parseInt(e4[2] || e4[5] || e4[8] || e4[11], 16) / t4 * 255), Math.round(parseInt(e4[3] || e4[6] || e4[9] || e4[12], 16) / t4 * 255)];
            }
          } else if (t3.startsWith("#") && (t3 = t3.slice(1), s2.exec(t3) && [3, 6, 9, 12].includes(t3.length))) {
            const e4 = t3.length / 3, i3 = [0, 0, 0];
            for (let s3 = 0; s3 < 3; ++s3) {
              const r3 = parseInt(t3.slice(e4 * s3, e4 * s3 + e4), 16);
              i3[s3] = 1 === e4 ? r3 << 4 : 2 === e4 ? r3 : 3 === e4 ? r3 >> 4 : r3 >> 8;
            }
            return i3;
          }
        }, t2.toRgbString = function(e3, t3 = 16) {
          const [i3, s3, n2] = e3;
          return `rgb:${r2(i3, t3)}/${r2(s3, t3)}/${r2(n2, t3)}`;
        };
        const i2 = /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/, s2 = /^[\da-f]+$/;
        function r2(e3, t3) {
          const i3 = e3.toString(16), s3 = i3.length < 2 ? "0" + i3 : i3;
          switch (t3) {
            case 4:
              return i3[0];
            case 8:
              return s3;
            case 12:
              return (s3 + s3).slice(0, 3);
            default:
              return s3 + s3;
          }
        }
      }, 701(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.isChromeOS = t2.isLinux = t2.isWindows = t2.isMac = t2.isSafari = t2.isLegacyEdge = t2.isChrome = t2.isFirefox = t2.isNode = void 0, t2.getZoomFactor = function(e3) {
          return 1;
        }, t2.getSafariVersion = function() {
          if (!t2.isSafari) return 0;
          const e3 = i2.match(/Version\/(\d+)/);
          return null === e3 || e3.length < 2 ? 0 : parseInt(e3[1]);
        }, t2.isNode = !("undefined" == typeof process || !("title" in process) || "undefined" != typeof navigator && !navigator.userAgent.startsWith("Node.js/"));
        const i2 = t2.isNode ? "node" : navigator.userAgent, s2 = t2.isNode ? "node" : navigator.platform;
        t2.isFirefox = i2.includes("Firefox"), t2.isChrome = i2.includes("Chrome"), t2.isLegacyEdge = i2.includes("Edge"), t2.isSafari = /^((?!chrome|android).)*safari/i.test(i2), t2.isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(s2), t2.isWindows = ["Windows", "Win16", "Win32", "WinCE"].includes(s2), t2.isLinux = s2.indexOf("Linux") >= 0, t2.isChromeOS = /\bCrOS\b/.test(i2);
      }, 717(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.EscapeSequenceParser = t2.VT500_TRANSITION_TABLE = t2.TransitionTable = void 0;
        const s2 = i2(812), r2 = i2(262), n2 = i2(346), a = i2(823), o = i2(607);
        class h {
          constructor(e3) {
            this.table = new Uint16Array(e3);
          }
          setDefault(e3, t3) {
            this.table.fill(e3 << 8 | t3);
          }
          add(e3, t3, i3, s3) {
            this.table[t3 << 8 | e3] = i3 << 8 | s3;
          }
          addMany(e3, t3, i3, s3) {
            for (let r3 = 0; r3 < e3.length; r3++) this.table[t3 << 8 | e3[r3]] = i3 << 8 | s3;
          }
        }
        t2.TransitionTable = h;
        const c = 160;
        t2.VT500_TRANSITION_TABLE = (function() {
          const e3 = new h(4095), t3 = Array.apply(null, Array(256)).map((e4, t4) => t4), i3 = (e4, i4) => t3.slice(e4, i4), s3 = i3(32, 127), r3 = i3(0, 24);
          r3.push(25), r3.push.apply(r3, i3(28, 32));
          const n3 = i3(0, 15);
          e3.setDefault(1, 0), e3.addMany(s3, 0, 2, 0);
          for (const t4 of n3) e3.addMany([24, 26, 153, 154], t4, 3, 0), e3.addMany(i3(128, 144), t4, 3, 0), e3.addMany(i3(144, 152), t4, 3, 0), e3.add(156, t4, 0, 0), e3.add(27, t4, 11, 1), e3.add(157, t4, 4, 8), e3.addMany([152, 158], t4, 0, 7), e3.add(159, t4, 15, 14), e3.add(155, t4, 11, 3), e3.add(144, t4, 11, 9);
          return e3.addMany(r3, 0, 3, 0), e3.addMany(r3, 1, 3, 1), e3.add(127, 1, 0, 1), e3.addMany(r3, 8, 0, 8), e3.addMany(r3, 3, 3, 3), e3.add(127, 3, 0, 3), e3.addMany(r3, 4, 3, 4), e3.add(127, 4, 0, 4), e3.addMany(r3, 6, 3, 6), e3.addMany(r3, 5, 3, 5), e3.add(127, 5, 0, 5), e3.addMany(r3, 2, 3, 2), e3.add(127, 2, 0, 2), e3.add(93, 1, 4, 8), e3.addMany(s3, 8, 5, 8), e3.add(127, 8, 5, 8), e3.addMany([156, 27, 24, 26, 7], 8, 6, 0), e3.addMany(i3(28, 32), 8, 0, 8), e3.addMany([88, 94], 1, 0, 7), e3.addMany(s3, 7, 0, 7), e3.addMany(r3, 7, 0, 7), e3.add(156, 7, 0, 0), e3.add(127, 7, 0, 7), e3.add(95, 1, 15, 14), e3.addMany(s3, 14, 16, 14), e3.addMany(r3, 14, 0, 14), e3.add(127, 14, 0, 14), e3.addMany([27, 156, 24, 26], 14, 17, 0), e3.add(91, 1, 11, 3), e3.addMany(i3(64, 127), 3, 7, 0), e3.addMany(i3(48, 60), 3, 8, 4), e3.addMany([60, 61, 62, 63], 3, 9, 4), e3.addMany(i3(48, 60), 4, 8, 4), e3.addMany(i3(64, 127), 4, 7, 0), e3.addMany([60, 61, 62, 63], 4, 0, 6), e3.addMany(i3(32, 64), 6, 0, 6), e3.add(127, 6, 0, 6), e3.addMany(i3(64, 127), 6, 0, 0), e3.addMany(i3(32, 48), 3, 9, 5), e3.addMany(i3(32, 48), 5, 9, 5), e3.addMany(i3(48, 64), 5, 0, 6), e3.addMany(i3(64, 127), 5, 7, 0), e3.addMany(i3(32, 48), 4, 9, 5), e3.addMany(i3(32, 48), 1, 9, 2), e3.addMany(i3(32, 48), 2, 9, 2), e3.addMany(i3(48, 127), 2, 10, 0), e3.addMany(i3(48, 80), 1, 10, 0), e3.addMany(i3(81, 88), 1, 10, 0), e3.addMany([89, 90, 92], 1, 10, 0), e3.addMany(i3(96, 127), 1, 10, 0), e3.add(80, 1, 11, 9), e3.addMany(r3, 9, 0, 9), e3.add(127, 9, 0, 9), e3.addMany(i3(28, 32), 9, 0, 9), e3.addMany(i3(32, 48), 9, 9, 12), e3.addMany(i3(48, 60), 9, 8, 10), e3.addMany([60, 61, 62, 63], 9, 9, 10), e3.addMany(r3, 11, 0, 11), e3.addMany(i3(32, 128), 11, 0, 11), e3.addMany(i3(28, 32), 11, 0, 11), e3.addMany(r3, 10, 0, 10), e3.add(127, 10, 0, 10), e3.addMany(i3(28, 32), 10, 0, 10), e3.addMany(i3(48, 60), 10, 8, 10), e3.addMany([60, 61, 62, 63], 10, 0, 11), e3.addMany(i3(32, 48), 10, 9, 12), e3.addMany(r3, 12, 0, 12), e3.add(127, 12, 0, 12), e3.addMany(i3(28, 32), 12, 0, 12), e3.addMany(i3(32, 48), 12, 9, 12), e3.addMany(i3(48, 64), 12, 0, 11), e3.addMany(i3(64, 127), 12, 12, 13), e3.addMany(i3(64, 127), 10, 12, 13), e3.addMany(i3(64, 127), 9, 12, 13), e3.addMany(r3, 13, 13, 13), e3.addMany(s3, 13, 13, 13), e3.add(127, 13, 0, 13), e3.addMany([27, 156, 24, 26], 13, 14, 0), e3.add(c, 0, 2, 0), e3.add(c, 8, 5, 8), e3.add(c, 6, 0, 6), e3.add(c, 11, 0, 11), e3.add(c, 13, 13, 13), e3.add(c, 14, 16, 14), e3;
        })();
        class l extends s2.Disposable {
          constructor(e3 = t2.VT500_TRANSITION_TABLE) {
            super(), this._transitions = e3, this._parseStack = { state: 0, handlers: [], handlerPos: 0, transition: 0, chunkPos: 0 }, this.initialState = 0, this.currentState = this.initialState, this._params = new r2.Params(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0, this._printHandlerFb = (e4, t3, i3) => {
            }, this._executeHandlerFb = (e4) => {
            }, this._csiHandlerFb = (e4, t3) => {
            }, this._escHandlerFb = (e4) => {
            }, this._errorHandlerFb = (e4) => e4, this._printHandler = this._printHandlerFb, this._executeHandlers = /* @__PURE__ */ Object.create(null), this._csiHandlers = /* @__PURE__ */ Object.create(null), this._escHandlers = /* @__PURE__ */ Object.create(null), this._register((0, s2.toDisposable)(() => {
              this._csiHandlers = /* @__PURE__ */ Object.create(null), this._executeHandlers = /* @__PURE__ */ Object.create(null), this._escHandlers = /* @__PURE__ */ Object.create(null);
            })), this._oscParser = this._register(new n2.OscParser()), this._dcsParser = this._register(new a.DcsParser()), this._apcParser = this._register(new o.ApcParser()), this._errorHandler = this._errorHandlerFb, this.registerEscHandler({ final: "\\" }, () => true);
          }
          _identifier(e3, t3 = [64, 126]) {
            let i3 = 0;
            if (e3.prefix) {
              if (e3.prefix.length > 1) throw new Error("only one byte as prefix supported");
              if (i3 = e3.prefix.charCodeAt(0), i3 && 60 > i3 || i3 > 63) throw new Error("prefix must be in range 0x3c .. 0x3f");
            }
            if (e3.intermediates) {
              if (e3.intermediates.length > 2) throw new Error("only two bytes as intermediates are supported");
              for (let t4 = 0; t4 < e3.intermediates.length; ++t4) {
                const s4 = e3.intermediates.charCodeAt(t4);
                if (32 > s4 || s4 > 47) throw new Error("intermediate must be in range 0x20 .. 0x2f");
                i3 <<= 8, i3 |= s4;
              }
            }
            if (1 !== e3.final.length) throw new Error("final must be a single byte");
            const s3 = e3.final.charCodeAt(0);
            if (t3[0] > s3 || s3 > t3[1]) throw new Error(`final must be in range ${t3[0]} .. ${t3[1]}`);
            return i3 <<= 8, i3 |= s3, i3;
          }
          identToString(e3) {
            const t3 = [];
            for (; e3; ) t3.push(String.fromCharCode(255 & e3)), e3 >>= 8;
            return t3.reverse().join("");
          }
          setPrintHandler(e3) {
            this._printHandler = e3;
          }
          clearPrintHandler() {
            this._printHandler = this._printHandlerFb;
          }
          registerEscHandler(e3, t3) {
            const i3 = this._identifier(e3, [48, 126]);
            this._escHandlers[i3] ??= [];
            const s3 = this._escHandlers[i3];
            return s3.push(t3), { dispose: () => {
              const e4 = s3.indexOf(t3);
              -1 !== e4 && s3.splice(e4, 1);
            } };
          }
          clearEscHandler(e3) {
            this._escHandlers[this._identifier(e3, [48, 126])] && delete this._escHandlers[this._identifier(e3, [48, 126])];
          }
          setEscHandlerFallback(e3) {
            this._escHandlerFb = e3;
          }
          setExecuteHandler(e3, t3) {
            this._executeHandlers[e3.charCodeAt(0)] = t3;
          }
          clearExecuteHandler(e3) {
            this._executeHandlers[e3.charCodeAt(0)] && delete this._executeHandlers[e3.charCodeAt(0)];
          }
          setExecuteHandlerFallback(e3) {
            this._executeHandlerFb = e3;
          }
          registerCsiHandler(e3, t3) {
            const i3 = this._identifier(e3);
            this._csiHandlers[i3] ??= [];
            const s3 = this._csiHandlers[i3];
            return s3.push(t3), { dispose: () => {
              const e4 = s3.indexOf(t3);
              -1 !== e4 && s3.splice(e4, 1);
            } };
          }
          clearCsiHandler(e3) {
            this._csiHandlers[this._identifier(e3)] && delete this._csiHandlers[this._identifier(e3)];
          }
          setCsiHandlerFallback(e3) {
            this._csiHandlerFb = e3;
          }
          registerDcsHandler(e3, t3) {
            return this._dcsParser.registerHandler(this._identifier(e3), t3);
          }
          clearDcsHandler(e3) {
            this._dcsParser.clearHandler(this._identifier(e3));
          }
          setDcsHandlerFallback(e3) {
            this._dcsParser.setHandlerFallback(e3);
          }
          registerOscHandler(e3, t3) {
            return this._oscParser.registerHandler(e3, t3);
          }
          clearOscHandler(e3) {
            this._oscParser.clearHandler(e3);
          }
          setOscHandlerFallback(e3) {
            this._oscParser.setHandlerFallback(e3);
          }
          registerApcHandler(e3, t3) {
            return this._apcParser.registerHandler(e3, t3);
          }
          clearApcHandler(e3) {
            this._apcParser.clearHandler(e3);
          }
          setApcHandlerFallback(e3) {
            this._apcParser.setHandlerFallback(e3);
          }
          setErrorHandler(e3) {
            this._errorHandler = e3;
          }
          clearErrorHandler() {
            this._errorHandler = this._errorHandlerFb;
          }
          reset() {
            this.currentState = this.initialState, this._oscParser.reset(), this._dcsParser.reset(), this._apcParser.reset(), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0, 0 !== this._parseStack.state && (this._parseStack.state = 2, this._parseStack.handlers = []);
          }
          _preserveStack(e3, t3, i3, s3, r3) {
            this._parseStack.state = e3, this._parseStack.handlers = t3, this._parseStack.handlerPos = i3, this._parseStack.transition = s3, this._parseStack.chunkPos = r3;
          }
          parse(e3, t3, i3) {
            let s3, r3 = 0, n3 = 0, a2 = 0;
            if (this._parseStack.state) if (2 === this._parseStack.state) this._parseStack.state = 0, a2 = this._parseStack.chunkPos + 1;
            else {
              if (void 0 === i3 || 1 === this._parseStack.state) throw this._parseStack.state = 1, new Error("improper continuation due to previous async handler, giving up parsing");
              const t4 = this._parseStack.handlers;
              let n4 = this._parseStack.handlerPos - 1;
              switch (this._parseStack.state) {
                case 3:
                  if (false === i3 && n4 > -1) {
                    for (; n4 >= 0 && (s3 = t4[n4](this._params), true !== s3); n4--) if (s3 instanceof Promise) return this._parseStack.handlerPos = n4, s3;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 4:
                  if (false === i3 && n4 > -1) {
                    for (; n4 >= 0 && (s3 = t4[n4](), true !== s3); n4--) if (s3 instanceof Promise) return this._parseStack.handlerPos = n4, s3;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 6:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._dcsParser.unhook(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0;
                  break;
                case 5:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._oscParser.end(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0;
                  break;
                case 7:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._apcParser.end(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0;
              }
              this._parseStack.state = 0, a2 = this._parseStack.chunkPos + 1, this.precedingJoinState = 0, this.currentState = 255 & this._parseStack.transition;
            }
            for (let i4 = a2; i4 < t3; ++i4) {
              switch (r3 = e3[i4], n3 = this._transitions.table[this.currentState << 8 | (r3 < 160 ? r3 : c)], n3 >> 8) {
                case 2:
                  for (let s4 = i4 + 1; ; ++s4) {
                    if (s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 126 && r3 < c) {
                      this._printHandler(e3, i4, s4), i4 = s4 - 1;
                      break;
                    }
                    if (++s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 126 && r3 < c) {
                      this._printHandler(e3, i4, s4), i4 = s4 - 1;
                      break;
                    }
                    if (++s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 126 && r3 < c) {
                      this._printHandler(e3, i4, s4), i4 = s4 - 1;
                      break;
                    }
                    if (++s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 126 && r3 < c) {
                      this._printHandler(e3, i4, s4), i4 = s4 - 1;
                      break;
                    }
                  }
                  break;
                case 3:
                  this._executeHandlers[r3] ? this._executeHandlers[r3]() : this._executeHandlerFb(r3), this.precedingJoinState = 0;
                  break;
                case 0:
                  break;
                case 1:
                  if (this._errorHandler({ position: i4, code: r3, currentState: this.currentState, collect: this._collect, params: this._params, abort: false }).abort) return;
                  break;
                case 7:
                  const a3 = this._csiHandlers[this._collect << 8 | r3];
                  let o2 = a3 ? a3.length - 1 : -1;
                  for (; o2 >= 0 && (s3 = a3[o2](this._params), true !== s3); o2--) if (s3 instanceof Promise) return this._preserveStack(3, a3, o2, n3, i4), s3;
                  o2 < 0 && this._csiHandlerFb(this._collect << 8 | r3, this._params), this.precedingJoinState = 0;
                  break;
                case 8:
                  do {
                    switch (r3) {
                      case 59:
                        this._params.addParam(0);
                        break;
                      case 58:
                        this._params.addSubParam(-1);
                        break;
                      default:
                        this._params.addDigit(r3 - 48);
                    }
                  } while (++i4 < t3 && (r3 = e3[i4]) > 47 && r3 < 60);
                  i4--;
                  break;
                case 9:
                  this._collect <<= 8, this._collect |= r3;
                  break;
                case 10:
                  const h2 = this._escHandlers[this._collect << 8 | r3];
                  let l2 = h2 ? h2.length - 1 : -1;
                  for (; l2 >= 0 && (s3 = h2[l2](), true !== s3); l2--) if (s3 instanceof Promise) return this._preserveStack(4, h2, l2, n3, i4), s3;
                  l2 < 0 && this._escHandlerFb(this._collect << 8 | r3), this.precedingJoinState = 0;
                  break;
                case 11:
                  this._params.reset(), this._params.addParam(0), this._collect = 0;
                  break;
                case 12:
                  this._dcsParser.hook(this._collect << 8 | r3, this._params);
                  break;
                case 13:
                  for (let s4 = i4 + 1; ; ++s4) if (s4 >= t3 || 24 === (r3 = e3[s4]) || 26 === r3 || 27 === r3 || r3 > 127 && r3 < c) {
                    this._dcsParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 14:
                  if (s3 = this._dcsParser.unhook(24 !== r3 && 26 !== r3), s3) return this._preserveStack(6, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0;
                  break;
                case 4:
                  this._oscParser.start();
                  break;
                case 5:
                  for (let s4 = i4 + 1; ; s4++) if (s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 127 && r3 < c) {
                    this._oscParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 6:
                  if (s3 = this._oscParser.end(24 !== r3 && 26 !== r3), s3) return this._preserveStack(5, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0;
                  break;
                case 15:
                  this._apcParser.start();
                  break;
                case 16:
                  for (let s4 = i4 + 1; ; ++s4) if (s4 >= t3 || 24 === (r3 = e3[s4]) || 26 === r3 || 27 === r3 || 156 === r3 || r3 > 127 && r3 < c) {
                    this._apcParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 17:
                  if (s3 = this._apcParser.end(24 !== r3 && 26 !== r3), s3) return this._preserveStack(7, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.reset(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0;
              }
              this.currentState = 255 & n3;
            }
          }
        }
        t2.EscapeSequenceParser = l;
      }, 726(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Utf8ToUtf32 = t2.StringToUtf32 = void 0, t2.stringFromCodePoint = function(e3) {
          return e3 > 65535 ? (e3 -= 65536, String.fromCharCode(55296 + (e3 >> 10)) + String.fromCharCode(e3 % 1024 + 56320)) : String.fromCharCode(e3);
        }, t2.utf32ToString = function(e3, t3 = 0, i2 = e3.length) {
          let s2 = "";
          for (let r2 = t3; r2 < i2; ++r2) {
            let t4 = e3[r2];
            t4 > 65535 ? (t4 -= 65536, s2 += String.fromCharCode(55296 + (t4 >> 10)) + String.fromCharCode(t4 % 1024 + 56320)) : s2 += String.fromCharCode(t4);
          }
          return s2;
        }, t2.StringToUtf32 = class {
          constructor() {
            this._interim = 0;
          }
          clear() {
            this._interim = 0;
          }
          decode(e3, t3) {
            const i2 = e3.length;
            if (!i2) return 0;
            let s2 = 0, r2 = 0;
            if (this._interim) {
              const i3 = e3.charCodeAt(r2++);
              56320 <= i3 && i3 <= 57343 ? t3[s2++] = 1024 * (this._interim - 55296) + i3 - 56320 + 65536 : (t3[s2++] = this._interim, t3[s2++] = i3), this._interim = 0;
            }
            for (let n2 = r2; n2 < i2; ++n2) {
              const r3 = e3.charCodeAt(n2);
              if (55296 <= r3 && r3 <= 56319) {
                if (++n2 >= i2) return this._interim = r3, s2;
                const a = e3.charCodeAt(n2);
                56320 <= a && a <= 57343 ? t3[s2++] = 1024 * (r3 - 55296) + a - 56320 + 65536 : (t3[s2++] = r3, t3[s2++] = a);
                continue;
              }
              65279 !== r3 && (t3[s2++] = r3);
            }
            return s2;
          }
        }, t2.Utf8ToUtf32 = class {
          constructor() {
            this.interim = new Uint8Array(3);
          }
          clear() {
            this.interim.fill(0);
          }
          decode(e3, t3) {
            const i2 = e3.length;
            if (!i2) return 0;
            let s2, r2, n2, a, o = 0, h = 0, c = 0;
            if (this.interim[0]) {
              let s3 = false, r3 = this.interim[0];
              r3 &= 192 == (224 & r3) ? 31 : 224 == (240 & r3) ? 15 : 7;
              let n3, a2 = 0;
              for (; (n3 = 63 & this.interim[++a2]) && a2 < 4; ) r3 <<= 6, r3 |= n3;
              const h2 = 192 == (224 & this.interim[0]) ? 2 : 224 == (240 & this.interim[0]) ? 3 : 4, l2 = h2 - a2;
              for (; c < l2; ) {
                if (c >= i2) return 0;
                if (n3 = e3[c++], 128 != (192 & n3)) {
                  c--, s3 = true;
                  break;
                }
                this.interim[a2++] = n3, r3 <<= 6, r3 |= 63 & n3;
              }
              s3 || (2 === h2 ? r3 < 128 ? c-- : t3[o++] = r3 : 3 === h2 ? r3 < 2048 || r3 >= 55296 && r3 <= 57343 || 65279 === r3 || (t3[o++] = r3) : r3 < 65536 || r3 > 1114111 || (t3[o++] = r3)), this.interim.fill(0);
            }
            const l = i2 - 4;
            let _2 = c;
            for (; _2 < i2; ) {
              for (; !(!(_2 < l) || 128 & (s2 = e3[_2]) || 128 & (r2 = e3[_2 + 1]) || 128 & (n2 = e3[_2 + 2]) || 128 & (a = e3[_2 + 3])); ) t3[o++] = s2, t3[o++] = r2, t3[o++] = n2, t3[o++] = a, _2 += 4;
              if (s2 = e3[_2++], s2 < 128) t3[o++] = s2;
              else if (192 == (224 & s2)) {
                if (_2 >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_2++], 128 != (192 & r2)) {
                  _2--;
                  continue;
                }
                if (h = (31 & s2) << 6 | 63 & r2, h < 128) {
                  _2--;
                  continue;
                }
                t3[o++] = h;
              } else if (224 == (240 & s2)) {
                if (_2 >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_2++], 128 != (192 & r2)) {
                  _2--;
                  continue;
                }
                if (_2 >= i2) return this.interim[0] = s2, this.interim[1] = r2, o;
                if (n2 = e3[_2++], 128 != (192 & n2)) {
                  _2--;
                  continue;
                }
                if (h = (15 & s2) << 12 | (63 & r2) << 6 | 63 & n2, h < 2048 || h >= 55296 && h <= 57343 || 65279 === h) continue;
                t3[o++] = h;
              } else if (240 == (248 & s2)) {
                if (_2 >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_2++], 128 != (192 & r2)) {
                  _2--;
                  continue;
                }
                if (_2 >= i2) return this.interim[0] = s2, this.interim[1] = r2, o;
                if (n2 = e3[_2++], 128 != (192 & n2)) {
                  _2--;
                  continue;
                }
                if (_2 >= i2) return this.interim[0] = s2, this.interim[1] = r2, this.interim[2] = n2, o;
                if (a = e3[_2++], 128 != (192 & a)) {
                  _2--;
                  continue;
                }
                if (h = (7 & s2) << 18 | (63 & r2) << 12 | (63 & n2) << 6 | 63 & a, h < 65536 || h > 1114111) continue;
                t3[o++] = h;
              }
            }
            return o;
          }
        };
      }, 732(e2, t2) {
        function i2(e3, t3, i3) {
          if (t3 === e3.length - 1) return e3[t3].getTrimmedLength();
          const s2 = !e3[t3].hasContent(i3 - 1) && 1 === e3[t3].getWidth(i3 - 1), r2 = 2 === e3[t3 + 1].getWidth(0);
          return s2 && r2 ? i3 - 1 : i3;
        }
        Object.defineProperty(t2, "__esModule", { value: true }), t2.reflowLargerGetLinesToRemove = function(e3, t3, s2, r2, n2, a) {
          const o = [];
          for (let h = 0; h < e3.length - 1; h++) {
            let c = h, l = e3.get(++c);
            if (!l.isWrapped) continue;
            const _2 = [e3.get(h)];
            for (; c < e3.length && l.isWrapped; ) _2.push(l), l = e3.get(++c);
            if (!a && r2 >= h && r2 < c) {
              h += _2.length - 1;
              continue;
            }
            let d = 0, f = i2(_2, d, t3), u = 1, p2 = 0;
            for (; u < _2.length; ) {
              const e4 = i2(_2, u, t3), r3 = e4 - p2, a2 = s2 - f, o2 = Math.min(r3, a2);
              _2[d].copyCellsFrom(_2[u], p2, f, o2, false), f += o2, f === s2 && (d++, f = 0), p2 += o2, p2 === e4 && (u++, p2 = 0), 0 === f && 0 !== d && 2 === _2[d - 1].getWidth(s2 - 1) && (_2[d].copyCellsFrom(_2[d - 1], s2 - 1, f++, 1, false), _2[d - 1].setCell(s2 - 1, n2));
            }
            _2[d].replaceCells(f, s2, n2);
            let g2 = 0;
            for (let e4 = _2.length - 1; e4 > 0 && (e4 > d || 0 === _2[e4].getTrimmedLength()); e4--) g2++;
            g2 > 0 && (o.push(h + _2.length - g2), o.push(g2)), h += _2.length - 1;
          }
          return o;
        }, t2.reflowLargerCreateNewLayout = function(e3, t3) {
          const i3 = [];
          let s2 = 0, r2 = t3[s2], n2 = 0;
          for (let a = 0; a < e3.length; a++) if (r2 === a) {
            const i4 = t3[++s2];
            e3.onDeleteEmitter.fire({ index: a - n2, amount: i4 }), a += i4 - 1, n2 += i4, r2 = t3[++s2];
          } else i3.push(a);
          return { layout: i3, countRemoved: n2 };
        }, t2.reflowLargerApplyNewLayout = function(e3, t3) {
          const i3 = [];
          for (let s2 = 0; s2 < t3.length; s2++) i3.push(e3.get(t3[s2]));
          for (let t4 = 0; t4 < i3.length; t4++) e3.set(t4, i3[t4]);
          e3.length = t3.length;
        }, t2.reflowSmallerGetNewLineLengths = function(e3, t3, s2) {
          const r2 = [], n2 = e3.map((s3, r3) => i2(e3, r3, t3)).reduce((e4, t4) => e4 + t4);
          let a = 0, o = 0, h = 0;
          for (; h < n2; ) {
            if (n2 - h < s2) {
              r2.push(n2 - h);
              break;
            }
            a += s2;
            const c = i2(e3, o, t3);
            a > c && (a -= c, o++);
            const l = 2 === e3[o].getWidth(a - 1);
            l && a--;
            const _2 = l ? s2 - 1 : s2;
            r2.push(_2), h += _2;
          }
          return r2;
        }, t2.getWrappedLineTrimmedLength = i2;
      }, 746(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CharsetService = void 0, t2.CharsetService = class {
          constructor() {
            this.glevel = 0, this._charsets = [];
          }
          get charsets() {
            return this._charsets;
          }
          reset() {
            this.charset = void 0, this._charsets = [], this.glevel = 0;
          }
          setgLevel(e3) {
            this.glevel = e3, this.charset = this._charsets[e3];
          }
          setgCharset(e3, t3) {
            this._charsets[e3] = t3, this.glevel === e3 && (this.charset = t3);
          }
        };
      }, 760(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DEFAULT_CHARSET = t2.CHARSETS = void 0, t2.CHARSETS = {}, t2.DEFAULT_CHARSET = t2.CHARSETS.B, t2.CHARSETS[0] = { "`": "◆", a: "▒", b: "␉", c: "␌", d: "␍", e: "␊", f: "°", g: "±", h: "␤", i: "␋", j: "┘", k: "┐", l: "┌", m: "└", n: "┼", o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│", y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·" }, t2.CHARSETS.A = { "#": "£" }, t2.CHARSETS.B = void 0, t2.CHARSETS[4] = { "#": "£", "@": "¾", "[": "ij", "\\": "½", "]": "|", "{": "¨", "|": "f", "}": "¼", "~": "´" }, t2.CHARSETS.C = t2.CHARSETS[5] = { "[": "Ä", "\\": "Ö", "]": "Å", "^": "Ü", "`": "é", "{": "ä", "|": "ö", "}": "å", "~": "ü" }, t2.CHARSETS.R = { "#": "£", "@": "à", "[": "°", "\\": "ç", "]": "§", "{": "é", "|": "ù", "}": "è", "~": "¨" }, t2.CHARSETS.Q = { "@": "à", "[": "â", "\\": "ç", "]": "ê", "^": "î", "`": "ô", "{": "é", "|": "ù", "}": "è", "~": "û" }, t2.CHARSETS.K = { "@": "§", "[": "Ä", "\\": "Ö", "]": "Ü", "{": "ä", "|": "ö", "}": "ü", "~": "ß" }, t2.CHARSETS.Y = { "#": "£", "@": "§", "[": "°", "\\": "ç", "]": "é", "`": "ù", "{": "à", "|": "ò", "}": "è", "~": "ì" }, t2.CHARSETS.E = t2.CHARSETS[6] = { "@": "Ä", "[": "Æ", "\\": "Ø", "]": "Å", "^": "Ü", "`": "ä", "{": "æ", "|": "ø", "}": "å", "~": "ü" }, t2.CHARSETS.Z = { "#": "£", "@": "§", "[": "¡", "\\": "Ñ", "]": "¿", "{": "°", "|": "ñ", "}": "ç" }, t2.CHARSETS.H = t2.CHARSETS[7] = { "@": "É", "[": "Ä", "\\": "Ö", "]": "Å", "^": "Ü", "`": "é", "{": "ä", "|": "ö", "}": "å", "~": "ü" }, t2.CHARSETS["="] = { "#": "ù", "@": "à", "[": "é", "\\": "ç", "]": "ê", "^": "î", _: "è", "`": "ô", "{": "ä", "|": "ö", "}": "ü", "~": "û" };
      }, 777(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CoreTerminal = void 0;
        const s2 = i2(501), r2 = i2(25), n2 = i2(276), a = i2(640), o = i2(56), h = i2(71), c = i2(792), l = i2(415), _2 = i2(746), d = i2(882), f = i2(486), u = i2(562), p2 = i2(811), g2 = i2(636), v2 = i2(812);
        let b2 = false;
        class S2 extends v2.Disposable {
          get onScroll() {
            return this._onScrollApi || (this._onScrollApi = this._register(new g2.Emitter()), this._onScroll.event((e3) => {
              this._onScrollApi?.fire(e3.position);
            })), this._onScrollApi.event;
          }
          get cols() {
            return this._bufferService.cols;
          }
          get rows() {
            return this._bufferService.rows;
          }
          get buffers() {
            return this._bufferService.buffers;
          }
          get options() {
            return this.optionsService.options;
          }
          set options(e3) {
            for (const t3 in e3) this.optionsService.options[t3] = e3[t3];
          }
          constructor(e3) {
            super(), this._windowsWrappingHeuristics = this._register(new v2.MutableDisposable()), this._onBinary = this._register(new g2.Emitter()), this.onBinary = this._onBinary.event, this._onData = this._register(new g2.Emitter()), this.onData = this._onData.event, this._onLineFeed = this._register(new g2.Emitter()), this.onLineFeed = this._onLineFeed.event, this._onRender = this._register(new g2.Emitter()), this.onRender = this._onRender.event, this._onResize = this._register(new g2.Emitter()), this.onResize = this._onResize.event, this._onWriteParsed = this._register(new g2.Emitter()), this.onWriteParsed = this._onWriteParsed.event, this._onScroll = this._register(new g2.Emitter()), this._instantiationService = new r2.InstantiationService(), this.optionsService = this._register(new o.OptionsService(e3)), this._instantiationService.setService(s2.IOptionsService, this.optionsService), this._logService = this._register(this._instantiationService.createInstance(n2.LogService)), this._instantiationService.setService(s2.ILogService, this._logService), this._bufferService = this._register(this._instantiationService.createInstance(a.BufferService)), this._instantiationService.setService(s2.IBufferService, this._bufferService), this.coreService = this._register(this._instantiationService.createInstance(h.CoreService)), this._instantiationService.setService(s2.ICoreService, this.coreService), this.coreMouseService = this._register(this._instantiationService.createInstance(c.CoreMouseService)), this._instantiationService.setService(s2.ICoreMouseService, this.coreMouseService), this.unicodeService = this._register(this._instantiationService.createInstance(l.UnicodeService)), this._instantiationService.setService(s2.IUnicodeService, this.unicodeService), this._charsetService = this._instantiationService.createInstance(_2.CharsetService), this._instantiationService.setService(s2.ICharsetService, this._charsetService), this._oscLinkService = this._instantiationService.createInstance(p2.OscLinkService), this._instantiationService.setService(s2.IOscLinkService, this._oscLinkService), this._inputHandler = this._register(new f.InputHandler(this._bufferService, this._charsetService, this.coreService, this._logService, this.optionsService, this._oscLinkService, this.coreMouseService, this.unicodeService)), this._register(g2.EventUtils.forward(this._inputHandler.onLineFeed, this._onLineFeed)), this._register(g2.EventUtils.forward(this._bufferService.onResize, this._onResize)), this._register(g2.EventUtils.forward(this.coreService.onData, this._onData)), this._register(g2.EventUtils.forward(this.coreService.onBinary, this._onBinary)), this._register(this.coreService.onRequestScrollToBottom(() => this.scrollToBottom(true))), this._register(this.coreService.onUserInput(() => this._writeBuffer.handleUserInput())), this._register(this.optionsService.onMultipleOptionChange(["windowsPty"], () => this._handleWindowsPtyOptionChange())), this._register(this._bufferService.onScroll(() => {
              this._onScroll.fire({ position: this._bufferService.buffer.ydisp }), this._inputHandler.markRangeDirty(this._bufferService.buffer.scrollTop, this._bufferService.buffer.scrollBottom);
            })), this._writeBuffer = this._register(new u.WriteBuffer((e4, t3) => this._inputHandler.parse(e4, t3))), this._register(g2.EventUtils.forward(this._writeBuffer.onWriteParsed, this._onWriteParsed));
          }
          write(e3, t3) {
            this._writeBuffer.write(e3, t3);
          }
          writeSync(e3, t3) {
            this._logService.logLevel <= s2.LogLevelEnum.WARN && !b2 && (this._logService.warn("writeSync is unreliable and will be removed soon."), b2 = true), this._writeBuffer.writeSync(e3, t3);
          }
          input(e3, t3 = true) {
            this.coreService.triggerDataEvent(e3, t3);
          }
          resize(e3, t3) {
            isNaN(e3) || isNaN(t3) || (e3 = Math.max(e3, a.MINIMUM_COLS), t3 = Math.max(t3, a.MINIMUM_ROWS), this._writeBuffer.flushSync(), this._bufferService.resize(e3, t3));
          }
          scroll(e3, t3 = false) {
            this._bufferService.scroll(e3, t3);
          }
          scrollLines(e3, t3) {
            this._bufferService.scrollLines(e3, t3);
          }
          scrollPages(e3) {
            this.scrollLines(e3 * (this.rows - 1));
          }
          scrollToTop() {
            this.scrollLines(-this._bufferService.buffer.ydisp);
          }
          scrollToBottom(e3) {
            this.scrollLines(this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
          }
          scrollToLine(e3) {
            const t3 = e3 - this._bufferService.buffer.ydisp;
            0 !== t3 && this.scrollLines(t3);
          }
          registerEscHandler(e3, t3) {
            return this._inputHandler.registerEscHandler(e3, t3);
          }
          registerDcsHandler(e3, t3) {
            return this._inputHandler.registerDcsHandler(e3, t3);
          }
          registerCsiHandler(e3, t3) {
            return this._inputHandler.registerCsiHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._inputHandler.registerOscHandler(e3, t3);
          }
          registerApcHandler(e3, t3) {
            return this._inputHandler.registerApcHandler(e3, t3);
          }
          _setup() {
            this._handleWindowsPtyOptionChange();
          }
          reset() {
            this._inputHandler.reset(), this._bufferService.reset(), this._charsetService.reset(), this.coreService.reset(), this.coreMouseService.reset();
          }
          _handleWindowsPtyOptionChange() {
            let e3 = false;
            const t3 = this.optionsService.rawOptions.windowsPty;
            t3 && void 0 !== t3.buildNumber && void 0 !== t3.buildNumber && (e3 = !!("conpty" === t3.backend && t3.buildNumber < 21376)), e3 ? this._enableWindowsWrappingHeuristics() : this._windowsWrappingHeuristics.clear();
          }
          _enableWindowsWrappingHeuristics() {
            if (!this._windowsWrappingHeuristics.value) {
              const e3 = [];
              e3.push(this.onLineFeed(d.updateWindowsModeWrappedState.bind(null, this._bufferService))), e3.push(this.registerCsiHandler({ final: "H" }, () => ((0, d.updateWindowsModeWrappedState)(this._bufferService), false))), this._windowsWrappingHeuristics.value = (0, v2.toDisposable)(() => {
                for (const t3 of e3) t3.dispose();
              });
            }
          }
        }
        t2.CoreTerminal = S2;
      }, 792(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CoreMouseService = void 0;
        const n2 = i2(501), a = i2(812), o = i2(636), h = { NONE: { events: 0, restrict: () => false }, X10: { events: 1, restrict: (e3) => 4 !== e3.button && 1 === e3.action && (e3.ctrl = false, e3.alt = false, e3.shift = false, true) }, VT200: { events: 19, restrict: (e3) => 32 !== e3.action }, DRAG: { events: 23, restrict: (e3) => 32 !== e3.action || 3 !== e3.button }, ANY: { events: 31, restrict: (e3) => true } };
        function c(e3, t3) {
          let i3 = (e3.ctrl ? 16 : 0) | (e3.shift ? 4 : 0) | (e3.alt ? 8 : 0);
          return 4 === e3.button ? (i3 |= 64, i3 |= e3.action) : (i3 |= 3 & e3.button, 4 & e3.button && (i3 |= 64), 8 & e3.button && (i3 |= 128), 32 === e3.action ? i3 |= 32 : 0 !== e3.action || t3 || (i3 |= 3)), i3;
        }
        const l = String.fromCharCode, _2 = { DEFAULT: (e3) => {
          const t3 = [c(e3, false) + 32, e3.col + 32, e3.row + 32];
          return t3[0] > 255 || t3[1] > 255 || t3[2] > 255 ? "" : `\x1B[M${l(t3[0])}${l(t3[1])}${l(t3[2])}`;
        }, SGR: (e3) => {
          const t3 = 0 === e3.action && 4 !== e3.button ? "m" : "M";
          return `\x1B[<${c(e3, true)};${e3.col};${e3.row}${t3}`;
        }, SGR_PIXELS: (e3) => {
          const t3 = 0 === e3.action && 4 !== e3.button ? "m" : "M";
          return `\x1B[<${c(e3, true)};${e3.x};${e3.y}${t3}`;
        } };
        let d = class extends a.Disposable {
          constructor(e3, t3, i3) {
            super(), this._bufferService = e3, this._coreService = t3, this._optionsService = i3, this._protocols = {}, this._encodings = {}, this._activeProtocol = "", this._activeEncoding = "", this._lastEvent = null, this._wheelPartialScroll = 0, this._onProtocolChange = this._register(new o.Emitter()), this.onProtocolChange = this._onProtocolChange.event;
            for (const e4 of Object.keys(h)) this.addProtocol(e4, h[e4]);
            for (const e4 of Object.keys(_2)) this.addEncoding(e4, _2[e4]);
            this.reset();
          }
          addProtocol(e3, t3) {
            this._protocols[e3] = t3;
          }
          addEncoding(e3, t3) {
            this._encodings[e3] = t3;
          }
          get activeProtocol() {
            return this._activeProtocol;
          }
          get areMouseEventsActive() {
            return 0 !== this._protocols[this._activeProtocol].events;
          }
          set activeProtocol(e3) {
            if (!this._protocols[e3]) throw new Error(`unknown protocol "${e3}"`);
            this._activeProtocol = e3, this._onProtocolChange.fire(this._protocols[e3].events);
          }
          get activeEncoding() {
            return this._activeEncoding;
          }
          set activeEncoding(e3) {
            if (!this._encodings[e3]) throw new Error(`unknown encoding "${e3}"`);
            this._activeEncoding = e3;
          }
          reset() {
            this.activeProtocol = "NONE", this.activeEncoding = "DEFAULT", this._lastEvent = null, this._wheelPartialScroll = 0;
          }
          consumeWheelEvent(e3, t3, i3) {
            if (0 === e3.deltaY || e3.shiftKey) return 0;
            if (void 0 === t3 || void 0 === i3) return 0;
            const s3 = t3 / i3;
            let r3 = this._applyScrollModifier(e3.deltaY, e3);
            return e3.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? (r3 /= s3 + 0, Math.abs(e3.deltaY) < 50 && (r3 *= 0.3), this._wheelPartialScroll += r3, r3 = Math.floor(Math.abs(this._wheelPartialScroll)) * (this._wheelPartialScroll > 0 ? 1 : -1), this._wheelPartialScroll %= 1) : e3.deltaMode === WheelEvent.DOM_DELTA_PAGE && (r3 *= this._bufferService.rows), r3;
          }
          _applyScrollModifier(e3, t3) {
            return t3.altKey || t3.ctrlKey || t3.shiftKey ? e3 * this._optionsService.rawOptions.fastScrollSensitivity * this._optionsService.rawOptions.scrollSensitivity : e3 * this._optionsService.rawOptions.scrollSensitivity;
          }
          triggerMouseEvent(e3) {
            if (e3.col < 0 || e3.col >= this._bufferService.cols || e3.row < 0 || e3.row >= this._bufferService.rows) return false;
            if (4 === e3.button && 32 === e3.action) return false;
            if (3 === e3.button && 32 !== e3.action) return false;
            if (4 !== e3.button && (2 === e3.action || 3 === e3.action)) return false;
            if (e3.col++, e3.row++, 32 === e3.action && this._lastEvent && this._equalEvents(this._lastEvent, e3, "SGR_PIXELS" === this._activeEncoding)) return false;
            if (!this._protocols[this._activeProtocol].restrict(e3)) return false;
            const t3 = this._encodings[this._activeEncoding](e3);
            return t3 && ("DEFAULT" === this._activeEncoding ? this._coreService.triggerBinaryEvent(t3) : this._coreService.triggerDataEvent(t3, true)), this._lastEvent = e3, true;
          }
          explainEvents(e3) {
            return { down: !!(1 & e3), up: !!(2 & e3), drag: !!(4 & e3), move: !!(8 & e3), wheel: !!(16 & e3) };
          }
          _equalEvents(e3, t3, i3) {
            if (i3) {
              if (e3.x !== t3.x) return false;
              if (e3.y !== t3.y) return false;
            } else {
              if (e3.col !== t3.col) return false;
              if (e3.row !== t3.row) return false;
            }
            return e3.button === t3.button && e3.action === t3.action && e3.ctrl === t3.ctrl && e3.alt === t3.alt && e3.shift === t3.shift;
          }
        };
        t2.CoreMouseService = d, t2.CoreMouseService = d = s2([r2(0, n2.IBufferService), r2(1, n2.ICoreService), r2(2, n2.IOptionsService)], d);
      }, 793(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferLineApiView = void 0;
        const s2 = i2(55);
        t2.BufferLineApiView = class {
          constructor(e3) {
            this._line = e3;
          }
          get isWrapped() {
            return this._line.isWrapped;
          }
          get length() {
            return this._line.length;
          }
          getCell(e3, t3) {
            if (!(e3 < 0 || e3 >= this._line.length)) return t3 ? (this._line.loadCell(e3, t3), t3) : this._line.loadCell(e3, new s2.CellData());
          }
          translateToString(e3, t3, i3) {
            return this._line.translateToString(e3, t3, i3);
          }
        };
      }, 804(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.XTERM_VERSION = void 0, t2.XTERM_VERSION = "6.0.0";
      }, 811(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o = e3.length - 1; o >= 0; o--) (r3 = e3[o]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OscLinkService = void 0;
        const n2 = i2(501);
        let a = class {
          constructor(e3) {
            this._bufferService = e3, this._nextId = 1, this._entriesWithId = /* @__PURE__ */ new Map(), this._dataByLinkId = /* @__PURE__ */ new Map();
          }
          registerLink(e3) {
            const t3 = this._bufferService.buffer;
            if (void 0 === e3.id) {
              const i4 = t3.addMarker(t3.ybase + t3.y), s4 = { data: e3, id: this._nextId++, lines: [i4] };
              return i4.onDispose(() => this._removeMarkerFromLink(s4, i4)), this._dataByLinkId.set(s4.id, s4), s4.id;
            }
            const i3 = e3, s3 = this._getEntryIdKey(i3), r3 = this._entriesWithId.get(s3);
            if (r3) return this.addLineToLink(r3.id, t3.ybase + t3.y), r3.id;
            const n3 = t3.addMarker(t3.ybase + t3.y), a2 = { id: this._nextId++, key: this._getEntryIdKey(i3), data: i3, lines: [n3] };
            return n3.onDispose(() => this._removeMarkerFromLink(a2, n3)), this._entriesWithId.set(a2.key, a2), this._dataByLinkId.set(a2.id, a2), a2.id;
          }
          addLineToLink(e3, t3) {
            const i3 = this._dataByLinkId.get(e3);
            if (i3 && i3.lines.every((e4) => e4.line !== t3)) {
              const e4 = this._bufferService.buffer.addMarker(t3);
              i3.lines.push(e4), e4.onDispose(() => this._removeMarkerFromLink(i3, e4));
            }
          }
          getLinkData(e3) {
            return this._dataByLinkId.get(e3)?.data;
          }
          _getEntryIdKey(e3) {
            return `${e3.id};;${e3.uri}`;
          }
          _removeMarkerFromLink(e3, t3) {
            const i3 = e3.lines.indexOf(t3);
            -1 !== i3 && (e3.lines.splice(i3, 1), 0 === e3.lines.length && (void 0 !== e3.data.id && this._entriesWithId.delete(e3.key), this._dataByLinkId.delete(e3.id)));
          }
        };
        t2.OscLinkService = a, t2.OscLinkService = a = s2([r2(0, n2.IBufferService)], a);
      }, 812(e2, t2) {
        function i2(e3) {
          return { dispose: e3 };
        }
        function s2(e3) {
          if (!e3) return e3;
          if (Array.isArray(e3)) {
            for (const t3 of e3) t3.dispose();
            return [];
          }
          return e3.dispose(), e3;
        }
        Object.defineProperty(t2, "__esModule", { value: true }), t2.MutableDisposable = t2.Disposable = t2.DisposableStore = void 0, t2.toDisposable = i2, t2.dispose = s2, t2.combinedDisposable = function(...e3) {
          return i2(() => s2(e3));
        };
        class r2 {
          constructor() {
            this._disposables = /* @__PURE__ */ new Set(), this._isDisposed = false;
          }
          get isDisposed() {
            return this._isDisposed;
          }
          add(e3) {
            return this._isDisposed ? e3.dispose() : this._disposables.add(e3), e3;
          }
          dispose() {
            if (!this._isDisposed) {
              this._isDisposed = true;
              for (const e3 of this._disposables) e3.dispose();
              this._disposables.clear();
            }
          }
          clear() {
            for (const e3 of this._disposables) e3.dispose();
            this._disposables.clear();
          }
        }
        t2.DisposableStore = r2;
        class n2 {
          constructor() {
            this._store = new r2();
          }
          dispose() {
            this._store.dispose();
          }
          _register(e3) {
            return this._store.add(e3);
          }
        }
        t2.Disposable = n2, n2.None = Object.freeze({ dispose() {
        } }), t2.MutableDisposable = class {
          constructor() {
            this._isDisposed = false;
          }
          get value() {
            return this._isDisposed ? void 0 : this._value;
          }
          set value(e3) {
            this._isDisposed || e3 === this._value || (this._value?.dispose(), this._value = e3);
          }
          clear() {
            this.value = void 0;
          }
          dispose() {
            this._isDisposed = true, this._value?.dispose(), this._value = void 0;
          }
        };
      }, 823(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DcsHandler = t2.DcsParser = void 0;
        const s2 = i2(726), r2 = i2(262), n2 = [];
        t2.DcsParser = class {
          constructor() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._active = n2, this._ident = 0, this._handlerFb = () => {
            }, this._stack = { paused: false, loopPosition: 0, fallThrough: false };
          }
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = n2;
          }
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          reset() {
            if (this._active.length) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].unhook(false);
            this._stack.paused = false, this._active = n2, this._ident = 0;
          }
          hook(e3, t3) {
            if (this.reset(), this._ident = e3, this._active = this._handlers[e3] || n2, this._active.length) for (let e4 = this._active.length - 1; e4 >= 0; e4--) this._active[e4].hook(t3);
            else this._handlerFb(this._ident, "HOOK", t3);
          }
          put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._ident, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          unhook(e3, t3 = true) {
            if (this._active.length) {
              let i3 = false, s3 = this._active.length - 1, r3 = false;
              if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                for (; s3 >= 0 && (i3 = this._active[s3].unhook(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                s3--;
              }
              for (; s3 >= 0; s3--) if (i3 = this._active[s3].unhook(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
            } else this._handlerFb(this._ident, "UNHOOK", e3);
            this._active = n2, this._ident = 0;
          }
        };
        const a = new r2.Params();
        a.addParam(0);
        class o {
          constructor(e3) {
            this._handler = e3, this._data = "", this._params = a, this._hitLimit = false;
          }
          hook(e3) {
            this._params = e3.length > 1 || e3.params[0] ? e3.clone() : a, this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > o._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          unhook(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data, this._params), t3 instanceof Promise)) return t3.then((e4) => (this._params = a, this._data = "", this._hitLimit = false, e4));
            return this._params = a, this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.DcsHandler = o, o._payloadLimit = 1e7;
      }, 856(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Terminal = void 0;
        const s2 = i2(107), r2 = i2(777), n2 = i2(636);
        class a extends r2.CoreTerminal {
          constructor(e3 = {}) {
            super(e3), this._onBell = this._register(new n2.Emitter()), this.onBell = this._onBell.event, this._onCursorMove = this._register(new n2.Emitter()), this.onCursorMove = this._onCursorMove.event, this._onTitleChange = this._register(new n2.Emitter()), this.onTitleChange = this._onTitleChange.event, this._onA11yCharEmitter = this._register(new n2.Emitter()), this.onA11yChar = this._onA11yCharEmitter.event, this._onA11yTabEmitter = this._register(new n2.Emitter()), this.onA11yTab = this._onA11yTabEmitter.event, this._setup(), this._register(this._inputHandler.onRequestBell(() => this.bell())), this._register(this._inputHandler.onRequestReset(() => this.reset())), this._register(n2.EventUtils.forward(this._inputHandler.onCursorMove, this._onCursorMove)), this._register(n2.EventUtils.forward(this._inputHandler.onTitleChange, this._onTitleChange)), this._register(n2.EventUtils.forward(this._inputHandler.onA11yChar, this._onA11yCharEmitter)), this._register(n2.EventUtils.forward(this._inputHandler.onA11yTab, this._onA11yTabEmitter)), this._register(n2.EventUtils.forward(n2.EventUtils.map(this._inputHandler.onRequestRefreshRows, (e4) => ({ start: e4?.start ?? 0, end: e4?.end ?? this.rows - 1 })), this._onRender));
          }
          get buffer() {
            return this.buffers.active;
          }
          get markers() {
            return this.buffer.markers;
          }
          addMarker(e3) {
            if (this.buffer === this.buffers.normal) return this.buffer.addMarker(this.buffer.ybase + this.buffer.y + e3);
          }
          bell() {
            this._onBell.fire();
          }
          input(e3, t3 = true) {
            this.coreService.triggerDataEvent(e3, t3);
          }
          resize(e3, t3) {
            e3 === this.cols && t3 === this.rows || super.resize(e3, t3);
          }
          clear() {
            if (0 !== this.buffer.ybase || 0 !== this.buffer.y) {
              this.buffer.lines.set(0, this.buffer.lines.get(this.buffer.ybase + this.buffer.y)), this.buffer.lines.length = 1, this.buffer.ydisp = 0, this.buffer.ybase = 0, this.buffer.y = 0;
              for (let e3 = 1; e3 < this.rows; e3++) this.buffer.lines.push(this.buffer.getBlankLine(s2.DEFAULT_ATTR_DATA));
              this._onScroll.fire({ position: this.buffer.ydisp });
            }
          }
          reset() {
            this.options.rows = this.rows, this.options.cols = this.cols, this._setup(), super.reset();
          }
        }
        t2.Terminal = a;
      }, 882(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.updateWindowsModeWrappedState = function(e3) {
          const t3 = e3.buffer.lines.get(e3.buffer.ybase + e3.buffer.y - 1), i3 = t3?.get(e3.cols - 1), r2 = e3.buffer.lines.get(e3.buffer.ybase + e3.buffer.y);
          r2 && i3 && (r2.isWrapped = i3[s2.CHAR_DATA_CODE_INDEX] !== s2.NULL_CELL_CODE && i3[s2.CHAR_DATA_CODE_INDEX] !== s2.WHITESPACE_CELL_CODE);
        };
        const s2 = i2(938);
      }, 938(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.WHITESPACE_CELL_CODE = t2.WHITESPACE_CELL_WIDTH = t2.WHITESPACE_CELL_CHAR = t2.NULL_CELL_CODE = t2.NULL_CELL_WIDTH = t2.NULL_CELL_CHAR = t2.CHAR_DATA_CODE_INDEX = t2.CHAR_DATA_WIDTH_INDEX = t2.CHAR_DATA_CHAR_INDEX = t2.CHAR_DATA_ATTR_INDEX = t2.DEFAULT_EXT = t2.DEFAULT_ATTR = t2.DEFAULT_COLOR = void 0, t2.DEFAULT_COLOR = 0, t2.DEFAULT_ATTR = t2.DEFAULT_COLOR << 9 | 256, t2.DEFAULT_EXT = 0, t2.CHAR_DATA_ATTR_INDEX = 0, t2.CHAR_DATA_CHAR_INDEX = 1, t2.CHAR_DATA_WIDTH_INDEX = 2, t2.CHAR_DATA_CODE_INDEX = 3, t2.NULL_CELL_CHAR = "", t2.NULL_CELL_WIDTH = 1, t2.NULL_CELL_CODE = 0, t2.WHITESPACE_CELL_CHAR = " ", t2.WHITESPACE_CELL_WIDTH = 1, t2.WHITESPACE_CELL_CODE = 32;
      } }, t = {};
      function i(s2) {
        var r2 = t[s2];
        if (void 0 !== r2) return r2.exports;
        var n2 = t[s2] = { exports: {} };
        return e[s2].call(n2.exports, n2, n2.exports, i), n2.exports;
      }
      var s = {};
      (() => {
        var e2 = s;
        Object.defineProperty(e2, "__esModule", { value: true }), e2.Terminal = void 0;
        const t2 = i(101), r2 = i(97), n2 = i(335), a = i(856), o = i(27), h = i(812), c = ["cols", "rows"];
        class l extends h.Disposable {
          constructor(e3) {
            super(), this._core = this._register(new a.Terminal(e3)), this._addonManager = this._register(new o.AddonManager()), this._publicOptions = { ...this._core.options };
            const t3 = (e4) => this._core.options[e4], i2 = (e4, t4) => {
              this._checkReadonlyOptions(e4), this._core.options[e4] = t4;
            };
            for (const e4 in this._core.options) {
              Object.defineProperty(this._publicOptions, e4, { get: () => this._core.options[e4], set: (t4) => {
                this._checkReadonlyOptions(e4), this._core.options[e4] = t4;
              } });
              const s2 = { get: t3.bind(this, e4), set: i2.bind(this, e4) };
              Object.defineProperty(this._publicOptions, e4, s2);
            }
          }
          _checkReadonlyOptions(e3) {
            if (c.includes(e3)) throw new Error(`Option "${e3}" can only be set in the constructor`);
          }
          _checkProposedApi() {
            if (!this._core.optionsService.options.allowProposedApi) throw new Error("You must set the allowProposedApi option to true to use proposed API");
          }
          get onBell() {
            return this._core.onBell;
          }
          get onBinary() {
            return this._core.onBinary;
          }
          get onCursorMove() {
            return this._core.onCursorMove;
          }
          get onData() {
            return this._core.onData;
          }
          get onLineFeed() {
            return this._core.onLineFeed;
          }
          get onRender() {
            return this._core.onRender;
          }
          get onResize() {
            return this._core.onResize;
          }
          get onScroll() {
            return this._core.onScroll;
          }
          get onTitleChange() {
            return this._core.onTitleChange;
          }
          get onWriteParsed() {
            return this._core.onWriteParsed;
          }
          get parser() {
            return this._parser ??= new r2.ParserApi(this._core), this._parser;
          }
          get unicode() {
            return this._checkProposedApi(), new n2.UnicodeApi(this._core);
          }
          get rows() {
            return this._core.rows;
          }
          get cols() {
            return this._core.cols;
          }
          get buffer() {
            return this._buffer ??= this._register(new t2.BufferNamespaceApi(this._core)), this._buffer;
          }
          get markers() {
            return this._core.markers;
          }
          get modes() {
            const e3 = this._core.coreService.decPrivateModes;
            let t3 = "none";
            switch (this._core.coreMouseService.activeProtocol) {
              case "X10":
                t3 = "x10";
                break;
              case "VT200":
                t3 = "vt200";
                break;
              case "DRAG":
                t3 = "drag";
                break;
              case "ANY":
                t3 = "any";
            }
            return { applicationCursorKeysMode: e3.applicationCursorKeys, applicationKeypadMode: e3.applicationKeypad, bracketedPasteMode: e3.bracketedPasteMode, insertMode: this._core.coreService.modes.insertMode, mouseTrackingMode: t3, originMode: e3.origin, reverseWraparoundMode: e3.reverseWraparound, sendFocusMode: e3.sendFocus, showCursor: !this._core.coreService.isCursorHidden, synchronizedOutputMode: e3.synchronizedOutput, win32InputMode: e3.win32InputMode, wraparoundMode: e3.wraparound };
          }
          get options() {
            return this._publicOptions;
          }
          set options(e3) {
            for (const t3 in e3) this._publicOptions[t3] = e3[t3];
          }
          input(e3, t3 = true) {
            this._core.input(e3, t3);
          }
          resize(e3, t3) {
            this._verifyIntegers(e3, t3), this._core.resize(e3, t3);
          }
          registerMarker(e3 = 0) {
            return this._verifyIntegers(e3), this._core.addMarker(e3);
          }
          addMarker(e3) {
            return this.registerMarker(e3);
          }
          dispose() {
            super.dispose();
          }
          scrollLines(e3) {
            this._verifyIntegers(e3), this._core.scrollLines(e3);
          }
          scrollPages(e3) {
            this._verifyIntegers(e3), this._core.scrollPages(e3);
          }
          scrollToTop() {
            this._core.scrollToTop();
          }
          scrollToBottom() {
            this._core.scrollToBottom();
          }
          scrollToLine(e3) {
            this._verifyIntegers(e3), this._core.scrollToLine(e3);
          }
          clear() {
            this._core.clear();
          }
          write(e3, t3) {
            this._core.write(e3, t3);
          }
          writeln(e3, t3) {
            this._core.write(e3), this._core.write("\r\n", t3);
          }
          reset() {
            this._core.reset();
          }
          loadAddon(e3) {
            this._addonManager.loadAddon(this, e3);
          }
          _verifyIntegers(...e3) {
            for (const t3 of e3) if (t3 === 1 / 0 || isNaN(t3) || t3 % 1 != 0) throw new Error("This API only accepts integers");
          }
        }
        e2.Terminal = l;
      })();
      var r = exports$1;
      for (var n in s) r[n] = s[n];
      s.__esModule && Object.defineProperty(r, "__esModule", { value: true });
    })();
  })(xtermHeadless);
  return xtermHeadless;
}
var xtermHeadlessExports = requireXtermHeadless();
const ESC = "\x1B";
const BEL = "\x07";
const DEBUG_EMULATOR_TIMING = process.env.SUPERSET_TERMINAL_EMULATOR_DEBUG === "1";
const MODE_MAP = {
  1: "applicationCursorKeys",
  6: "originMode",
  7: "autoWrap",
  9: "mouseTrackingX10",
  25: "cursorVisible",
  47: "alternateScreen",
  // Legacy alternate screen
  1e3: "mouseTrackingNormal",
  1001: "mouseTrackingHighlight",
  1002: "mouseTrackingButtonEvent",
  1003: "mouseTrackingAnyEvent",
  1004: "focusReporting",
  1005: "mouseUtf8",
  1006: "mouseSgr",
  1049: "alternateScreen",
  // Modern alternate screen with save/restore
  2004: "bracketedPaste"
};
class HeadlessEmulator {
  terminal;
  serializeAddon;
  modes;
  cwd = null;
  disposed = false;
  // Pending output buffer for query responses
  pendingOutput = [];
  onDataCallback;
  // Buffer for partial escape sequences that span chunk boundaries
  escapeSequenceBuffer = "";
  // Maximum buffer size to prevent unbounded growth (safety cap)
  static MAX_ESCAPE_BUFFER_SIZE = 1024;
  constructor(options = {}) {
    const { cols = 80, rows = 24, scrollback = 2e3 } = options;
    this.terminal = new xtermHeadlessExports.Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true
    });
    this.serializeAddon = new k();
    this.terminal.loadAddon(this.serializeAddon);
    this.modes = { ...treeKill.DEFAULT_MODES };
    this.terminal.onData((data) => {
      this.pendingOutput.push(data);
      this.onDataCallback?.(data);
    });
  }
  /**
   * Set callback for terminal-generated output (query responses)
   */
  onData(callback) {
    this.onDataCallback = callback;
  }
  /**
   * Get and clear pending output (query responses)
   */
  flushPendingOutput() {
    const output = this.pendingOutput;
    this.pendingOutput = [];
    return output;
  }
  /**
   * Write data to the terminal emulator (synchronous, non-blocking)
   * Data is buffered and will be processed asynchronously.
   * Use writeSync() if you need to wait for the write to complete.
   */
  write(data) {
    if (this.disposed) return;
    if (!DEBUG_EMULATOR_TIMING) {
      this.parseEscapeSequences(data);
      this.terminal.write(data);
      return;
    }
    const parseStart = performance.now();
    this.parseEscapeSequences(data);
    const parseTime = performance.now() - parseStart;
    const terminalStart = performance.now();
    this.terminal.write(data);
    const terminalTime = performance.now() - terminalStart;
    if (parseTime > 2 || terminalTime > 2) {
      console.warn(
        `[HeadlessEmulator] write(${data.length}b): parse=${parseTime.toFixed(1)}ms, terminal=${terminalTime.toFixed(1)}ms`
      );
    }
  }
  /**
   * Write data to the terminal emulator and wait for completion.
   * Use this when you need to ensure data is processed before reading state.
   */
  async writeSync(data) {
    if (this.disposed) return;
    this.parseEscapeSequences(data);
    return new Promise((resolve) => {
      this.terminal.write(data, () => resolve());
    });
  }
  /**
   * Resize the terminal
   */
  resize(cols, rows) {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }
  /**
   * Get current terminal dimensions
   */
  getDimensions() {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows
    };
  }
  /**
   * Get current terminal modes
   */
  getModes() {
    return { ...this.modes };
  }
  /**
   * Get current working directory (from OSC-7)
   */
  getCwd() {
    return this.cwd;
  }
  /**
   * Set CWD directly (for initial session setup)
   */
  setCwd(cwd) {
    this.cwd = cwd;
  }
  /**
   * Get scrollback line count
   */
  getScrollbackLines() {
    return this.terminal.buffer.active.length;
  }
  /**
   * Flush all pending writes to the terminal.
   * Call this before getSnapshot() if you've written data without waiting.
   */
  async flush() {
    if (this.disposed) return;
    return new Promise((resolve) => {
      this.terminal.write("", () => resolve());
    });
  }
  /**
   * Generate a complete snapshot for session restore.
   * Note: Call flush() first if you have pending async writes.
   */
  getSnapshot() {
    const snapshotAnsi = this.serializeAddon.serialize({
      scrollback: this.terminal.options.scrollback ?? 2e3
    });
    const rehydrateSequences = this.generateRehydrateSequences();
    const xtermBufferType = this.terminal.buffer.active.type;
    const hasAltScreenEntry = snapshotAnsi.includes("\x1B[?1049h");
    let altBufferDebug;
    if (this.modes.alternateScreen || xtermBufferType === "alternate") {
      const altBuffer = this.terminal.buffer.alternate;
      let nonEmptyLines = 0;
      let totalChars = 0;
      const sampleLines = [];
      for (let i = 0; i < altBuffer.length; i++) {
        const line = altBuffer.getLine(i);
        if (line) {
          const lineText = line.translateToString(true);
          if (lineText.trim().length > 0) {
            nonEmptyLines++;
            totalChars += lineText.length;
            if (sampleLines.length < 3) {
              sampleLines.push(lineText.slice(0, 80));
            }
          }
        }
      }
      altBufferDebug = {
        lines: altBuffer.length,
        nonEmptyLines,
        totalChars,
        cursorX: altBuffer.cursorX,
        cursorY: altBuffer.cursorY,
        sampleLines
      };
    }
    return {
      snapshotAnsi,
      rehydrateSequences,
      cwd: this.cwd,
      modes: { ...this.modes },
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.getScrollbackLines(),
      debug: {
        xtermBufferType,
        hasAltScreenEntry,
        altBuffer: altBufferDebug,
        normalBufferLines: this.terminal.buffer.normal.length
      }
    };
  }
  /**
   * Generate a complete snapshot after flushing pending writes.
   * This is the preferred method for getting consistent snapshots.
   */
  async getSnapshotAsync() {
    await this.flush();
    return this.getSnapshot();
  }
  /**
   * Clear terminal buffer
   */
  clear() {
    if (this.disposed) return;
    this.terminal.clear();
  }
  /**
   * Reset terminal to default state
   */
  reset() {
    if (this.disposed) return;
    this.terminal.reset();
    this.modes = { ...treeKill.DEFAULT_MODES };
  }
  /**
   * Dispose of the terminal
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  /**
   * Parse escape sequences with chunk-safe buffering.
   * PTY output can split sequences across chunks, so we buffer partial sequences.
   *
   * IMPORTANT: We only buffer sequences we actually track (DECSET/DECRST and OSC-7).
   * Other escape sequences (colors, cursor moves, etc.) are NOT buffered to prevent
   * memory leaks from unbounded buffer growth.
   */
  parseEscapeSequences(data) {
    const fullData = this.escapeSequenceBuffer + data;
    this.escapeSequenceBuffer = "";
    this.parseModeChanges(fullData);
    this.parseOsc7(fullData);
    const incompleteSequence = this.findIncompleteTrackedSequence(fullData);
    if (incompleteSequence) {
      if (incompleteSequence.length <= HeadlessEmulator.MAX_ESCAPE_BUFFER_SIZE) {
        this.escapeSequenceBuffer = incompleteSequence;
      }
    }
  }
  /**
   * Find an incomplete DECSET/DECRST or OSC-7 sequence at the end of data.
   * Returns the incomplete sequence string, or null if none found.
   *
   * We ONLY buffer sequences we track:
   * - DECSET/DECRST: ESC[?...h or ESC[?...l
   * - OSC-7: ESC]7;...BEL or ESC]7;...ESC\
   *
   * Other CSI sequences (ESC[31m, ESC[H, etc.) are NOT buffered.
   */
  findIncompleteTrackedSequence(data) {
    const escEscaped = escapeRegex(ESC);
    const lastEscIndex = data.lastIndexOf(ESC);
    if (lastEscIndex === -1) return null;
    const afterLastEsc = data.slice(lastEscIndex);
    if (afterLastEsc.startsWith(`${ESC}[?`)) {
      const completePattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`);
      if (completePattern.test(afterLastEsc)) {
        const globalPattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`, "g");
        const matches = afterLastEsc.match(globalPattern);
        if (matches) {
          const lastMatch = matches[matches.length - 1];
          const lastMatchEnd = afterLastEsc.lastIndexOf(lastMatch) + lastMatch.length;
          const remainder = afterLastEsc.slice(lastMatchEnd);
          if (remainder.includes(ESC)) {
            return this.findIncompleteTrackedSequence(remainder);
          }
        }
        return null;
      }
      return afterLastEsc;
    }
    if (afterLastEsc.startsWith(`${ESC}]7;`)) {
      if (afterLastEsc.includes(BEL) || afterLastEsc.includes(`${ESC}\\`)) {
        return null;
      }
      return afterLastEsc;
    }
    if (afterLastEsc === ESC) return afterLastEsc;
    if (afterLastEsc === `${ESC}[`) return afterLastEsc;
    if (afterLastEsc === `${ESC}]`) return afterLastEsc;
    if (afterLastEsc === `${ESC}]7`) return afterLastEsc;
    const incompleteDecset = new RegExp(`^${escEscaped}\\[\\?[0-9;]*$`);
    if (incompleteDecset.test(afterLastEsc)) return afterLastEsc;
    return null;
  }
  /**
   * Parse DECSET/DECRST sequences from terminal data
   */
  parseModeChanges(data) {
    const modeRegex = new RegExp(
      `${escapeRegex(ESC)}\\[\\?([0-9;]+)([hl])`,
      "g"
    );
    for (const match of data.matchAll(modeRegex)) {
      const modesStr = match[1];
      const action = match[2];
      const enable = action === "h";
      const modeNumbers = modesStr.split(";").map((s) => Number.parseInt(s, 10));
      for (const modeNum of modeNumbers) {
        const modeName = MODE_MAP[modeNum];
        if (modeName) {
          this.modes[modeName] = enable;
        }
      }
    }
  }
  /**
   * Parse OSC-7 sequences for CWD tracking
   * Format: ESC]7;file://hostname/path BEL or ESC]7;file://hostname/path ESC\
   *
   * The path part starts after the hostname (after file://hostname).
   * Hostname can be empty, localhost, or a machine name.
   */
  parseOsc7(data) {
    const escEscaped = escapeRegex(ESC);
    const belEscaped = escapeRegex(BEL);
    const osc7Pattern = `${escEscaped}\\]7;file://[^/]*(/.+?)(?:${belEscaped}|${escEscaped}\\\\)`;
    const osc7Regex = new RegExp(osc7Pattern, "g");
    for (const match of data.matchAll(osc7Regex)) {
      if (match[1]) {
        try {
          this.cwd = decodeURIComponent(match[1]);
        } catch {
          this.cwd = match[1];
        }
      }
    }
  }
  /**
   * Generate escape sequences to restore current mode state
   * These sequences should be written to a fresh xterm instance before
   * writing the snapshot to ensure input behavior matches.
   */
  generateRehydrateSequences() {
    const sequences = [];
    const addModeSequence = (modeNum, enabled, defaultEnabled) => {
      if (enabled !== defaultEnabled) {
        sequences.push(`${ESC}[?${modeNum}${enabled ? "h" : "l"}`);
      }
    };
    addModeSequence(1, this.modes.applicationCursorKeys, false);
    addModeSequence(6, this.modes.originMode, false);
    addModeSequence(7, this.modes.autoWrap, true);
    addModeSequence(25, this.modes.cursorVisible, true);
    addModeSequence(9, this.modes.mouseTrackingX10, false);
    addModeSequence(1e3, this.modes.mouseTrackingNormal, false);
    addModeSequence(1001, this.modes.mouseTrackingHighlight, false);
    addModeSequence(1002, this.modes.mouseTrackingButtonEvent, false);
    addModeSequence(1003, this.modes.mouseTrackingAnyEvent, false);
    addModeSequence(1005, this.modes.mouseUtf8, false);
    addModeSequence(1006, this.modes.mouseSgr, false);
    addModeSequence(1004, this.modes.focusReporting, false);
    addModeSequence(2004, this.modes.bracketedPaste, false);
    return sequences.join("");
  }
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const ATTACH_FLUSH_TIMEOUT_MS = 500;
const MAX_SUBPROCESS_STDIN_QUEUE_BYTES = 2e6;
class Session {
  sessionId;
  workspaceId;
  paneId;
  tabId;
  shell;
  createdAt;
  spawnProcess;
  subprocess = null;
  subprocessReady = false;
  emulator;
  attachedClients = /* @__PURE__ */ new Map();
  clientSocketsWaitingForDrain = /* @__PURE__ */ new Set();
  subprocessStdoutPaused = false;
  lastAttachedAt;
  exitCode = null;
  disposed = false;
  terminatingAt = null;
  subprocessDecoder = null;
  subprocessStdinQueue = [];
  subprocessStdinQueuedBytes = 0;
  subprocessStdinDrainArmed = false;
  ptyPid = null;
  // Promise that resolves when PTY is ready to accept writes
  ptyReadyPromise;
  ptyReadyResolve = null;
  emulatorWriteQueue = [];
  emulatorWriteQueuedBytes = 0;
  emulatorWriteScheduled = false;
  emulatorFlushWaiters = [];
  // Snapshot boundary tracking for concurrent attaches.
  emulatorWriteProcessedItems = 0;
  nextSnapshotBoundaryWaiterId = 1;
  snapshotBoundaryWaiters = [];
  // Callbacks
  onSessionExit;
  constructor(options) {
    this.sessionId = options.sessionId;
    this.workspaceId = options.workspaceId;
    this.paneId = options.paneId;
    this.tabId = options.tabId;
    this.shell = options.shell || this.getDefaultShell();
    this.createdAt = /* @__PURE__ */ new Date();
    this.lastAttachedAt = /* @__PURE__ */ new Date();
    this.spawnProcess = options.spawnProcess ?? node_child_process.spawn;
    this.ptyReadyPromise = new Promise((resolve) => {
      this.ptyReadyResolve = resolve;
    });
    this.emulator = new HeadlessEmulator({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollbackLines ?? 2e3
    });
    this.emulator.setCwd(options.cwd);
    this.emulator.onData((data) => {
      if (this.attachedClients.size === 0 && this.subprocess && this.subprocessReady) {
        this.sendWriteToSubprocess(data);
      }
    });
  }
  /**
   * Spawn the PTY process via subprocess
   */
  spawn(options) {
    if (this.subprocess) {
      throw new Error("PTY already spawned");
    }
    const { cwd, cols, rows, env } = options;
    const envSource = env ?? process.env;
    const processEnv = treeKill.buildSafeEnv(envSource);
    processEnv.TERM = "xterm-256color";
    const shellArgs = treeKill.getShellArgs(this.shell);
    const subprocessPath = path__namespace.join(__dirname, "pty-subprocess.js");
    const electronPath = process.execPath;
    this.subprocess = this.spawnProcess(electronPath, [subprocessPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...processEnv, ELECTRON_RUN_AS_NODE: "1" }
    });
    if (this.subprocess.stdout) {
      this.subprocessDecoder = new ptySubprocessIpc.PtySubprocessFrameDecoder();
      this.subprocess.stdout.on("data", (chunk) => {
        try {
          const frames = this.subprocessDecoder?.push(chunk) ?? [];
          for (const frame of frames) {
            this.handleSubprocessFrame(frame.type, frame.payload);
          }
        } catch (error) {
          console.error(
            `[Session ${this.sessionId}] Failed to parse subprocess frames:`,
            error
          );
        }
      });
    }
    this.subprocess.on("exit", (code) => {
      console.log(
        `[Session ${this.sessionId}] Subprocess exited with code ${code}`
      );
      this.handleSubprocessExit(code ?? -1);
    });
    this.subprocess.on("error", (error) => {
      console.error(`[Session ${this.sessionId}] Subprocess error:`, error);
      this.handleSubprocessExit(-1);
    });
    this.pendingSpawn = {
      shell: this.shell,
      args: shellArgs,
      cwd,
      cols,
      rows,
      env: processEnv
    };
  }
  pendingSpawn = null;
  /**
   * Handle frames from the PTY subprocess
   */
  handleSubprocessFrame(type, payload) {
    switch (type) {
      case ptySubprocessIpc.PtySubprocessIpcType.Ready:
        this.subprocessReady = true;
        if (this.pendingSpawn) {
          this.sendSpawnToSubprocess(this.pendingSpawn);
          this.pendingSpawn = null;
        }
        break;
      case ptySubprocessIpc.PtySubprocessIpcType.Spawned:
        this.ptyPid = payload.length >= 4 ? payload.readUInt32LE(0) : null;
        if (this.ptyReadyResolve) {
          this.ptyReadyResolve();
          this.ptyReadyResolve = null;
        }
        break;
      case ptySubprocessIpc.PtySubprocessIpcType.Data: {
        if (payload.length === 0) break;
        const data = payload.toString("utf8");
        this.enqueueEmulatorWrite(data);
        this.broadcastEvent("data", {
          type: "data",
          data
        });
        break;
      }
      case ptySubprocessIpc.PtySubprocessIpcType.Exit: {
        const exitCode = payload.length >= 4 ? payload.readInt32LE(0) : 0;
        const signal = payload.length >= 8 ? payload.readInt32LE(4) : 0;
        this.exitCode = exitCode;
        this.broadcastEvent("exit", {
          type: "exit",
          exitCode,
          signal: signal !== 0 ? signal : void 0
        });
        this.onSessionExit?.(
          this.sessionId,
          exitCode,
          signal !== 0 ? signal : void 0
        );
        break;
      }
      case ptySubprocessIpc.PtySubprocessIpcType.Error: {
        const errorMessage = payload.length > 0 ? payload.toString("utf8") : "Unknown subprocess error";
        console.error(
          `[Session ${this.sessionId}] Subprocess error:`,
          errorMessage
        );
        this.broadcastEvent("error", {
          type: "error",
          error: errorMessage,
          code: errorMessage.includes("Write queue full") ? "WRITE_QUEUE_FULL" : "SUBPROCESS_ERROR"
        });
        break;
      }
    }
  }
  /**
   * Handle subprocess exiting
   */
  handleSubprocessExit(exitCode) {
    if (this.exitCode === null) {
      this.exitCode = exitCode;
      this.broadcastEvent("exit", {
        type: "exit",
        exitCode
      });
      this.onSessionExit?.(this.sessionId, exitCode);
    }
    if (this.ptyReadyResolve) {
      this.ptyReadyResolve();
      this.ptyReadyResolve = null;
    }
    this.resetProcessState();
  }
  /**
   * Flush queued frames to subprocess stdin, respecting stream backpressure.
   */
  flushSubprocessStdinQueue() {
    if (!this.subprocess?.stdin || this.disposed) return;
    while (this.subprocessStdinQueue.length > 0) {
      const buf = this.subprocessStdinQueue[0];
      const canWrite = this.subprocess.stdin.write(buf);
      if (!canWrite) {
        if (!this.subprocessStdinDrainArmed) {
          this.subprocessStdinDrainArmed = true;
          this.subprocess.stdin.once("drain", () => {
            this.subprocessStdinDrainArmed = false;
            this.flushSubprocessStdinQueue();
          });
        }
        return;
      }
      this.subprocessStdinQueue.shift();
      this.subprocessStdinQueuedBytes -= buf.length;
    }
  }
  /**
   * Send a frame to the subprocess.
   * Returns false if write buffer is full (caller should handle).
   */
  sendFrameToSubprocess(type, payload) {
    if (!this.subprocess?.stdin || this.disposed) return false;
    const payloadBuffer = payload ?? Buffer.alloc(0);
    const frameSize = 5 + payloadBuffer.length;
    if (this.subprocessStdinQueuedBytes + frameSize > MAX_SUBPROCESS_STDIN_QUEUE_BYTES) {
      console.warn(
        `[Session ${this.sessionId}] stdin queue full (${this.subprocessStdinQueuedBytes} bytes), dropping frame`
      );
      this.broadcastEvent("error", {
        type: "error",
        error: "Write queue full - input dropped",
        code: "WRITE_QUEUE_FULL"
      });
      return false;
    }
    const header = ptySubprocessIpc.createFrameHeader(type, payloadBuffer.length);
    this.subprocessStdinQueue.push(header);
    this.subprocessStdinQueuedBytes += header.length;
    if (payloadBuffer.length > 0) {
      this.subprocessStdinQueue.push(payloadBuffer);
      this.subprocessStdinQueuedBytes += payloadBuffer.length;
    }
    const wasBackpressured = this.subprocessStdinDrainArmed;
    this.flushSubprocessStdinQueue();
    if (this.subprocessStdinDrainArmed && !wasBackpressured) {
      console.warn(
        `[Session ${this.sessionId}] stdin buffer full, write may be delayed`
      );
    }
    return !this.subprocessStdinDrainArmed;
  }
  sendSpawnToSubprocess(payload) {
    return this.sendFrameToSubprocess(
      ptySubprocessIpc.PtySubprocessIpcType.Spawn,
      Buffer.from(JSON.stringify(payload), "utf8")
    );
  }
  sendWriteToSubprocess(data) {
    const MAX_CHUNK_CHARS = 8192;
    let ok = true;
    for (let offset = 0; offset < data.length; offset += MAX_CHUNK_CHARS) {
      const part = data.slice(offset, offset + MAX_CHUNK_CHARS);
      ok = this.sendFrameToSubprocess(
        ptySubprocessIpc.PtySubprocessIpcType.Write,
        Buffer.from(part, "utf8")
      ) && ok;
    }
    return ok;
  }
  sendResizeToSubprocess(cols, rows) {
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt32LE(cols, 0);
    payload.writeUInt32LE(rows, 4);
    return this.sendFrameToSubprocess(ptySubprocessIpc.PtySubprocessIpcType.Resize, payload);
  }
  sendKillToSubprocess(signal) {
    const payload = signal ? Buffer.from(signal, "utf8") : void 0;
    return this.sendFrameToSubprocess(ptySubprocessIpc.PtySubprocessIpcType.Kill, payload);
  }
  sendSignalToSubprocess(signal) {
    const payload = Buffer.from(signal, "utf8");
    return this.sendFrameToSubprocess(ptySubprocessIpc.PtySubprocessIpcType.Signal, payload);
  }
  sendDisposeToSubprocess() {
    return this.sendFrameToSubprocess(ptySubprocessIpc.PtySubprocessIpcType.Dispose);
  }
  enqueueEmulatorWrite(data) {
    this.emulatorWriteQueue.push(data);
    this.emulatorWriteQueuedBytes += data.length;
    this.scheduleEmulatorWrite();
  }
  scheduleEmulatorWrite() {
    if (this.emulatorWriteScheduled || this.disposed) return;
    this.emulatorWriteScheduled = true;
    setImmediate(() => {
      this.processEmulatorWriteQueue();
    });
  }
  processEmulatorWriteQueue() {
    if (this.disposed) {
      this.emulatorWriteQueue = [];
      this.emulatorWriteQueuedBytes = 0;
      this.emulatorWriteProcessedItems = 0;
      this.nextSnapshotBoundaryWaiterId = 1;
      this.emulatorWriteScheduled = false;
      this.resolveAllSnapshotBoundaryWaiters();
      const waiters2 = this.emulatorFlushWaiters;
      this.emulatorFlushWaiters = [];
      for (const resolve of waiters2) resolve();
      return;
    }
    const start = performance.now();
    const hasClients = this.attachedClients.size > 0;
    const backlogBytes = this.emulatorWriteQueuedBytes;
    const baseBudgetMs = hasClients ? 5 : 25;
    const budgetMs = backlogBytes > 1024 * 1024 ? Math.max(baseBudgetMs, 25) : baseBudgetMs;
    const MAX_CHUNK_CHARS = 8192;
    while (this.emulatorWriteQueue.length > 0) {
      if (performance.now() - start > budgetMs) break;
      let chunk = this.emulatorWriteQueue[0];
      if (chunk.length > MAX_CHUNK_CHARS) {
        this.emulatorWriteQueue[0] = chunk.slice(MAX_CHUNK_CHARS);
        chunk = chunk.slice(0, MAX_CHUNK_CHARS);
      } else {
        this.emulatorWriteQueue.shift();
        this.emulatorWriteProcessedItems++;
        this.resolveReachedSnapshotBoundaryWaiters();
      }
      this.emulatorWriteQueuedBytes -= chunk.length;
      this.emulator.write(chunk);
    }
    if (this.emulatorWriteQueue.length > 0) {
      setImmediate(() => {
        this.processEmulatorWriteQueue();
      });
      return;
    }
    this.emulatorWriteScheduled = false;
    this.resolveReachedSnapshotBoundaryWaiters();
    const waiters = this.emulatorFlushWaiters;
    this.emulatorFlushWaiters = [];
    for (const resolve of waiters) resolve();
  }
  resolveReachedSnapshotBoundaryWaiters() {
    if (this.snapshotBoundaryWaiters.length === 0) return;
    const remainingWaiters = [];
    for (const waiter of this.snapshotBoundaryWaiters) {
      if (this.emulatorWriteProcessedItems >= waiter.targetProcessedItems) {
        waiter.resolve();
      } else {
        remainingWaiters.push(waiter);
      }
    }
    this.snapshotBoundaryWaiters = remainingWaiters;
  }
  resolveAllSnapshotBoundaryWaiters() {
    if (this.snapshotBoundaryWaiters.length === 0) return;
    const waiters = this.snapshotBoundaryWaiters;
    this.snapshotBoundaryWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }
  /**
   * Flush emulator writes up to current queue position (snapshot boundary).
   * Unlike flushEmulatorWrites, this captures a consistent point-in-time state
   * even with continuous output - we only wait for data received BEFORE this call.
   */
  async flushToSnapshotBoundary(timeoutMs) {
    if (this.emulatorWriteQueue.length === 0) {
      return true;
    }
    const targetProcessedItems = this.emulatorWriteProcessedItems + this.emulatorWriteQueue.length;
    const waiterId = this.nextSnapshotBoundaryWaiterId++;
    let reachedBoundary = false;
    const boundaryPromise = new Promise((resolve) => {
      this.snapshotBoundaryWaiters.push({
        id: waiterId,
        targetProcessedItems,
        resolve: () => {
          reachedBoundary = true;
          resolve();
        }
      });
      this.scheduleEmulatorWrite();
      this.resolveReachedSnapshotBoundaryWaiters();
    });
    const timeoutPromise = new Promise(
      (resolve) => setTimeout(resolve, timeoutMs)
    );
    await Promise.race([boundaryPromise, timeoutPromise]);
    if (!reachedBoundary) {
      this.snapshotBoundaryWaiters = this.snapshotBoundaryWaiters.filter(
        (waiter) => waiter.id !== waiterId
      );
    }
    return reachedBoundary;
  }
  /**
   * Check if session is alive (PTY running)
   */
  get isAlive() {
    return this.subprocess !== null && this.exitCode === null;
  }
  /**
   * Get the PTY process ID for port scanning.
   * Returns null if PTY not yet spawned or has exited.
   */
  get pid() {
    return this.ptyPid;
  }
  /**
   * Check if session is in the process of terminating.
   * A terminating session has received a kill signal but hasn't exited yet.
   */
  get isTerminating() {
    return this.terminatingAt !== null;
  }
  /**
   * Check if session can be attached to.
   * A session is attachable if it's alive and not terminating.
   * This prevents race conditions where createOrAttach is called
   * immediately after kill but before the PTY has actually exited.
   */
  get isAttachable() {
    return this.isAlive && !this.isTerminating;
  }
  /**
   * Wait for PTY to be ready to accept writes.
   * Returns immediately if already ready, or waits for Spawned event.
   */
  waitForReady() {
    return this.ptyReadyPromise;
  }
  /**
   * Get number of attached clients
   */
  get clientCount() {
    return this.attachedClients.size;
  }
  /**
   * Attach a client to this session
   */
  async attach(socket) {
    if (this.disposed) {
      throw new Error("Session disposed");
    }
    this.attachedClients.set(socket, {
      socket,
      attachedAt: Date.now()
    });
    this.lastAttachedAt = /* @__PURE__ */ new Date();
    const reachedBoundary = await this.flushToSnapshotBoundary(
      ATTACH_FLUSH_TIMEOUT_MS
    );
    if (!reachedBoundary) {
      console.warn(
        `[Session ${this.sessionId}] Attach flush timeout after ${ATTACH_FLUSH_TIMEOUT_MS}ms`
      );
    }
    return this.emulator.getSnapshotAsync();
  }
  /**
   * Detach a client from this session
   */
  detach(socket) {
    this.attachedClients.delete(socket);
    this.clientSocketsWaitingForDrain.delete(socket);
    this.maybeResumeSubprocessStdout();
  }
  /**
   * Write data to PTY (non-blocking - sent to subprocess)
   */
  write(data) {
    if (!this.subprocess || !this.subprocessReady) {
      throw new Error("PTY not spawned");
    }
    this.sendWriteToSubprocess(data);
  }
  /**
   * Resize PTY and emulator
   */
  resize(cols, rows) {
    if (this.subprocess && this.subprocessReady) {
      this.sendResizeToSubprocess(cols, rows);
    }
    this.emulator.resize(cols, rows);
  }
  /**
   * Clear scrollback buffer
   */
  clearScrollback() {
    this.emulator.clear();
  }
  /**
   * Get session snapshot
   */
  getSnapshot() {
    return this.emulator.getSnapshot();
  }
  /**
   * Get session metadata
   */
  getMeta() {
    const dims = this.emulator.getDimensions();
    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      paneId: this.paneId,
      cwd: this.emulator.getCwd() || "",
      cols: dims.cols,
      rows: dims.rows,
      createdAt: this.createdAt.toISOString(),
      lastAttachedAt: this.lastAttachedAt.toISOString(),
      shell: this.shell
    };
  }
  /**
   * Send a signal to the PTY process without marking the session as terminating.
   * Used for signals like SIGINT (Ctrl+C) where the process should continue running.
   */
  sendSignal(signal) {
    if (this.terminatingAt !== null || this.disposed) {
      return;
    }
    if (this.subprocess && this.subprocessReady) {
      this.sendSignalToSubprocess(signal);
    }
  }
  /**
   * Kill the PTY process.
   * Marks the session as terminating immediately (idempotent).
   * The actual PTY termination is async - use isTerminating to check state.
   */
  kill(signal = "SIGTERM") {
    if (this.terminatingAt !== null) {
      return;
    }
    this.terminatingAt = Date.now();
    if (this.subprocess && this.subprocessReady) {
      this.sendKillToSubprocess(signal);
      return;
    }
    try {
      this.subprocess?.kill(signal);
    } catch {
    }
  }
  /** Callers that don't need to wait can fire-and-forget. */
  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    const pidsToKill = this.collectProcessPids();
    if (this.subprocess) {
      this.sendDisposeToSubprocess();
    }
    this.resetProcessState();
    this.emulator.dispose();
    this.attachedClients.clear();
    this.clientSocketsWaitingForDrain.clear();
    if (pidsToKill.length === 0) return Promise.resolve();
    return Promise.all(
      pidsToKill.map((pid) => treeKill.treeKillAsync(pid, "SIGKILL"))
    ).then(() => {
    });
  }
  /** Includes PTY PID as safety net in case the shell was reparented after subprocess exit. */
  collectProcessPids() {
    const pids = [];
    if (this.subprocess?.pid) pids.push(this.subprocess.pid);
    if (this.ptyPid) pids.push(this.ptyPid);
    return pids;
  }
  resetProcessState() {
    this.subprocess = null;
    this.subprocessReady = false;
    this.subprocessDecoder = null;
    this.subprocessStdinQueue = [];
    this.subprocessStdinQueuedBytes = 0;
    this.subprocessStdinDrainArmed = false;
    this.subprocessStdoutPaused = false;
    this.emulatorWriteQueue = [];
    this.emulatorWriteQueuedBytes = 0;
    this.emulatorWriteProcessedItems = 0;
    this.nextSnapshotBoundaryWaiterId = 1;
    this.emulatorWriteScheduled = false;
    this.resolveAllSnapshotBoundaryWaiters();
    const waiters = this.emulatorFlushWaiters;
    this.emulatorFlushWaiters = [];
    for (const resolve of waiters) resolve();
  }
  /**
   * Set exit callback
   */
  onExit(callback) {
    this.onSessionExit = callback;
  }
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  /**
   * Broadcast an event to all attached clients with backpressure awareness.
   */
  broadcastEvent(eventType, payload) {
    const event = {
      type: "event",
      event: eventType,
      sessionId: this.sessionId,
      payload
    };
    const message = `${JSON.stringify(event)}
`;
    for (const { socket } of this.attachedClients.values()) {
      try {
        const canWrite = socket.write(message);
        if (!canWrite) {
          console.warn(
            `[Session ${this.sessionId}] Client socket buffer full, output may be delayed`
          );
          this.handleClientBackpressure(socket);
        }
      } catch {
        this.attachedClients.delete(socket);
        this.clientSocketsWaitingForDrain.delete(socket);
      }
    }
  }
  handleClientBackpressure(socket) {
    if (!this.subprocessStdoutPaused && this.subprocess?.stdout) {
      this.subprocessStdoutPaused = true;
      this.subprocess.stdout.pause();
    }
    if (this.clientSocketsWaitingForDrain.has(socket)) return;
    this.clientSocketsWaitingForDrain.add(socket);
    socket.once("drain", () => {
      this.clientSocketsWaitingForDrain.delete(socket);
      this.maybeResumeSubprocessStdout();
    });
  }
  maybeResumeSubprocessStdout() {
    if (this.clientSocketsWaitingForDrain.size > 0) return;
    if (!this.subprocessStdoutPaused) return;
    if (!this.subprocess?.stdout) return;
    this.subprocessStdoutPaused = false;
    this.subprocess.stdout.resume();
  }
  /**
   * Get default shell for the platform
   */
  getDefaultShell() {
    if (process.platform === "win32") {
      return process.env.COMSPEC || "cmd.exe";
    }
    return process.env.SHELL || "/bin/zsh";
  }
}
function createSession(request) {
  return new Session({
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    paneId: request.paneId,
    tabId: request.tabId,
    cols: request.cols,
    rows: request.rows,
    cwd: request.cwd || process.env.HOME || "/",
    env: request.env,
    shell: request.shell,
    workspaceName: request.workspaceName,
    workspacePath: request.workspacePath,
    rootPath: request.rootPath
  });
}
const KILL_TIMEOUT_MS = 5e3;
const MAX_CONCURRENT_SPAWNS = 3;
const SPAWN_READY_TIMEOUT_MS = 5e3;
function promiseWithTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timeoutId);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}
class TerminalHost {
  sessions = /* @__PURE__ */ new Map();
  killTimers = /* @__PURE__ */ new Map();
  spawnLimiter = new Semaphore(MAX_CONCURRENT_SPAWNS);
  onUnattachedExit;
  constructor({
    onUnattachedExit
  } = {}) {
    this.onUnattachedExit = onUnattachedExit;
  }
  /**
   * Create or attach to a terminal session
   */
  async createOrAttach(socket, request) {
    const { sessionId } = request;
    let session = this.sessions.get(sessionId);
    let isNew = false;
    if (session?.isTerminating) {
      void session.dispose();
      this.sessions.delete(sessionId);
      this.clearKillTimer(sessionId);
      session = void 0;
    }
    if (session && !session.isAlive) {
      void session.dispose();
      this.sessions.delete(sessionId);
      session = void 0;
    }
    if (!session) {
      const releaseSpawn = await this.spawnLimiter.acquire();
      try {
        session = createSession(request);
        session.onExit((id, exitCode, signal) => {
          this.handleSessionExit(id, exitCode, signal);
        });
        session.spawn({
          cwd: request.cwd || process.env.HOME || "/",
          cols: request.cols,
          rows: request.rows,
          env: request.env
        });
        try {
          await promiseWithTimeout(
            session.waitForReady(),
            SPAWN_READY_TIMEOUT_MS
          );
        } catch {
          console.warn(
            `[TerminalHost] Timeout waiting for PTY ready for session ${sessionId}`
          );
        } finally {
          releaseSpawn();
        }
      } catch (error) {
        releaseSpawn();
        throw error;
      }
      if (!session.isAlive) {
        void session.dispose();
        throw new Error("Session spawn failed: PTY process exited immediately");
      }
      this.sessions.set(sessionId, session);
      isNew = true;
    } else {
      try {
        session.resize(request.cols, request.rows);
      } catch {
      }
    }
    const snapshot = await session.attach(socket);
    return {
      isNew,
      snapshot,
      wasRecovered: !isNew && session.isAlive,
      pid: session.pid
    };
  }
  /**
   * Write data to a terminal session.
   * Throws if session is not found or is terminating.
   */
  write(request) {
    const session = this.getActiveSession(request.sessionId);
    session.write(request.data);
    return { success: true };
  }
  /**
   * Resize a terminal session.
   * No-op if session is not found or is terminating (prevents race condition errors).
   */
  resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (!session || !session.isAttachable) {
      return { success: true };
    }
    session.resize(request.cols, request.rows);
    return { success: true };
  }
  /**
   * Detach a client from a session
   */
  detach(socket, request) {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      session.detach(socket);
      if (!session.isAlive && session.clientCount === 0) {
        void session.dispose();
        this.sessions.delete(request.sessionId);
      }
    }
    return { success: true };
  }
  /**
   * Send a signal to a terminal session (e.g., SIGINT for Ctrl+C).
   * Unlike kill, this does NOT mark the session as terminating.
   */
  signal(request) {
    const { sessionId, signal } = request;
    const session = this.sessions.get(sessionId);
    if (!session || !session.isAttachable) {
      return { success: true };
    }
    session.sendSignal(signal);
    return { success: true };
  }
  /**
   * Kill a terminal session.
   * The session is marked as terminating immediately (non-attachable).
   * A fail-safe timer ensures cleanup even if the PTY never exits.
   */
  kill(request) {
    const { sessionId } = request;
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: true };
    }
    session.kill();
    if (!this.killTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (s?.isTerminating) {
          console.warn(
            `[TerminalHost] Force disposing stuck session ${sessionId} after ${KILL_TIMEOUT_MS}ms`
          );
          void s.dispose();
          this.sessions.delete(sessionId);
        }
        this.killTimers.delete(sessionId);
      }, KILL_TIMEOUT_MS);
      this.killTimers.set(sessionId, timer);
    }
    return { success: true };
  }
  killAll(request) {
    for (const session of this.sessions.values()) {
      this.kill({
        sessionId: session.sessionId,
        deleteHistory: request.deleteHistory
      });
    }
    return { success: true };
  }
  /**
   * List all sessions.
   * Note: isAlive reports isAttachable (alive AND not terminating) to prevent
   * race conditions where killByWorkspaceId sees a session as alive while
   * it's actually in the process of being killed.
   */
  listSessions() {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      const meta = session.getMeta();
      return {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        paneId: session.paneId,
        isAlive: session.isAttachable,
        // Use isAttachable to prevent kill/attach races
        attachedClients: session.clientCount,
        pid: session.pid,
        createdAt: meta.createdAt,
        lastAttachedAt: meta.lastAttachedAt,
        shell: meta.shell
      };
    });
    return { sessions };
  }
  /**
   * Clear scrollback for a session.
   * Throws if session is not found or is terminating.
   */
  clearScrollback(request) {
    const session = this.getActiveSession(request.sessionId);
    session.clearScrollback();
    return { success: true };
  }
  /**
   * Detach a socket from all sessions it's attached to
   * Called when a client connection closes
   */
  detachFromAllSessions(socket) {
    for (const [sessionId, session] of this.sessions.entries()) {
      session.detach(socket);
      if (!session.isAlive && session.clientCount === 0) {
        void session.dispose();
        this.sessions.delete(sessionId);
      }
    }
  }
  async dispose() {
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    if (sessions.length === 0) return;
    await Promise.race([
      Promise.all(sessions.map((s) => s.dispose())),
      new Promise((resolve) => setTimeout(resolve, 5e3))
    ]);
  }
  /**
   * Get an active (attachable) session by ID.
   * Throws if session doesn't exist or is terminating.
   * Use this for mutating operations (write, resize, clearScrollback).
   */
  getActiveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.isAttachable) {
      throw new Error(`Session not attachable: ${sessionId}`);
    }
    return session;
  }
  /**
   * Handle session exit
   */
  handleSessionExit(sessionId, exitCode, signal) {
    this.clearKillTimer(sessionId);
    const session = this.sessions.get(sessionId);
    if (session?.clientCount === 0) {
      this.onUnattachedExit?.({ sessionId, exitCode, signal });
    }
    this.scheduleSessionCleanup(sessionId);
  }
  /**
   * Clear the kill timeout for a session
   */
  clearKillTimer(sessionId) {
    const timer = this.killTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(sessionId);
    }
  }
  /**
   * Schedule cleanup of a dead session
   * Reschedules if clients are still attached
   */
  scheduleSessionCleanup(sessionId) {
    setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session || session.isAlive) {
        return;
      }
      if (session.clientCount === 0) {
        void session.dispose();
        this.sessions.delete(sessionId);
      } else {
        this.scheduleSessionCleanup(sessionId);
      }
    }, 5e3);
  }
}
class Semaphore {
  constructor(max) {
    this.max = max;
  }
  inUse = 0;
  queue = [];
  acquire() {
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  release() {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.queue.shift();
    if (next) {
      this.inUse++;
      next(() => this.release());
    }
  }
}
const DAEMON_VERSION = "1.0.0";
const SUPERSET_HOME_DIR = path.join(os.homedir(), treeKill.SUPERSET_DIR_NAME);
const SOCKET_PATH = path.join(SUPERSET_HOME_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(SUPERSET_HOME_DIR, "terminal-host.token");
const PID_PATH = path.join(SUPERSET_HOME_DIR, "terminal-host.pid");
function log(level, message, data) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const prefix = `[${timestamp}] [terminal-host] [${level.toUpperCase()}]`;
  if (data !== void 0) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}
let authToken;
function ensureAuthToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token, { mode: 384 });
  log("info", "Generated new auth token");
  return token;
}
function validateToken(token) {
  return token === authToken;
}
class NdjsonParser {
  buffer = "";
  parse(chunk) {
    this.buffer += chunk;
    const messages = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          const maxLen = 100;
          const truncated = line.length > maxLen ? `${line.slice(0, maxLen)}... (truncated)` : line;
          const redacted = truncated.replace(
            /["']?(?:token|secret|password|key|auth)["']?\s*[:=]\s*["']?[^"'\s,}]+["']?/gi,
            "[REDACTED]"
          );
          log("warn", "Failed to parse NDJSON line", {
            preview: redacted,
            length: line.length
          });
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return messages;
  }
}
function sendResponse(socket, response) {
  socket.write(`${JSON.stringify(response)}
`);
}
function sendSuccess(socket, id, payload) {
  sendResponse(socket, { id, ok: true, payload });
}
function sendError(socket, id, code, message) {
  sendResponse(socket, { id, ok: false, error: { code, message } });
}
let terminalHost;
const clientsById = /* @__PURE__ */ new Map();
function isValidRole(role) {
  return role === "control" || role === "stream";
}
function broadcastEventToAllStreamSockets(event) {
  const message = `${JSON.stringify(event)}
`;
  for (const [clientId, sockets] of clientsById.entries()) {
    const streamSocket = sockets.stream;
    if (!streamSocket) continue;
    try {
      streamSocket.write(message);
    } catch {
      try {
        streamSocket.destroy();
      } catch {
      }
      const { control } = sockets;
      if (control) {
        clientsById.set(clientId, { control });
      } else {
        clientsById.delete(clientId);
      }
    }
  }
}
function getStreamSocketForClient(clientState) {
  const clientId = clientState.clientId;
  if (!clientId) return void 0;
  return clientsById.get(clientId)?.stream;
}
const handlers = {
  hello: (socket, id, payload, clientState) => {
    const request = payload;
    if (request.protocolVersion !== treeKill.PROTOCOL_VERSION) {
      sendError(
        socket,
        id,
        "PROTOCOL_MISMATCH",
        `Protocol version mismatch. Expected ${treeKill.PROTOCOL_VERSION}, got ${request.protocolVersion}`
      );
      return;
    }
    if (!validateToken(request.token)) {
      sendError(socket, id, "AUTH_FAILED", "Invalid auth token");
      return;
    }
    if (typeof request.clientId !== "string" || request.clientId.length === 0) {
      sendError(socket, id, "INVALID_HELLO", "Missing clientId");
      return;
    }
    if (!isValidRole(request.role)) {
      sendError(socket, id, "INVALID_HELLO", "Invalid role");
      return;
    }
    clientState.authenticated = true;
    clientState.clientId = request.clientId;
    clientState.role = request.role;
    const existing = clientsById.get(request.clientId) ?? {};
    const previousSocket = request.role === "control" ? existing.control : existing.stream;
    if (previousSocket && previousSocket !== socket) {
      try {
        terminalHost.detachFromAllSessions(previousSocket);
        previousSocket.destroy();
      } catch {
      }
    }
    const updated = request.role === "control" ? { ...existing, control: socket } : { ...existing, stream: socket };
    clientsById.set(request.clientId, updated);
    const response = {
      protocolVersion: treeKill.PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      daemonPid: process.pid
    };
    sendSuccess(socket, id, response);
    log("info", "Client authenticated successfully", {
      clientId: request.clientId,
      role: request.role
    });
  },
  createOrAttach: async (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "createOrAttach requires control");
      return;
    }
    const request = payload;
    log("info", `Creating/attaching session: ${request.sessionId}`);
    try {
      const streamSocket = getStreamSocketForClient(clientState);
      if (!streamSocket) {
        sendError(
          socket,
          id,
          "STREAM_NOT_CONNECTED",
          "Stream socket not connected"
        );
        return;
      }
      const response = await terminalHost.createOrAttach(streamSocket, request);
      sendSuccess(socket, id, response);
      log(
        "info",
        `Session ${request.sessionId} ${response.isNew ? "created" : "attached"}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendError(socket, id, "CREATE_ATTACH_FAILED", message);
      log("error", `Failed to create/attach session: ${message}`);
    }
  },
  write: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "write requires control");
      return;
    }
    const request = payload;
    const isNotify = id.startsWith("notify_");
    try {
      const response = terminalHost.write(request);
      if (!isNotify) {
        sendSuccess(socket, id, response);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Write failed";
      if (isNotify) {
        const streamSocket = getStreamSocketForClient(clientState);
        if (!streamSocket) {
          log("warn", "Notify write failed but no stream socket registered", {
            sessionId: request.sessionId,
            error: message
          });
          return;
        }
        const event = {
          type: "event",
          event: "error",
          sessionId: request.sessionId,
          payload: {
            type: "error",
            error: message,
            code: "WRITE_FAILED"
          }
        };
        streamSocket.write(`${JSON.stringify(event)}
`);
        log("warn", `Write failed for ${request.sessionId}`, {
          error: message
        });
        return;
      }
      sendError(socket, id, "WRITE_FAILED", message);
    }
  },
  resize: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "resize requires control");
      return;
    }
    const request = payload;
    const response = terminalHost.resize(request);
    sendSuccess(socket, id, response);
  },
  detach: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "detach requires control");
      return;
    }
    const request = payload;
    const streamSocket = getStreamSocketForClient(clientState);
    if (!streamSocket) {
      sendError(
        socket,
        id,
        "STREAM_NOT_CONNECTED",
        "Stream socket not connected"
      );
      return;
    }
    const response = terminalHost.detach(streamSocket, request);
    sendSuccess(socket, id, response);
  },
  kill: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "kill requires control");
      return;
    }
    const request = payload;
    const response = terminalHost.kill(request);
    sendSuccess(socket, id, response);
    log("info", `Session ${request.sessionId} killed`);
  },
  signal: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "signal requires control");
      return;
    }
    const request = payload;
    const response = terminalHost.signal(request);
    sendSuccess(socket, id, response);
  },
  killAll: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "killAll requires control");
      return;
    }
    const request = payload;
    const response = terminalHost.killAll(request);
    sendSuccess(socket, id, response);
    log("info", "All sessions killed");
  },
  listSessions: (socket, id, _payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "listSessions requires control");
      return;
    }
    const response = terminalHost.listSessions();
    sendSuccess(socket, id, response);
  },
  clearScrollback: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "clearScrollback requires control");
      return;
    }
    const request = payload;
    const response = terminalHost.clearScrollback(request);
    sendSuccess(socket, id, response);
  },
  shutdown: (socket, id, payload, clientState) => {
    if (!clientState.authenticated) {
      sendError(socket, id, "NOT_AUTHENTICATED", "Must authenticate first");
      return;
    }
    if (clientState.role !== "control") {
      sendError(socket, id, "INVALID_ROLE", "shutdown requires control");
      return;
    }
    const request = payload;
    log("info", "Shutdown requested via IPC", {
      killSessions: request.killSessions
    });
    sendSuccess(socket, id, { success: true });
    if (request.killSessions) {
      terminalHost.killAll({ deleteHistory: false });
    }
    setTimeout(() => {
      stopServer().then(() => process.exit(0));
    }, 100);
  }
};
async function handleRequest(socket, request, clientState) {
  const handler = handlers[request.type];
  if (!handler) {
    sendError(
      socket,
      request.id,
      "UNKNOWN_REQUEST",
      `Unknown request type: ${request.type}`
    );
    return;
  }
  try {
    await handler(socket, request.id, request.payload, clientState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(socket, request.id, "INTERNAL_ERROR", message);
    log("error", `Handler error for ${request.type}`, { error: message });
  }
}
let server = null;
function handleConnection(socket) {
  const parser = new NdjsonParser();
  const clientState = { authenticated: false };
  const remoteId = `${socket.remoteAddress || "local"}:${Date.now()}`;
  log("info", `Client connected: ${remoteId}`);
  socket.setEncoding("utf-8");
  socket.on("data", (data) => {
    const messages = parser.parse(data);
    for (const message of messages) {
      handleRequest(socket, message, clientState).catch((error) => {
        log("error", "Unhandled request error", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
  const handleDisconnect = () => {
    log("info", `Client disconnected: ${remoteId}`);
    terminalHost.detachFromAllSessions(socket);
    const { clientId, role } = clientState;
    if (clientId && role) {
      const entry = clientsById.get(clientId);
      if (entry) {
        const matches = role === "control" ? entry.control === socket : entry.stream === socket;
        if (matches) {
          const next = { ...entry };
          if (role === "control") {
            delete next.control;
          } else {
            delete next.stream;
          }
          if (!next.control && !next.stream) {
            clientsById.delete(clientId);
          } else {
            clientsById.set(clientId, next);
          }
        }
      }
    }
  };
  socket.on("close", handleDisconnect);
  socket.on("error", (error) => {
    log("error", `Socket error for ${remoteId}`, { error: error.message });
  });
}
function isSocketLive() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      resolve(false);
      return;
    }
    const testSocket = new net.Socket();
    const timeout = setTimeout(() => {
      testSocket.destroy();
      resolve(false);
    }, 1e3);
    testSocket.on("connect", () => {
      clearTimeout(timeout);
      testSocket.destroy();
      resolve(true);
    });
    testSocket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    testSocket.connect(SOCKET_PATH);
  });
}
async function startServer() {
  if (!fs.existsSync(SUPERSET_HOME_DIR)) {
    fs.mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 448 });
    log("info", `Created directory: ${SUPERSET_HOME_DIR}`);
  }
  try {
    fs.chmodSync(SUPERSET_HOME_DIR, 448);
  } catch {
  }
  if (fs.existsSync(SOCKET_PATH)) {
    const isLive = await isSocketLive();
    if (isLive) {
      log("error", "Another daemon is already running and responsive");
      throw new Error("Another daemon is already running");
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
      log("info", "Removed stale socket file");
    } catch (error) {
      throw new Error(`Failed to remove stale socket: ${error}`);
    }
  }
  if (fs.existsSync(PID_PATH)) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {
    }
  }
  authToken = ensureAuthToken();
  terminalHost = new TerminalHost({
    onUnattachedExit: ({ sessionId, exitCode, signal }) => {
      const event = {
        type: "event",
        event: "exit",
        sessionId,
        payload: {
          type: "exit",
          exitCode,
          signal
        }
      };
      broadcastEventToAllStreamSockets(event);
    }
  });
  const newServer = net.createServer(handleConnection);
  server = newServer;
  await new Promise((resolve, reject) => {
    newServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        log("error", "Socket already in use - another daemon may be running");
        reject(new Error("Socket already in use"));
      } else {
        log("error", "Server error", { error: error.message });
        reject(error);
      }
    });
    newServer.listen(SOCKET_PATH, () => {
      try {
        fs.chmodSync(SOCKET_PATH, 384);
      } catch {
      }
      fs.writeFileSync(PID_PATH, String(process.pid), { mode: 384 });
      log("info", `Daemon started`);
      log("info", `Socket: ${SOCKET_PATH}`);
      log("info", `PID: ${process.pid}`);
      resolve();
    });
  });
}
async function stopServer() {
  if (terminalHost) {
    await terminalHost.dispose();
    log("info", "Terminal host disposed");
  }
  await new Promise((resolve) => {
    if (server) {
      server.close(() => {
        log("info", "Server closed");
        resolve();
      });
    } else {
      resolve();
    }
  });
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch {
  }
}
function setupSignalHandlers() {
  setupTerminalHostSignalHandlers({
    log,
    stopServer
  });
}
async function main() {
  log("info", "Terminal Host Daemon starting...");
  log("info", `Environment: ${"production"}`);
  log("info", `Home directory: ${SUPERSET_HOME_DIR}`);
  setupSignalHandlers();
  try {
    await startServer();
  } catch (error) {
    log("error", "Failed to start server", { error });
    process.exit(1);
  }
}
main();
//# sourceMappingURL=terminal-host.js.map
