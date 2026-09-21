export interface AgentTool {
  name: string
  description: string
  shortcutName: string
  /**
   * 参数声明，每行一个 `字段名=说明`（也支持全角 `＝` / `：`）。
   * 例：`destination=目的地名称`。写在这里的字段会被转成函数调用的 JSON schema。
   */
  paramsHint?: string
  /** 高级：直接给 JSON schema（配置 JSON 里手写，优先级高于 paramsHint）。 */
  parameters?: Record<string, any>
}

/**
 * 一个远程 MCP 服务器（JSON-RPC over Streamable HTTP）。
 * 沙箱里没有子进程管道，所以只支持 HTTP 型 MCP，不支持 stdio 型。
 */
export interface McpServer {
  /** 内部 id，用于生成模型看到的函数名，建议只含字母数字下划线。 */
  id: string
  /** 显示名，会作为工具名前缀。 */
  name: string
  /** Streamable HTTP 端点，例如 https://example.com/mcp */
  url: string
  /** 可选 Bearer Token。 */
  token?: string
  /** 额外请求头，每行一个 `Header: Value`。 */
  headersHint?: string
  enabled: boolean
}

export function makeMcpServer(): McpServer {
  return {
    id: "s" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    name: "",
    url: "",
    token: "",
    headersHint: "",
    enabled: true,
  }
}

export interface AgentConfig {
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  systemPrompt: string
  maxHistory: number
  speakReply: boolean
  maxToolRounds: number
  thinkingEnabled: boolean
  reasoningEffort: string
  tools: AgentTool[]
  /** 远程 MCP 服务器列表。 */
  mcpServers: McpServer[]
  /** 开启本地知识库检索工具。 */
  kbEnabled: boolean
  /** 开启用户上传的技能。 */
  skillsEnabled: boolean
  // —— 知识库语义检索（可选，OpenAI 兼容的 /embeddings）——
  /** 给知识库检索加上向量语义召回；关掉就是纯离线 BM25。 */
  embedEnabled: boolean
  /** 向量接口地址，例如 https://api.siliconflow.cn/v1 */
  embedBaseUrl: string
  /** 向量接口路径，默认 /embeddings */
  embedPath: string
  /** 向量服务密钥（和对话模型的 Key 分开填）。 */
  embedApiKey: string
  /** 向量模型名，例如 BAAI/bge-m3、intfloat/multilingual-e5-small。 */
  embedModel: string
  /** 在聊天页展示 AI 的思考与工具调用过程。 */
  showSteps: boolean
  // —— 角色形象 ——
  agentName: string
  agentEmoji: string
  greetText: string
  /** 用户上传的头像图片路径（图片存在 appGroup，这里只存路径）；为空则用 emoji。 */
  avatarPath?: string
}

/** AI 调用一次工具的完整记录（聊天页用它回放 AI 的决策过程）。 */
export interface ToolStep {
  /** 工具类别：本地快捷指令 / MCP / 本地知识库 / 技能；other = 模型点了一个不存在的工具。 */
  kind: "shortcut" | "mcp" | "kb" | "skill" | "other"
  /** 模型看到的函数名。 */
  name: string
  /** 展示用目标：快捷指令名 / 「服务器 · 工具」/ 本地知识库 / 技能名。 */
  target: string
  /** 调用参数（JSON 文本或查询词），过长会截断。 */
  args: string
  /** 返回结果，过长会截断。 */
  result: string
  /** 是否成功。 */
  ok: boolean
  /** 耗时（毫秒）。 */
  ms: number
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  /** 模型的推理过程（DeepSeek 思考模式返回的 reasoning_content）。 */
  reasoning?: string
  /** 这一轮里 AI 调用过的工具，按时间顺序。 */
  steps?: ToolStep[]
  /** 这一轮的 token 用量（流式响应最后一帧带回来的 usage）。 */
  usage?: TokenUsage
}

