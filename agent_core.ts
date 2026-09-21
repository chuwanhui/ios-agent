import { fetch } from "scripting"
import {
  AgentConfig, AgentTool, ChatMessage, McpServer, TokenUsage, ToolStep, toolDescription, toolParameters,
} from "./agent_store"
import { McpTool, callMcpTool, collectMcpTools } from "./mcp_client"
import { formatKbHits, kbStats, searchKbHybrid } from "./kb_store"
import { embedQueryVector, kbSemanticReady } from "./kb_embed"
import { listSkills, readSkill, skillsPrompt } from "./skills_store"
import { addPending } from "./tool_callback"

type LLMMessage = {
  role: string
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function endpoint(cfg: AgentConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "")
  const path = (cfg.apiPath || "/chat/completions").replace(/^\/+/, "")
  return base + "/" + path
}

async function callDeepSeek(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
): Promise<any> {
  const resp = await postChat(cfg, buildBody(messages, cfg, toolsSpec, false))
  return await resp.json()
}

/** 请求体（流式 / 非流式共用）。 */
function buildBody(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
  stream: boolean,
): Record<string, any> {
  const body: Record<string, any> = {
    model: cfg.model,
    messages,
    stream,
  }
  // 让服务端在最后一帧带上 usage（OpenAI 兼容协议）；不认这个字段的服务端会被上层退回非流式。
  if (stream) body.stream_options = { include_usage: true }
  if (cfg.thinkingEnabled) body.thinking = { type: "enabled" }
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort
  if (toolsSpec && toolsSpec.length > 0) body.tools = toolsSpec
  return body
}

/**
 * 发一次 POST。HTTP 层出错时给 error 挂上 `httpStatus`：
 * 上层据此区分「接口本身报错」（直接抛给用户）和「这个服务端不支持流式」（退回一次性请求）。
 */
async function postChat(cfg: AgentConfig, body: Record<string, any>): Promise<any> {
  const resp = await fetch(endpoint(cfg), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    const err: any = new Error(`接口错误 ${resp.status}：${text.slice(0, 300)}`)
    err.httpStatus = resp.status
    throw err
  }
  return resp
}

/** 流式增量：正文与推理分开推给 UI（打字机效果）。 */
export type AgentDelta = {
  type: "text" | "reasoning"
  content: string
  /** 推理的新段落：多轮工具调用时每轮一段，UI 用它决定要不要插空行。 */
  newSegment?: boolean
  /** 丢弃已经画出来的内容（流式中途失败、退回一次性请求时用）。 */
  reset?: boolean
}

type StreamOutcome = {
  message: any
  /** 本轮拼起来的推理全文。 */
  reasoning: string
  usage?: TokenUsage
}

/** 把各家不同的 usage 字段归一化。 */
function readUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0)
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0)
  if (!input && !output) return undefined
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: Number(raw.total_tokens ?? input + output),
  }
  const think = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0)
  if (think > 0) usage.reasoningTokens = think
  const cached = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0)
  if (cached > 0) usage.cachedInputTokens = cached
  return usage
}

/** 逐行取 SSE 的 `data:` 负载（忽略别的行和 [DONE]）。 */
function eachSsePayload(frame: string, fn: (payload: string) => void) {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const payload = trimmed.slice(5).trim()
    if (payload && payload !== "[DONE]") fn(payload)
  }
}

/**
 * 流式请求：边收边把增量回调出去，最后把分片拼回一条完整的 message。
 * 工具调用是分片下发的（id / name / arguments 拆在不同帧里），按 `index` 拼装。
 */
