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

function table(n: number): string {
  const rows = [...calls.values()]
    .filter((r) => r.ms != null && !r.nested)
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
    .slice(0, Math.max(1, n));
  if (!rows.length) return "No tool calls recorded yet.";
  const lines = rows.map((r) => {
    const what = r.preview ? `${r.toolName} "${r.preview}"` : r.toolName;
    const out =
      r.outChars != null ? ` ~${fmtTokens(r.outChars)} out` : "";
    return `${what}  ${fmtMs(r.ms ?? 0)}${out}  ${r.isError ? "error" : "ok"}`;
  });
  const extra = nestedCount ? `\n(+${nestedCount} nested excluded)` : "";
  return `Slowest ${rows.length} tool call(s), one row per call:\n` +
    lines.join("\n") + extra;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    reset(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    lastCtx = ctx;
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
    refreshWidget(ctx);
  });

  // Tool-result tokens + accurate output chars (assistant usage handled below).
  pi.on("tool_result", (event) => {
    const rec = calls.get(event.toolCallId);
    try {
      const chars = Array.isArray(event.content)
        ? event.content
          .map((p: any) => (typeof p?.text === "string" ? p.text.length : 0))
          .reduce((a: number, b: number) => a + b, 0)
        : 0;
      if (rec && chars) rec.outChars = chars;
      const u = (event as any).usage;
      if (u && typeof u.totalTokens === "number") toolTokens += u.totalTokens;
    } catch {
      /* never break tool flow */
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    try {
      const m = event.message as any;
      if (m?.role === "assistant" && m?.usage) {
        const u = m.usage;
        if (typeof u.totalTokens === "number") assistantTokens += u.totalTokens;
        else if (typeof u.input === "number" || typeof u.output === "number")
          assistantTokens += (u.input ?? 0) + (u.output ?? 0);
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  const rollup = (_e: unknown, ctx: ExtensionContext) => refreshWidget(ctx);
  pi.on("turn_end", rollup as any);
  pi.on("agent_settled", rollup as any);

  pi.registerCommand("timestats", {
    description: "Slowest tool calls this session (usage: /timestats [n])",
    handler: async (args, ctx) => {
      const n = parseInt(args.trim(), 10);
      const out = table(Number.isInteger(n) && n > 0 ? n : 10);
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
