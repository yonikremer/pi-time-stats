/**
 * time-stats — per-block time + token stats for TUI transcript.
 *
 * P1 (this file): event capture + `/timestats [n]` + live widget.
 * Skipped: per-tool CustomMessage annotation (noisy); add when batch
 * summary per turn proves wanted (spec §3a opt-in).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

type CallRecord = {
  toolCallId: string;
  toolName: string;
  preview: string;
  startedAt: number;
  ms?: number;
  isError?: boolean;
  outChars?: number;
  nested: boolean;
};

const CAP = 2000;
const calls = new Map<string, CallRecord>();
const order: string[] = [];
let lastCtx: ExtensionContext | undefined;

let lastCall: CallRecord | undefined;
let sessionToolsMs = 0;
let assistantTokens = 0;
let toolTokens = 0;
let nestedCount = 0;

const CALL_TYPE = "time-stats-call";
const USAGE_TYPE = "time-stats-usage";
let hydratedFor: string | undefined;
let saver: ((customType: string, data?: unknown) => void) | undefined;

function save(customType: string, data: unknown): void {
  try {
    saver?.(customType, data);
  } catch {
    /* never break tool flow */
  }
}

function sessionFileOf(ctx?: ExtensionContext): string | undefined {
  try {
    return (ctx?.sessionManager as any)?.getSessionFile?.();
  } catch {
    return undefined;
  }
}

export function ensureHydrated(ctx?: ExtensionContext): void {
  const f = sessionFileOf(ctx);
  if (f != null && hydratedFor === f) return;
  reset(ctx);
  hydratedFor = f;
  try {
    const entries = (ctx?.sessionManager as any)?.getEntries?.() ?? [];
    for (const e of entries) {
      if (!e || e.type !== "custom" || !e.data) continue;
      if (e.customType === CALL_TYPE) {
        const d = e.data as any;
        if (d.toolCallId == null) continue;
        const rec: CallRecord = {
          toolCallId: String(d.toolCallId),
          toolName: String(d.toolName ?? "?"),
          preview: String(d.preview ?? ""),
          startedAt: 0,
          ms: typeof d.ms === "number" ? d.ms : undefined,
          isError: !!d.isError,
          outChars: typeof d.outChars === "number" ? d.outChars : undefined,
          nested: !!d.nested,
        };
        if (calls.has(rec.toolCallId)) Object.assign(calls.get(rec.toolCallId)!, rec);
        else {
          push(rec);
          if (rec.nested) nestedCount++;
        }
        if (rec.ms != null && !rec.nested) {
          sessionToolsMs += rec.ms;
          lastCall = rec;
        }
      } else if (e.customType === USAGE_TYPE) {
        const d = e.data as any;
        if (typeof d?.assistant === "number") assistantTokens += d.assistant;
        if (typeof d?.tools === "number") toolTokens += d.tools;
      }
    }
  } catch {
    /* entries unreadable: stay empty */
  }
  if (ctx) refreshWidget(ctx);
}

function reset(ctx?: ExtensionContext) {
  calls.clear();
  order.length = 0;
  lastCall = undefined;
  sessionToolsMs = 0;
  assistantTokens = 0;
  toolTokens = 0;
  nestedCount = 0;
  const c = ctx ?? lastCtx;
  if (c && c.mode === "tui") {
    try {
      c.ui.setWidget("time-stats", undefined);
    } catch {
      /* widget may be gone during switch */
    }
  }
}

function push(rec: CallRecord) {
  calls.set(rec.toolCallId, rec);
  order.push(rec.toolCallId);
  if (order.length > CAP) {
    const old = order.shift()!;
    if (!calls.get(old)?.ms) calls.delete(old);
    else {
      // drop oldest completed too; Map delete keeps cap bounded
      calls.delete(old);
    }
  }
}

function previewOf(toolName: string, args: any): string {
  try {
    if (!args || typeof args !== "object") return "";
    const s = (v: unknown, n = 60) =>
      typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, n) : "";
    if (toolName === "bash" || toolName === "powershell")
      return s((args as any).command) || s((args as any).cmd);
    if (toolName === "edit" || toolName === "write" || toolName === "read")
      return s((args as any).path);
    if (toolName === "grep") return s((args as any).pattern);
    if (toolName === "find" || toolName === "ls")
      return s((args as any).path) || s((args as any).pattern);
    return JSON.stringify(args).replace(/\s+/g, " ").slice(0, 60);
  } catch {
    return "";
  }
}