async function callDeepSeekStream(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
  onDelta?: (d: AgentDelta) => void,
): Promise<StreamOutcome> {
  const resp = await postChat(cfg, buildBody(messages, cfg, toolsSpec, true))

  const content: string[] = []
  const calls: any[] = []
  const reasonings: string[] = []
  let usage: TokenUsage | undefined

  const consumeJson = (payload: string) => {
    let j: any = null
    try {
      j = JSON.parse(payload)
    } catch {
      return // 半截帧，忽略
    }
    if (!j || typeof j !== "object") return
    const u = readUsage(j.usage)
    if (u) usage = u
    const choice = j.choices?.[0]
    const delta = choice?.delta ?? choice?.message
    if (!delta) return

    // DeepSeek 思考模式：reasoning_content；有的兼容实现叫 reasoning。
    const think =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : ""
    if (think) {
      reasonings.push(think)
      onDelta?.({ type: "reasoning", content: think })
    }

    if (typeof delta.content === "string" && delta.content) {
      content.push(delta.content)
      onDelta?.({ type: "text", content: delta.content })
    }

    for (const tc of delta.tool_calls ?? []) {
      const index = typeof tc?.index === "number" ? tc.index : 0
      while (calls.length <= index) {
        calls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
      }
      const slot = calls[index]
      if (tc.id) slot.id = tc.id
      if (tc.type) slot.type = tc.type
      if (tc.function?.name) slot.function.name += tc.function.name
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
    }
  }

  const reader: any = (resp.body as any)?.getReader?.()
  if (reader) {
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (!chunk || chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let cut = buffer.indexOf("\n\n")
      while (cut >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        eachSsePayload(frame, consumeJson)
        cut = buffer.indexOf("\n\n")
      }
    }
    // 收尾：把解码器里残留的半个多字节字符和最后一段没带空行的帧吐出来
    buffer += decoder.decode()
    eachSsePayload(buffer, consumeJson)
  } else {
    // 服务端没给流式响应体：整段文本可能仍是 SSE，也可能就是一段 JSON。
    const raw = await resp.text()
    if (raw.indexOf("data:") >= 0) {
      for (const frame of raw.split("\n\n")) eachSsePayload(frame, consumeJson)
    } else {
      consumeJson(raw)
    }
  }

  const message: any = { role: "assistant", content: content.join("") }
  const toolCalls = calls.filter((c) => c.function.name || c.function.arguments)
  if (toolCalls.length > 0) {
    for (const c of toolCalls) {
      if (!c.id) c.id = "call_" + Math.random().toString(36).slice(2, 10)
    }
    message.tool_calls = toolCalls
  }
  return { message, reasoning: reasonings.join(""), usage }
}

function buildMessages(
  cfg: AgentConfig,
  history: ChatMessage[],
  userText: string,
): LLMMessage[] {
  const msgs: LLMMessage[] = []
  const sys: string[] = []
  if (cfg.systemPrompt) sys.push(cfg.systemPrompt)
  if (cfg.skillsEnabled) {
    const sp = skillsPrompt(cfg.onlySkillIds)
    if (sp) sys.push(sp)
  }
  if (sys.length > 0) {
    msgs.push({ role: "system", content: sys.join("\n\n") })
  }
  for (const m of history) {
    // hidden 的消息（工具回传）照常发给模型，只是聊天界面不显示
    msgs.push({ role: m.role, content: m.content })
  }
  msgs.push({ role: "user", content: userText })
  return msgs
}

/** 工具调用时抛给 UI 的事件（用于在灵动岛 / 语音页显示进度）。 */
export type AgentEvent = {
  type: "tool"
  /** 快捷指令工具、MCP 工具，还是内置的知识库 / 技能工具。 */
  kind: "shortcut" | "mcp" | "kb" | "skill"
  /** 模型看到的函数名。 */
  name: string
  /** 执行目标：快捷指令名，或「服务器 · 工具」。 */
  target: string
  argsText: string
}

/** 工具类别在界面上的统一叫法（聊天页过程面板、设置页说明共用一处）。 */
export const TOOL_KIND_LABEL: Record<ToolStep["kind"], string> = {
  shortcut: "本地快捷指令工具",
  mcp: "MCP 工具",
  kb: "本地知识库",
  skill: "技能",
  other: "未知工具",
}

export function toolKindLabel(kind: ToolStep["kind"]): string {
  return TOOL_KIND_LABEL[kind] ?? "工具"
}

