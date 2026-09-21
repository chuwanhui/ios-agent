import { fetch } from "scripting"
import { McpServer } from "./agent_store"

/**
 * 极简 MCP 客户端：JSON-RPC 2.0 over Streamable HTTP。
 *
 * 为什么只做 HTTP：沙箱里没有「常驻子进程 + stdin/stdout 管道」，
 * 所以 `npx @modelcontextprotocol/server-xxx` 这类 stdio 型服务器接不了，
 * 只能连远程 / 自托管的 HTTP 端点（规范里的 Streamable HTTP 传输）。
 *
 * 流程：initialize → notifications/initialized → tools/list → tools/call。
 * 服务器可能在响应头里下发 `mcp-session-id`，之后每个请求都要带上。
 * 响应体可能是 application/json，也可能是一段 SSE（`data: {...}`），两种都解析。
 */

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "scripting-agent", title: "Scripting 智能体", version: "1.0.0" }
const REQUEST_TIMEOUT_MS = 20000
const TOOL_CACHE_MS = 5 * 60 * 1000
/** 连接失败也要缓存一会儿，否则服务器一旦挂掉，每条消息都要干等一次超时。 */
const FAIL_CACHE_MS = 60 * 1000
const MAX_PAGES = 5
const MAX_TOOLS_PER_SERVER = 60
const MAX_RESULT_CHARS = 8000

export interface McpTool {
  serverId: string
  serverName: string
  /** 服务器上的原始工具名 */
  name: string
  description: string
  inputSchema: Record<string, any>
}

export interface McpToolList {
  serverId: string
  serverName: string
  tools: McpTool[]
  /** 连接或解析失败时的文案（tools 会是空数组）。 */
  error?: string
}

export interface McpCallResult {
  ok: boolean
  text: string
}

type SessionState = { sessionId: string | null; ready: boolean }

/** 内存里的会话状态 / 工具清单缓存（脚本重启即失效，够用）。 */
const sessions = new Map<string, SessionState>()
const toolCache = new Map<string, { tools: McpTool[]; at: number }>()
const failCache = new Map<string, { error: string; at: number }>()

// ———————————————————————— 小工具 ————————————————————————