function outCharsOf(result: any): number | undefined {
  try {
    if (result == null) return 0;
    if (typeof result === "string") return result.length;
    if (typeof result.content === "string") return result.content.length;
    if (Array.isArray(result.content))
      return result.content
        .map((p: any) => (typeof p?.text === "string" ? p.text.length : 0))
        .reduce((a: number, b: number) => a + b, 0);
    const j = JSON.stringify(result);
    return j ? j.length : undefined;
  } catch {
    return undefined;
  }
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 120) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const totalS = Math.round(s);
  const m = Math.floor(totalS / 60);
  return `${m}m${totalS % 60}s`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

function widgetLine(): string {
  const last = lastCall
    ? `last: ${lastCall.toolName.slice(0, 18)} ${fmtMs(lastCall.ms ?? 0)}`
    : "last: —";
  const line =
    `${last} | session tools ${fmtMs(sessionToolsMs)}` +
    ` | tokens ~${fmtTokens(assistantTokens + toolTokens)}`;
  return line.slice(0, 100);
}

function refreshWidget(ctx: ExtensionContext) {
  lastCtx = ctx;
  if (ctx.mode !== "tui") return;
  try {
    ctx.ui.setWidget("time-stats", [widgetLine()], {
      placement: "aboveEditor",
    });
  } catch {
    /* widget host may be unavailable in tests */
  }
}

export function topRows(n: number): CallRecord[] {
  return [...calls.values()]
    .filter((r) => r.ms != null && !r.nested)
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
    .slice(0, Math.max(1, n));
}

export function timeColWidth(rows: CallRecord[]): number {
  return Math.max(4, ...rows.map((r) => fmtMs(r.ms ?? 0).length));
}

export function truncateVis(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (visibleWidth(out + ch + "\u2026") > max) break;
    out += ch;
  }
  return out + "\u2026";
}

export function rowLabel(r: CallRecord): string {
  return r.preview ? `${r.toolName} "${r.preview}"` : r.toolName;
}

export function formatRow(r: CallRecord, timeW: number, maxWidth: number): string {
  const t = fmtMs(r.ms ?? 0).padEnd(timeW);
  const flag = r.isError ? " [error]" : "";
  const label = truncateVis(rowLabel(r) + flag, Math.max(10, maxWidth - timeW - 2));
  return `${t}  ${label}`;
}

export function formatTable(rows: CallRecord[], maxWidth = 120): string {
  if (!rows.length) return "No tool calls recorded yet.";
  const timeW = timeColWidth(rows);
  const lines = rows.map((r) => formatRow(r, timeW, maxWidth));
  const extra = nestedCount ? `\n(+${nestedCount} nested excluded)` : "";
  return `Slowest ${rows.length} tool call(s), one row per call:\n` +
    lines.join("\n") + extra;
}

export function detailLines(r: CallRecord, maxWidth: number): string[] {
  const out = r.outChars != null ? ` ~${fmtTokens(r.outChars)} out` : "";
  return [
    `full: ${rowLabel(r)}`,
    `took: ${fmtMs(r.ms ?? 0)} (${Math.round(r.ms ?? 0)}ms)${out}  ${r.isError ? "error" : "ok"}`,
  ].map((l) => "    " + truncateVis(l, Math.max(10, maxWidth - 4)));
}