/** runAgent 的回调钩子；聊天页用它把 AI 的过程实时画出来。 */
export type RunAgentHooks = {
  /** 即将调用某个工具（灵动岛 / 语音页拿它写进度文案）。 */
  onEvent?: (e: AgentEvent) => void
  /** 一次工具调用结束，带完整记录（参数 / 结果 / 成败 / 耗时）。 */
  onStep?: (s: ToolStep) => void
  /** 模型吐出的整段推理（每轮一次；流式下用 onDelta 更好，别两个都接）。 */
  onReasoning?: (text: string) => void
  /** 流式增量：正文与推理边生成边回调（打字机效果）。 */
  onDelta?: (d: AgentDelta) => void
}

/** 兼容旧写法：第 4 个参数也可以直接传一个 onEvent 回调。 */
export type HooksArg = RunAgentHooks | ((e: AgentEvent) => void) | undefined

function normalizeHooks(arg: HooksArg): RunAgentHooks {
  if (!arg) return {}
  if (typeof arg === "function") return { onEvent: arg }
  return arg
}

/** 存进历史前先截断，免得 sessions.json 被推理文本和长文档撑爆。 */
const ARGS_CLIP = 300
const RESULT_CLIP = 800
const REASONING_CLIP = 1600

function clip(text: string, max: number): string {
  const s = text ?? ""
  if (s.length <= max) return s
  return s.slice(0, max) + `…（已截断，共 ${s.length} 字）`
}

function makeStep(
  kind: ToolStep["kind"],
  name: string,
  target: string,
  argsText: string,
  rawResult: string,
  ok: boolean,
  ms: number,
): ToolStep {
  return {
    kind,
    name,
    target,
    args: clip(argsText, ARGS_CLIP),
    result: clip(rawResult, RESULT_CLIP),
    ok,
    ms,
  }
}

/** 模型看到的函数名 → 实际执行目标。 */
type ToolRoute =
  | { kind: "shortcut"; tool: AgentTool }
  | { kind: "mcp"; server: McpServer; tool: McpTool }
  | { kind: "kb" }
  | { kind: "skill" }

const FUNC_NAME_BAD = /[^A-Za-z0-9_-]/g

function sanitizeFuncName(s: string, max: number): string {
  const cleaned = (s ?? "").replace(FUNC_NAME_BAD, "_").replace(/^_+/, "")
  return (cleaned || "x").slice(0, max)
}

/** MCP 工具在模型眼里的函数名（带服务器前缀，避免和快捷指令工具重名）。 */
export function mcpFunctionName(server: McpServer, toolName: string): string {
  return sanitizeFuncName(`mcp_${server.id || server.name}_${toolName}`, 64)
}

/**
 * 合并四路工具，生成发给模型的 tools 数组，并记下函数名到执行目标的映射：
 *   - 快捷指令工具（单向触发；配了回传才有结果）
 *   - MCP 工具（远程 HTTP，有真返回值）
 *   - 内置的本地知识库检索（离线全文检索，有真返回值）
 *   - 内置的技能读取（渐进式披露，有真返回值）
 * 连不上的 MCP 服务器只跳过它的工具，不会打断本轮对话。
 */
