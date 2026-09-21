import { fetch } from "scripting"
import {
  AgentConfig, AgentTool, ChatMessage, McpServer, toolDescription, toolParameters,
} from "./agent_store"
import { McpTool, callMcpTool, collectMcpTools } from "./mcp_client"
import { formatKbHits, kbStats, searchKb } from "./kb_store"
import { listSkills, readSkill, skillsPrompt } from "./skills_store"

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
  const body: Record<string, any> = {
    model: cfg.model,
    messages,
    stream: false,
  }
  if (cfg.thinkingEnabled) {
    body.thinking = { type: "enabled" }
  }
  if (cfg.reasoningEffort) {
    body.reasoning_effort = cfg.reasoningEffort
  }
  if (toolsSpec && toolsSpec.length > 0) {
    body.tools = toolsSpec
  }

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
    throw new Error(`DeepSeek 错误 ${resp.status}: ${text}`)
  }
  return await resp.json()
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
    const sp = skillsPrompt()
    if (sp) sys.push(sp)
  }
  if (sys.length > 0) {
    msgs.push({ role: "system", content: sys.join("\n\n") })
  }
  for (const m of history) {
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
 *   - 快捷指令工具（单向触发，没有返回值）
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
      const name = take("search_knowledge")
      routes.set(name, { kind: "kb" })
      specs.push({
        type: "function",
        function: {
          name,
          description:
            `在用户的本地知识库里做离线全文检索（共 ${stats.docs} 份资料、${stats.chunks} 个片段），` +
            "返回最相关的几段原文。当用户的问题可能和他自己的资料有关（文档、笔记、说明书、产品信息…）时，先查一下再回答；" +
            "回答时以检索到的原文为准，并说明来自哪份文件。查不到就直说没找到，不要编造。",
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
  if (cfg.skillsEnabled && skillsPrompt()) {
    const name = take("read_skill")
    routes.set(name, { kind: "skill" })
    specs.push({
      type: "function",
      function: {
        name,
        description:
          "读出用户上传的某个技能的完整说明（SKILL.md 全文 + 附件清单）。" +
          "系统提示里只列了技能名和一句话描述，真正要执行某个技能时先用这个工具读全文，再严格照做。",
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
  onEvent?: (e: AgentEvent) => void,
): Promise<string> {
  const name = toolCall?.function?.name as string
  const route = routes.get(name)
  if (!route) {
    return `未找到名为「${name}」的工具`
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
    onEvent?.({
      type: "tool",
      kind: "mcp",
      name,
      target: `${route.server.name || route.server.id} · ${route.tool.name}`,
      argsText: keys.length > 0 ? JSON.stringify(args) : "",
    })
    const res = await callMcpTool(route.server, route.tool.name, args)
    return res.text
  }

  // —— 本地知识库检索：真结果 ——
  if (route.kind === "kb") {
    const query = String(args.query ?? "").trim()
    const rawTop = Number(args.topK)
    const topK = rawTop > 0 ? Math.min(10, Math.floor(rawTop)) : 5
    onEvent?.({ type: "tool", kind: "kb", name, target: "本地知识库", argsText: query })
    if (!query) return "没有给出检索关键词。"
    return formatKbHits(query, searchKb(query, topK))
  }

  // —— 技能：读全文 ——
  if (route.kind === "skill") {
    const key = String(args.name ?? args.skill ?? "").trim()
    onEvent?.({ type: "tool", kind: "skill", name, target: key || "技能", argsText: key })
    const hit = readSkill(key)
    if (!hit) {
      const names = listSkills()
        .filter((s) => s.enabled)
        .map((s) => s.name)
      return `没有找到名为「${key}」的技能。可用技能：${names.join("、") || "（无）"}`
    }
    const files = hit.files.filter((f) => f.toLowerCase() !== "skill.md")
    const parts = [`技能「${hit.meta.name}」的完整说明：`, hit.content]
    if (files.length > 0) parts.push(`\n该技能目录里的附件：${files.join("、")}`)
    return parts.join("\n")
  }

  // —— 快捷指令工具：单向触发，拿不到结果 ——
  const tool = route.tool
  const inputText = keys.length > 0 ? JSON.stringify(args) : ""
  onEvent?.({ type: "tool", kind: "shortcut", name, target: tool.shortcutName, argsText: inputText })

  const ok = await Safari.openURL(buildShortcutURL(tool, inputText))
  if (!ok) {
    return `执行快捷指令「${tool.shortcutName}」失败（无法打开，可能快捷指令名不存在）`
  }
  // 快捷指令是单向触发：这里必须明确告诉模型「拿不到结果」，
  // 否则它会顺着上下文编造一个执行结果。
  const tail = "。注意：这是单向触发，没有返回值，不要编造执行结果；只能说明已执行，或让用户自己看手机确认。"
  return keys.length > 0
    ? `已触发快捷指令「${tool.shortcutName}」，传入参数：${inputText}` + tail
    : `已触发快捷指令「${tool.shortcutName}」（无参数）` + tail
}

export async function runAgent(
  userText: string,
  cfg: AgentConfig,
  history: ChatMessage[],
  onEvent?: (e: AgentEvent) => void,
): Promise<{ reply: string; newHistory: ChatMessage[] }> {
  const messages = buildMessages(cfg, history, userText)
  const maxRounds = Math.max(1, cfg.maxToolRounds || 3)
  // 工具清单在每轮对话开始时取一次（MCP 那边有 5 分钟缓存）。
  const { specs, routes } = await buildToolSpecs(cfg)
  let reply = ""
  let resolved = false

  for (let i = 0; i < maxRounds; i++) {
    const data = await callDeepSeek(messages, cfg, specs)
    const msg = data?.choices?.[0]?.message ?? {}
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
      const result = await executeTool(tc, routes, onEvent)
      messages.push({ role: "tool", tool_call_id: tc.id, content: result })
    }
  }

  if (!resolved) {
    const data = await callDeepSeek(messages, cfg, null)
    reply = data?.choices?.[0]?.message?.content ?? ""
  }

  const newHistory: ChatMessage[] = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ]

  return { reply, newHistory }
}

export async function dictate(): Promise<string> {
  if (SpeechRecognition.isRecognizing) {
    await SpeechRecognition.stop()
  }

  return new Promise<string>((resolve, reject) => {
    let finalText = ""
    const timeoutId = setTimeout(async () => {
      await SpeechRecognition.stop()
      resolve(finalText)
    }, 15000)

    SpeechRecognition.start({
      locale: "zh-CN",
      partialResults: true,
      addsPunctuation: true,
      taskHint: "dictation",
      onResult: (result: any) => {
        finalText = result.text
        if (result.isFinal) {
          clearTimeout(timeoutId)
          resolve(result.text)
        }
      },
    }).then((started: boolean) => {
      if (!started) {
        clearTimeout(timeoutId)
        reject(new Error("无法启动语音识别"))
      }
    })
  })
}