export class StatsOverlay implements Component {
  private selected = 0;
  private expanded = new Set<number>();
  constructor(
    private rows: CallRecord[],
    private done: (result: undefined) => void,
  ) {}
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    } else if (matchesKey(data, "return") || data === " ") {
      if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
      else this.expanded.add(this.selected);
    }
  }
  invalidate(): void {}
  render(width: number): string[] {
    const w = Math.max(20, width);
    const lines = [`Slowest ${this.rows.length} tool call(s):`];
    if (!this.rows.length) lines.push("No tool calls recorded yet.");
    const timeW = timeColWidth(this.rows);
    this.rows.forEach((r, i) => {
      const mark = i === this.selected ? "\u203a" : " ";
      lines.push(mark + " " + truncateVis(formatRow(r, timeW, w - 2), w - 2));
      if (this.expanded.has(i)) lines.push(...detailLines(r, w));
    });
    if (nestedCount) lines.push(`(+${nestedCount} nested excluded)`);
    lines.push("\u2191\u2193 move \u00b7 Enter expand \u00b7 q close");
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  saver = (t, d) => pi.appendEntry(t, d);
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    hydratedFor = undefined;
    ensureHydrated(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    lastCtx = ctx;
    ensureHydrated(ctx);
    const nested = event.toolCallId.includes("/");
    const rec: CallRecord = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      preview: previewOf(event.toolName, (event as any).args),
      startedAt: performance.now(),
      nested,
    };
    if (nested) nestedCount++;
    push(rec);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    ensureHydrated(ctx);
    const rec = calls.get(event.toolCallId);
    const ms = rec ? performance.now() - rec.startedAt : 0;
    const out = outCharsOf((event as any).result);
    if (rec) {
      rec.ms = Math.max(0, ms);
      rec.isError = event.isError;
      if (out != null) rec.outChars = out;
      if (!rec.nested) {
        lastCall = rec;
        sessionToolsMs += rec.ms;
      }
    } else {
      const fallback: CallRecord = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        preview: "",
        startedAt: performance.now() - ms,
        ms: Math.max(0, ms),
        isError: event.isError,
        outChars: out,
        nested: event.toolCallId.includes("/"),
      };
      push(fallback);
      if (!fallback.nested) {
        lastCall = fallback;
        sessionToolsMs += fallback.ms ?? 0;
      }
    }
    const done = calls.get(event.toolCallId);
    if (done?.ms != null) {
      save(CALL_TYPE, {
        toolCallId: done.toolCallId,
        toolName: done.toolName,
        preview: done.preview,
        ms: done.ms,
        isError: !!done.isError,
        outChars: done.outChars,
        nested: done.nested,
      });
    }
    refreshWidget(ctx);
  });

  // Tool-result tokens + accurate output chars (assistant usage handled below).
  pi.on("tool_result", (event, ctx) => {
    ensureHydrated(ctx);
    const rec = calls.get(event.toolCallId);
    try {
      const chars = Array.isArray(event.content)
        ? event.content
          .map((p: any) => (typeof p?.text === "string" ? p.text.length : 0))
          .reduce((a: number, b: number) => a + b, 0)
        : 0;
      if (rec && chars) rec.outChars = chars;
      const u = (event as any).usage;
      if (u && typeof u.totalTokens === "number") {
        toolTokens += u.totalTokens;
        save(USAGE_TYPE, { tools: u.totalTokens });
      }
    } catch {
      /* never break tool flow */
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    ensureHydrated(ctx);
    try {
      const m = event.message as any;
      if (m?.role === "assistant" && m?.usage) {
        const u = m.usage;
        if (typeof u.totalTokens === "number") {
          assistantTokens += u.totalTokens;
          save(USAGE_TYPE, { assistant: u.totalTokens });
        } else if (typeof u.input === "number" || typeof u.output === "number") {
          const sum = (u.input ?? 0) + (u.output ?? 0);
          assistantTokens += sum;
          save(USAGE_TYPE, { assistant: sum });
        }
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  const rollup = (_e: unknown, ctx: ExtensionContext) => {
    ensureHydrated(ctx);
    refreshWidget(ctx);
  };
  pi.on("turn_end", rollup as any);
  pi.on("agent_settled", rollup as any);

  pi.registerCommand("timestats", {
    description: "Slowest tool calls this session (usage: /timestats [n])",
    handler: async (args, ctx) => {
      const n = parseInt(args.trim(), 10);
      ensureHydrated(ctx);
      const rows = topRows(Number.isInteger(n) && n > 0 ? n : 10);
      if (ctx.mode === "tui" && ctx.hasUI) {
        try {
          await ctx.ui.custom(
            (_tui, _theme, _kb, done) => new StatsOverlay(rows, done),
            { overlay: true },
          );
          return;
        } catch {
          /* fall through to text fallback */
        }
      }
      const out = formatTable(rows);
      if (ctx.mode === "tui" && ctx.hasUI) {
        try {
          await ctx.ui.editor("Time stats", out);
          return;
        } catch {
          /* fall through to notify */
        }
      }
      ctx.ui.notify(out, "info");
    },
  });
}