async function buildToolSpecs(
  cfg: AgentConfig,
): Promise<{ specs: any[]; routes: Map<string, ToolRoute> }> {
  const specs: any[] = []
  const routes = new Map<string, ToolRoute>()
  const used = new Set<string>()

  const take = (base: string): string => {
    let name = base
    let i = 2
    while (used.has(name)) {
      name = (base.slice(0, 60) + "_" + i).slice(0, 64)
      i += 1
    }
    used.add(name)
    return name
  }

  for (const t of cfg.tools ?? []) {
    if (!t?.name) continue
    const name = take(t.name)
    routes.set(name, { kind: "shortcut", tool: t })
    specs.push({
      type: "function",
      function: { name, description: toolDescription(t), parameters: toolParameters(t) },
    })
  }

  const lists = await collectMcpTools(cfg.mcpServers)
  for (const list of lists) {
    if (list.error) continue
    const server = (cfg.mcpServers ?? []).find((s) => s.id === list.serverId)
    if (!server) continue
    for (const tool of list.tools) {
      const name = take(mcpFunctionName(server, tool.name))
      routes.set(name, { kind: "mcp", server, tool })
      specs.push({
        type: "function",
        function: {
          name,
          description: `[MCP · ${server.name || server.id}] ${tool.description || tool.name}`.slice(0, 1024),
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      })
    }
  }

  // —— 内置工具：本地知识库（没导入过资料就不挂出来） ——
  if (cfg.kbEnabled) {
    const stats = kbStats()
    if (stats.chunks > 0) {
      const semantic = kbSemanticReady()
      const name = take("search_knowledge")
      routes.set(name, { kind: "kb" })
      specs.push({
        type: "function",
        function: {
          name,
          description:
            `在用户的本地知识库里检索资料（共 ${stats.docs} 份资料、${stats.chunks} 个片段），` +
            (semantic
              ? "关键词匹配 + 语义向量混合排序（提问换个说法也能找到），"
              : "离线全文检索（关键词匹配），") +
            "返回最相关的几段原文。用户的问题可能和他自己的资料有关时先查一下，再以原文为准回答，并说明来自哪份文件；查不到就说没找到。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "检索用的关键词或问题，中文自然语言即可" },
              topK: { type: "number", description: "返回几段，默认 5" },
            },
            required: ["query"],
          },
        },
      })
    }
  }

  // —— 内置工具：读取用户上传的 skill 详情 ——
  if (cfg.skillsEnabled && skillsPrompt(cfg.onlySkillIds)) {
    const name = take("read_skill")
    routes.set(name, { kind: "skill" })
    specs.push({
      type: "function",
      function: {
        name,
        description:
          "读出用户上传的某个技能的完整说明（SKILL.md 全文 + 附件清单）。" +
          "要用某个技能时先用这个工具读全文，再严格照做。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "技能名，取系统提示里列出的名称" },
          },
          required: ["name"],
        },
      },
    })
  }

  return { specs, routes }
}

/**
 * 构造触发真实快捷指令的 URL。
 * 官方形式是 `shortcuts://run-shortcut?name=X&input=text&text=Y`：
 * 只有 `input=text` 才会把 `text` 当作「快捷指令输入」传进去；
 * 直接写 `input=<内容>`（早期版本）是收不到的。
 * 无参数时不带 input，快捷指令就以「无输入」运行。
 */
export function buildShortcutURL(tool: AgentTool, inputText?: string): string {
  const base =
    "shortcuts://run-shortcut?name=" + encodeURIComponent(tool.shortcutName)
  if (!inputText) return base
  return base + "&input=text&text=" + encodeURIComponent(inputText)
}