function msgOf(e: any): string {
  return e?.message ?? String(e)
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`))
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 解析「额外请求头」文本：每行一个 `Header: Value`。 */
export function parseHeaderLines(hint?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (hint ?? "").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf(":")
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 从一段可能含 SSE 的响应体里解析出所有 JSON-RPC 报文（导出以便测试）。 */
export function parseRpcMessages(body: string): any[] {
  const t = (body ?? "").trim()
  if (!t) return []

  // 普通 JSON：单条报文，或一批
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t)
      return Array.isArray(j) ? j : [j]
    } catch {
      // 掉下去当 SSE 再试一次
    }
  }

  // SSE：帧之间用空行分隔，`data:` 可以有多行
  const out: any[] = []
  for (const block of t.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
    if (dataLines.length === 0) continue
    const payload = dataLines.join("\n").trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const j = JSON.parse(payload)
      if (Array.isArray(j)) out.push(...j)
      else out.push(j)
    } catch {
      // 忽略解析不了的那一帧
    }
  }
  return out
}

/** 在一段响应体里挑出 id 匹配的那条回复（导出以便测试）。 */
export function pickRpcResponse(body: string, id: string): any | null {
  const msgs = parseRpcMessages(body)
  const byId = msgs.find((m) => m && String(m.id) === String(id))
  if (byId) return byId
  return msgs.find((m) => m && (m.result !== undefined || m.error !== undefined)) ?? null
}

/** 把 tools/call 的结果转成纯文本给模型看（导出以便测试）。 */
export function formatToolResult(res: any): string {
  if (res == null) return "（服务器没有返回内容）"
  const parts: string[] = []
  if (Array.isArray(res.content)) {
    for (const c of res.content) {
      if (!c) continue
      if (c.type === "text") parts.push(String(c.text ?? ""))
      else if (c.type === "image") parts.push("[图片]")
      else if (c.type === "audio") parts.push("[音频]")
      else if (c.type === "resource") parts.push(`[资源 ${c.resource?.uri ?? ""}]`)
      else if (c.type === "resource_link") parts.push(`[资源 ${c.uri ?? ""}]`)
      else parts.push(`[${String(c.type ?? "未知内容")}]`)
    }
  }
  if (res.structuredContent && typeof res.structuredContent === "object") {
    try {
      parts.push(JSON.stringify(res.structuredContent))
    } catch {
      // 忽略
    }
  }
  let text = parts.join("\n").trim()
  if (!text) text = "（空结果）"
  text = clip(text, MAX_RESULT_CHARS)
  return res.isError ? "工具报错：" + text : text
}

// ———————————————————————— 请求 ————————————————————————

function keyOf(s: McpServer): string {
  return `${s.id}|${(s.url ?? "").trim()}|${s.token ?? ""}`
}

function resetSession(s: McpServer): void {
  sessions.delete(keyOf(s))
}

function headerOf(resp: any, name: string): string | null {
  try {
    const v = resp?.headers?.get?.(name)
    return v == null ? null : String(v)
  } catch {
    return null
  }
}

function buildHeaders(s: McpServer): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    ...parseHeaderLines(s.headersHint),
  }
  const token = (s.token ?? "").trim()
  if (token) h["Authorization"] = "Bearer " + token
  const sess = sessions.get(keyOf(s))
  if (sess?.sessionId) h["Mcp-Session-Id"] = sess.sessionId
  return h
}

let rpcSeq = 0
function nextRpcId(): string {
  rpcSeq += 1
  return "sr" + rpcSeq
}

/**
 * 发一条 JSON-RPC 报文。
 * `expectReply = false` 用于通知（notifications/*），服务器一般回 202 空响应。
 */
async function postRpc(s: McpServer, payload: Record<string, any>, expectReply: boolean): Promise<any> {
  const url = (s.url ?? "").trim()
  if (!url) throw new Error("服务器地址为空")

  const resp: any = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: buildHeaders(s),
      body: JSON.stringify(payload),
    }),
    REQUEST_TIMEOUT_MS,
    "连接 MCP 服务器",
  )

  // 服务器用响应头下发会话 id（initialize 之后必须带上）
  const sid = headerOf(resp, "mcp-session-id")
  if (sid) {
    const st = sessions.get(keyOf(s))
    sessions.set(keyOf(s), { sessionId: sid, ready: st?.ready ?? false })
  }

  if (!expectReply) return null
  if (resp.status === 202 || resp.status === 204) return null

  if (!resp.ok) {
    let detail = ""
    try {
      detail = clip(String(await resp.text()).trim(), 300)
    } catch {
      // 忽略
    }
    const hint =
      resp.status === 401 || resp.status === 403
        ? "（鉴权失败：检查令牌 / 请求头）"
        : resp.status === 404
          ? "（地址可能不对：MCP 端点通常是 …/mcp 或 …/sse）"
          : ""
    throw new Error(`HTTP ${resp.status}${hint}${detail ? "：" + detail : ""}`)
  }

  const body = await withTimeout(resp.text(), REQUEST_TIMEOUT_MS, "读取 MCP 响应")
  const text = String(body ?? "")
  if (!text.trim()) return null

  const msg = pickRpcResponse(text, String(payload.id ?? ""))
  if (!msg) throw new Error("无法解析响应：" + clip(text.trim(), 300))

  if (msg.error) {
    const e = msg.error
    throw new Error(`${e?.code ?? ""} ${e?.message ?? "服务器返回错误"}`.trim())
  }
  return msg.result ?? null
}

/** 确保这个服务器已经初始化过（initialize + initialized 通知）。 */
async function ensureSession(s: McpServer): Promise<void> {
  const key = keyOf(s)
  if (sessions.get(key)?.ready) return

  await postRpc(
    s,
    {
      jsonrpc: "2.0",
      id: nextRpcId(),
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
    true,
  )

  const st = sessions.get(key)
  sessions.set(key, { sessionId: st?.sessionId ?? null, ready: true })

  // 规范要求补一条 initialized 通知；部分服务器不接受通知，失败无所谓
  try {
    await postRpc(s, { jsonrpc: "2.0", method: "notifications/initialized" }, false)
  } catch {
    // 忽略
  }
}

// ———————————————————————— 对外接口 ————————————————————————

/** 拉取某个服务器的工具清单（带 5 分钟缓存）。失败不抛异常，返回 error。 */
export async function listMcpTools(s: McpServer, force = false): Promise<McpToolList> {
  const key = keyOf(s)
  const cached = toolCache.get(key)
  if (!force && cached && Date.now() - cached.at < TOOL_CACHE_MS) {
    return { serverId: s.id, serverName: s.name, tools: cached.tools }
  }
  const failed = failCache.get(key)
  if (!force && failed && Date.now() - failed.at < FAIL_CACHE_MS) {
    return { serverId: s.id, serverName: s.name, tools: [], error: failed.error }
  }

  try {
    await ensureSession(s)
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, any> = {}
      if (cursor) params.cursor = cursor
      const res = await postRpc(
        s,
        { jsonrpc: "2.0", id: nextRpcId(), method: "tools/list", params },
        true,
      )
      const raw: any[] = Array.isArray(res?.tools) ? res.tools : []
      for (const t of raw) {
        if (!t?.name) continue
        tools.push({
          serverId: s.id,
          serverName: s.name,
          name: String(t.name),
          description: String(t.description ?? t.title ?? "").trim(),
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })
        if (tools.length >= MAX_TOOLS_PER_SERVER) break
      }
      cursor = res?.nextCursor ? String(res.nextCursor) : undefined
      if (!cursor || tools.length >= MAX_TOOLS_PER_SERVER) break
    }
    toolCache.set(key, { tools, at: Date.now() })
    failCache.delete(key)
    return { serverId: s.id, serverName: s.name, tools }
  } catch (e: any) {
    resetSession(s)
    const error = msgOf(e)
    failCache.set(key, { error, at: Date.now() })
    return { serverId: s.id, serverName: s.name, tools: [], error }
  }
}

/** 调用一个 MCP 工具，返回真正的内容（这就是比快捷指令强的地方）。 */
export async function callMcpTool(
  s: McpServer,
  toolName: string,
  args: Record<string, any>,
): Promise<McpCallResult> {
  try {
    await ensureSession(s)
    const res = await postRpc(
      s,
      {
        jsonrpc: "2.0",
        id: nextRpcId(),
        method: "tools/call",
        params: { name: toolName, arguments: args ?? {} },
      },
      true,
    )
    if (res == null) return { ok: false, text: `调用「${toolName}」失败：服务器没有返回结果` }
    return { ok: !res.isError, text: formatToolResult(res) }
  } catch (e: any) {
    resetSession(s)
    return { ok: false, text: `调用 MCP 工具「${toolName}」失败：${msgOf(e)}` }
  }
}

/** 批量拉取（只处理启用了且填了地址的服务器）。 */
export async function collectMcpTools(
  servers: McpServer[] | undefined,
  force = false,
): Promise<McpToolList[]> {
  const out: McpToolList[] = []
  for (const s of servers ?? []) {
    if (!s?.enabled || !(s.url ?? "").trim()) continue
    out.push(await listMcpTools(s, force))
  }
  return out
}

/** 把工具清单拼成给模型看的一句话，用于拿工具之前快速判断连没连上。 */
export function mcpSummary(lists: McpToolList[]): string {
  if (lists.length === 0) return ""
  return lists
    .map((l) =>
      l.error
        ? `${l.serverName || l.serverId}：连接失败（${l.error}）`
        : `${l.serverName || l.serverId}：${l.tools.length} 个工具`,
    )
    .join("\n")
}