/** 一次请求的 token 用量（不同厂商字段名不一，读回来时归一化）。 */
export interface TokenUsage {
  /** 输入 token（prompt_tokens）。 */
  inputTokens: number
  /** 输出 token（completion_tokens）。 */
  outputTokens: number
  /** 合计 token。 */
  totalTokens: number
  /** 其中属于思考（reasoning_tokens）的部分。 */
  reasoningTokens?: number
  /** 命中缓存的输入 token。 */
  cachedInputTokens?: number
}

/** 一个会话（一段独立的对话，各自带历史）。 */
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface SessionStore {
  currentId: string | null
  sessions: Session[]
}

const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
export const CONFIG_FILE = AGENT_DIR + "/config.json"
export const SESSIONS_FILE = AGENT_DIR + "/sessions.json"
/** 旧版单会话历史文件，仅用于迁移。 */
const LEGACY_HISTORY_FILE = AGENT_DIR + "/history.json"

export const NEW_SESSION_TITLE = "新对话"

/** 默认的角色设定（系统提示词）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是一个运行在用户手机上的智能体助手，可以调用用户的快捷指令和 MCP 工具来帮他完成任务。工具返回的结果就是事实，不要编造执行结果。回答请简洁、友好，使用中文。"

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  apiPath: "/chat/completions",
  model: "deepseek-flash",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxHistory: 50,
  speakReply: true,
  maxToolRounds: 3,
  thinkingEnabled: true,
  reasoningEffort: "high",
  tools: [],
  mcpServers: [],
  kbEnabled: true,
  skillsEnabled: true,
  embedEnabled: false,
  embedBaseUrl: "",
  embedPath: "/embeddings",
  embedApiKey: "",
  embedModel: "",
  showSteps: true,
  agentName: "小助",
  agentEmoji: "✨",
  greetText: "说点什么，或者点下面的麦克风直接听写",
}

// ———————————————————————— 工具参数 ————————————————————————

export interface ToolParamSpec {
  name: string
  description: string
}

/** 解析「参数」文本：每行一个 `字段名=说明`。 */
export function parseToolParams(hint?: string): ToolParamSpec[] {
  const out: ToolParamSpec[] = []
  for (const line of (hint ?? "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[=＝:：]\s*(.*)$/)
    if (!m) continue
    out.push({ name: m[1], description: m[2].trim() })
  }
  return out
}

/** 送给模型看的 JSON schema（无参数时是一个空对象）。 */
export function toolParameters(t: AgentTool): Record<string, any> {
  if (t.parameters && Object.keys(t.parameters).length > 0) return t.parameters
  const specs = parseToolParams(t.paramsHint)
  if (specs.length === 0) return { type: "object", properties: {} }
  const properties: Record<string, any> = {}
  for (const s of specs) {
    properties[s.name] = { type: "string", description: s.description }
  }
  return { type: "object", properties, required: specs.map((s) => s.name) }
}

/** 送给模型看的工具说明（含参数名提醒 + 单向触发声明）。 */
export function toolDescription(t: AgentTool): string {
  const desc = (t.description ?? "").trim()
  const specs = parseToolParams(t.paramsHint)
  const params =
    specs.length === 0
      ? ""
      : "\n调用时以 JSON 对象返回参数，字段名：" + specs.map((s) => s.name).join("、")
  return desc + params + "\n（单向触发：调用后无返回值，不要编造执行结果。）"
}

// ———————————————————————— 配置 ————————————————————————

export function loadConfig(): AgentConfig {
  try {
    const raw = FileManager.readAsStringSync(CONFIG_FILE)
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg: AgentConfig): void {
  FileManager.createDirectorySync(AGENT_DIR, true)
  FileManager.writeAsStringSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

/** 返回错误文案；null 表示校验通过。 */
export function validateConfig(cfg: AgentConfig): string | null {
  if (!cfg.apiKey.trim()) return "请填写 API Key"
  if (!cfg.baseUrl.trim()) return "请填写接口地址"
  if (!cfg.model.trim()) return "请填写模型名称"
  return null
}

/** 配置项的键名，供快捷指令传 JSON 时识别。 */
export const CONFIG_KEYS: string[] = [
  "apiKey", "baseUrl", "apiPath", "model", "systemPrompt",
  "maxHistory", "speakReply", "maxToolRounds", "thinkingEnabled",
  "reasoningEffort", "tools", "mcpServers", "kbEnabled", "skillsEnabled",
  "embedEnabled", "embedBaseUrl", "embedPath", "embedApiKey", "embedModel",
  "showSteps", "agentName", "agentEmoji", "greetText", "avatarPath",
]

/**
 * 若 text 是一段包含配置键的 JSON 对象，则合并保存并返回 true。
 * 用于「快捷指令直接改配置」的兼容路径。
 */
export function tryApplyConfigJson(text: string): boolean {
  const t = (text ?? "").trim()
  if (!t.startsWith("{")) return false
  try {
    const obj = JSON.parse(t)
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
    if (!Object.keys(obj).some((k) => CONFIG_KEYS.includes(k))) return false
    saveConfig({ ...loadConfig(), ...obj })
    return true
  } catch {
    return false
  }
}

// ———————————————————————— 会话 ————————————————————————

function newSessionId(): string {
  return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

export function makeSession(): Session {
  const now = Date.now()
  return { id: newSessionId(), title: NEW_SESSION_TITLE, createdAt: now, updatedAt: now, messages: [] }
}

/** 用第一条用户消息生成会话标题。 */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")
  const t = (first?.content ?? "").trim().replace(/\s+/g, " ")
  if (!t) return NEW_SESSION_TITLE
  return t.length > 18 ? t.slice(0, 18) + "…" : t
}

export function loadStore(): SessionStore {
  try {
    const parsed = JSON.parse(FileManager.readAsStringSync(SESSIONS_FILE))
    if (parsed && Array.isArray(parsed.sessions)) {
      const sessions: Session[] = parsed.sessions
      const hasCurrent = sessions.some((s) => s.id === parsed.currentId)
      return { currentId: hasCurrent ? parsed.currentId : (sessions[0]?.id ?? null), sessions }
    }
  } catch {
    // 文件不存在或损坏，尝试下面迁移
  }
  // 兼容旧版：把单会话 history.json 迁移成一个会话
  try {
    const legacy = JSON.parse(FileManager.readAsStringSync(LEGACY_HISTORY_FILE))
    if (Array.isArray(legacy) && legacy.length > 0) {
      const s = makeSession()
      s.messages = legacy
      s.title = deriveTitle(legacy)
      return { currentId: s.id, sessions: [s] }
    }
  } catch {
    // 没有旧数据
  }
  return { currentId: null, sessions: [] }
}

export function saveStore(store: SessionStore): void {
  FileManager.createDirectorySync(AGENT_DIR, true)
  FileManager.writeAsStringSync(SESSIONS_FILE, JSON.stringify(store, null, 2))
}

/** 保证 store 里有一个可用的当前会话（没有就新建一个并放到最前）。 */
export function withCurrentSession(store: SessionStore): { store: SessionStore; session: Session } {
  const found = store.sessions.find((s) => s.id === store.currentId)
  if (found) return { store, session: found }
  const s = makeSession()
  return { store: { currentId: s.id, sessions: [s, ...store.sessions] }, session: s }
}

export function upsertSession(store: SessionStore, session: Session): SessionStore {
  const exists = store.sessions.some((s) => s.id === session.id)
  const sessions = exists
    ? store.sessions.map((s) => (s.id === session.id ? session : s))
    : [session, ...store.sessions]
  return { currentId: session.id, sessions }
}

export function removeSession(store: SessionStore, id: string): SessionStore {
  const sessions = store.sessions.filter((s) => s.id !== id)
  const currentId = store.currentId === id ? (sessions[0]?.id ?? null) : store.currentId
  return { currentId, sessions }
}

export function clearSessionMessages(store: SessionStore, id: string): SessionStore {
  return {
    ...store,
    sessions: store.sessions.map((s) =>
      s.id === id ? { ...s, messages: [], title: NEW_SESSION_TITLE, updatedAt: Date.now() } : s,
    ),
  }
}

/** 按 maxHistory 截断后的消息列表。 */
export function capMessages(messages: ChatMessage[], maxHistory: number): ChatMessage[] {
  return messages.slice(-Math.max(1, maxHistory))
}