async function executeTool(
  toolCall: any,
  routes: Map<string, ToolRoute>,
  hooks: RunAgentHooks,
): Promise<{ text: string; step: ToolStep }> {
  const name = String(toolCall?.function?.name ?? "")
  const route = routes.get(name)
  if (!route) {
    const text = `未找到名为「${name}」的工具`
    return { text, step: makeStep("other", name, name, "", text, false, 0) }
  }

  let args: any = {}
  try {
    args = JSON.parse(toolCall?.function?.arguments || "{}")
  } catch {
    args = {}
  }
  if (args == null || typeof args !== "object" || Array.isArray(args)) args = {}
  const keys = Object.keys(args)

  // —— MCP 工具：真的有返回值，直接原样交给模型 ——
  if (route.kind === "mcp") {
    const target = `${route.server.name || route.server.id} · ${route.tool.name}`
    const argsText = keys.length > 0 ? JSON.stringify(args) : ""
    hooks.onEvent?.({ type: "tool", kind: "mcp", name, target, argsText })
    const t0 = Date.now()
    const res = await callMcpTool(route.server, route.tool.name, args)
    const step = makeStep("mcp", name, target, argsText, res.text, res.ok, Date.now() - t0)
    hooks.onStep?.(step)
    return { text: res.text, step }
  }

  // —— 本地知识库检索：真结果 ——
  if (route.kind === "kb") {
    const query = String(args.query ?? "").trim()
    const rawTop = Number(args.topK)
    const topK = rawTop > 0 ? Math.min(10, Math.floor(rawTop)) : 5
    hooks.onEvent?.({ type: "tool", kind: "kb", name, target: "本地知识库", argsText: query })
    const t0 = Date.now()
    let text = "没有给出检索关键词。"
    if (query) {
      // 配了向量服务就先算查询向量（失败会自己退化，不报错）
      const qv = await embedQueryVector(query)
      const res = searchKbHybrid(query, topK, qv)
      text = formatKbHits(query, res.hits, { mode: res.mode, fellBack: res.fellBack })
    }
    const step = makeStep("kb", name, "本地知识库", query, text, !!query, Date.now() - t0)
    hooks.onStep?.(step)
    return { text, step }
  }

  // —— 技能：读全文 ——
  if (route.kind === "skill") {
    const key = String(args.name ?? args.skill ?? "").trim()
    const target = key || "技能"
    hooks.onEvent?.({ type: "tool", kind: "skill", name, target, argsText: key })
    const t0 = Date.now()
    const hit = readSkill(key)
    let text: string
    if (!hit) {
      const names = listSkills()
        .filter((s) => s.enabled)
        .map((s) => s.name)
      text = `没有找到名为「${key}」的技能。可用技能：${names.join("、") || "（无）"}`
    } else {
      const files = hit.files.filter((f) => f.toLowerCase() !== "skill.md")
      const parts = [`技能「${hit.meta.name}」的完整说明：`, hit.content]
      if (files.length > 0) parts.push(`\n该技能目录里的附件：${files.join("、")}`)
      text = parts.join("\n")
    }
    const step = makeStep("skill", name, target, key, text, !!hit, Date.now() - t0)
    hooks.onStep?.(step)
    return { text, step }
  }

  // —— 快捷指令工具：默认单向触发；配了 returns 的会把结果回传回来 ——
  const tool = route.tool
  const inputText = keys.length > 0 ? JSON.stringify(args) : ""
  hooks.onEvent?.({ type: "tool", kind: "shortcut", name, target: tool.shortcutName, argsText: inputText })

  const t0 = Date.now()
  const ok = await Safari.openURL(buildShortcutURL(tool, inputText))
  let text: string
  /** 等回传的调用编号（回填结果时靠它对上号）。 */
  let cid: string | undefined
  if (!ok) {
    text = `执行快捷指令「${tool.shortcutName}」失败（无法打开，可能快捷指令名不存在）`
  } else if (tool.returns) {
    // 配了回调 URL：先落一条 pending，快捷指令末尾「打开 URL」把结果送回来时再回填。
    // 这一轮不等它（回传会变成一条隐藏输入续上），所以这里必须交代清楚「结果待回」。
    cid = addPending({ toolName: name, shortcutName: tool.shortcutName, args: inputText }).cid
    const tail = "。它执行完会把结果回传，届时接着回答；现在只需说明已触发，不要编造结果。"
    text = keys.length > 0
      ? `已触发快捷指令「${tool.shortcutName}」，传入参数：${inputText}，正在等它回传结果` + tail
      : `已触发快捷指令「${tool.shortcutName}」（无参数），正在等它回传结果` + tail
  } else {
    // 快捷指令是单向触发：这里必须明确告诉模型「拿不到结果」，
    // 否则它会顺着上下文编造一个执行结果。
    const tail = "。注意：这是单向触发，没有返回值：只说明已执行，不要编造结果。"
    text = keys.length > 0
      ? `已触发快捷指令「${tool.shortcutName}」，传入参数：${inputText}` + tail
      : `已触发快捷指令「${tool.shortcutName}」（无参数）` + tail
  }
  const step = makeStep("shortcut", name, tool.shortcutName, inputText, text, ok, Date.now() - t0)
  if (cid) step.cid = cid
  hooks.onStep?.(step)
  return { text, step }
}

export async function runAgent(
  userText: string,
  cfg: AgentConfig,
  history: ChatMessage[],
  hooksArg?: HooksArg,
  /** hiddenInput：这次输入不画在聊天界面（快捷指令回传续跑那一轮用）。 */
  opts?: { hiddenInput?: boolean },
): Promise<{ reply: string; newHistory: ChatMessage[]; steps: ToolStep[]; reasoning: string }> {
  const hooks = normalizeHooks(hooksArg)
  const messages = buildMessages(cfg, history, userText)
  const maxRounds = Math.max(1, cfg.maxToolRounds || 3)
  // 工具清单在每轮对话开始时取一次（MCP 那边有 5 分钟缓存）。
  const { specs, routes } = await buildToolSpecs(cfg)
  const steps: ToolStep[] = []
  const reasonings: string[] = []
  let reply = ""
  let resolved = false
  /** 服务端一旦表现出不支持流式，本轮剩下的请求就都退回一次性。 */
  let streaming = true
  let usage: TokenUsage | undefined

  const addUsage = (u?: TokenUsage) => {
    if (!u) return
    if (!usage) {
      usage = { ...u }
      return
    }
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      totalTokens: usage.totalTokens + u.totalTokens,
      reasoningTokens: (usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0) || undefined,
      cachedInputTokens: (usage.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0) || undefined,
    }
  }

  // DeepSeek 思考模式把推理放在 reasoning_content（有的兼容实现叫 reasoning）。
  const noteReasoning = (msg: any) => {
    const chunk = msg?.reasoning_content ?? msg?.reasoning
    if (typeof chunk === "string" && chunk.trim()) {
      const t = chunk.trim()
      reasonings.push(t)
      hooks.onReasoning?.(t)
    }
  }

  /** 向模型要一轮回复：优先流式（打字机），服务端不支持就退回一次性请求。 */
  const ask = async (toolSpecs: any[] | null): Promise<any> => {
    if (streaming) {
      let firstSegment = true
      try {
        const out = await callDeepSeekStream(messages, cfg, toolSpecs, (d) => {
          if (d.type === "reasoning") {
            const newSegment = firstSegment
            firstSegment = false
            hooks.onDelta?.({ type: "reasoning", content: d.content, newSegment })
            return
          }
          hooks.onDelta?.(d)
        })
        addUsage(out.usage)
        const t = out.reasoning.trim()
        if (t) {
          reasonings.push(t)
          hooks.onReasoning?.(t)
        }
        return out.message ?? {}
      } catch (e: any) {
        // 接口本身报错（401 / 模型名不对…）直接抛给用户；其余当成「这个服务端不支持流式」。
        if (e?.httpStatus) throw e
        streaming = false
        hooks.onDelta?.({ type: "text", content: "", reset: true })
      }
    }

    const data = await callDeepSeek(messages, cfg, toolSpecs)
    addUsage(readUsage(data?.usage))
    const msg = data?.choices?.[0]?.message ?? {}
    noteReasoning(msg)
    return msg
  }

  for (let i = 0; i < maxRounds; i++) {
    const msg = await ask(specs)
    const toolCalls: any[] = msg.tool_calls ?? []

    if (toolCalls.length === 0) {
      reply = msg.content ?? ""
      resolved = true
      break
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    })
    for (const tc of toolCalls) {
      const { text, step } = await executeTool(tc, routes, hooks)
      steps.push(step)
      messages.push({ role: "tool", tool_call_id: tc.id, content: text })
    }
  }

  if (!resolved) {
    const msg = await ask(null)
    reply = msg.content ?? ""
  }

  const reasoning = clip(reasonings.join("\n\n"), REASONING_CLIP)
  const assistant: ChatMessage = { role: "assistant", content: reply }
  if (reasoning) assistant.reasoning = reasoning
  if (steps.length > 0) assistant.steps = steps
  if (usage) assistant.usage = usage

  const userMsg: ChatMessage = { role: "user", content: userText }
  if (opts?.hiddenInput) userMsg.hidden = true
  const newHistory: ChatMessage[] = [
    ...history,
    userMsg,
    assistant,
  ]

  return { reply, newHistory, steps, reasoning }
}
