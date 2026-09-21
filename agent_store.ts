export interface AgentTool {
  name: string
  description: string
  shortcutName: string
  /**
   * 参数声明，每行一个 `字段名=说明`（也支持全角 `＝` / `：`）。
   * 例：`destination=目的地名称`。写在这里的字段会被转成函数调用的 JSON schema。
   */
  paramsHint?: string
  /**
   * 结构化参数声明（粘贴 JSON 导入时写的完整版）：可以标类型、可选、取值枚举、默认值。
   * 有它时就优先于 paramsHint。
   */
  params?: ToolParamSpec[]
  /**
   * 这个快捷指令末尾配了「回调 URL」、会把执行结果传回来。
   * 只影响给模型看的说明措辞（别再一律说「没有返回值」）。
   */
  returns?: boolean
  /** 高级：直接给 JSON schema（配置 JSON 里手写，优先级最高）。 */
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

// ———————————————————————— MCP：JSON 导入 / 导出 ————————————————————————

/** 从一段 MCP 配置 JSON 里解析出的结果。 */
export interface McpParseResult {
  /** 解析出来的服务器（id 已生成，未去重）。 */
  servers: McpServer[]
  /** 被跳过条目的原因说明，可直接展示给用户。 */
  skipped: string[]
}

function asRecord(v: any): Record<string, any> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null
}

function entriesOf(o: Record<string, any>): [string, any][] {
  return Object.keys(o).map((k) => [k, o[k]] as [string, any])
}

/** 把任意写法里的 id 部分清洗成合法标识符（模型看到的函数名要带上它）。 */
function slugifyId(raw: string, prefix: string, used: Set<string>): string {
  let base = (raw ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "")
  if (!base || !/^[A-Za-z_]/.test(base)) base = prefix + base
  let id = base
  let i = 2
  while (used.has(id)) {
    id = base + "_" + i
    i += 1
  }
  used.add(id)
  return id
}

/**
 * 从各种常见的 MCP 配置写法里取出「服务器名 → 配置」映射：
 * `{mcpServers:{…}}` / `{servers:{…}}` / `{mcp:{servers:{…}}}` / 裸映射 `{名字:{url}}`。
 */
function pickServerMap(root: any): Record<string, any> | null {
  const obj = asRecord(root)
  if (!obj) return null
  for (const key of ["mcpServers", "mcp_servers", "servers", "mcpServersList"]) {
    const m = asRecord(obj[key])
    if (m && Object.keys(m).length > 0) return m
  }
  const nested = asRecord(obj.mcp)
  if (nested) {
    const m = asRecord(nested.servers) ?? asRecord(nested.mcpServers)
    if (m && Object.keys(m).length > 0) return m
  }
  // 裸映射：值全是对象（或全是字符串形式的地址）时，认为整个对象就是名字 → 配置
  const values = Object.keys(obj).map((k) => obj[k])
  if (values.length > 0 && values.every((v) => asRecord(v) !== null)) return obj
  if (values.length > 0 && values.every((v) => typeof v === "string" && v.indexOf("/") >= 0)) return obj
  return null
}

/**
 * 解析用户粘贴的 MCP 配置 JSON。
 * 支持 `{"mcpServers":{名字:{url,headers}}}`（Claude / Cherry Studio 等）与 VS Code 的
 * `{"mcp":{"servers":{…}}}`；`command` / `args` 的 stdio 型会明确跳过并说明原因，
 * 而不是静默丢掉（iOS 上跑不了本地子进程）。
 */
export function parseMcpServersJson(text: string): McpParseResult {
  const raw = (text ?? "").trim()
  if (!raw) throw new Error("请先粘贴 MCP 配置 JSON")
  let root: any
  try {
    root = JSON.parse(raw)
  } catch (e: any) {
    throw new Error("JSON 格式不对：" + (e?.message ?? "解析失败"))
  }
  const map = pickServerMap(root)
  if (!map) {
    throw new Error(
      "没找到 mcpServers 字段。支持 {\"mcpServers\":{…}}、{\"mcp\":{\"servers\":{…}}}，或 {\"名字\":{\"url\":…}}",
    )
  }

  const out: McpParseResult = { servers: [], skipped: [] }
  const used = new Set<string>()
  const seenUrl = new Set<string>()

  for (const [key, value] of entriesOf(map)) {
    const label = key || "未命名"
    // 名字 → 地址 的简写
    if (typeof value === "string") {
      const url = value.trim()
      if (!url) {
        out.skipped.push(`${label}：地址是空的`)
        continue
      }
      if (seenUrl.has(url)) {
        out.skipped.push(`${label}：地址重复，只留第一条`)
        continue
      }
      seenUrl.add(url)
      const s = makeMcpServer()
      s.id = slugifyId(key, "s", used)
      s.name = label
      s.url = url
      out.servers.push(s)
      continue
    }

    const rec = asRecord(value)
    if (!rec) {
      out.skipped.push(`${label}：配置看不懂（应该是一个对象）`)
      continue
    }
    const type = String(rec.type ?? rec.transport ?? "").toLowerCase()
    const url = String(rec.url ?? rec.endpoint ?? rec.serverUrl ?? rec.httpUrl ?? "").trim()
    const command = rec.command
    if (!url) {
      out.skipped.push(
        command
          ? `${label}：stdio 型（command: ${command}），iOS 上没法起本地进程，需要换成 http/sse 地址`
          : `${label}：没写 url`,
      )
      continue
    }
    if (type === "stdio") {
      out.skipped.push(`${label}：stdio 型跑不了（iOS 没有子进程管道）`)
      continue
    }
    if (seenUrl.has(url)) {
      out.skipped.push(`${label}：地址重复，只留第一条`)
      continue
    }
    seenUrl.add(url)

    const s = makeMcpServer()
    s.id = slugifyId(key || url, "s", used)
    s.name = String(rec.title ?? "") || label
    s.url = url

    const lines: string[] = []
    const headers = asRecord(rec.headers)
    if (headers) {
      for (const [hk, hv] of entriesOf(headers)) {
        const val = typeof hv === "string" ? hv : String(hv ?? "")
        if (/^authorization$/i.test(hk)) {
          // Authorization: Bearer xxx → 归到「令牌」，其余写法原样留在请求头里
          const m = val.match(/^\s*bearer\s+(.+)$/i)
          if (m) s.token = m[1].trim()
          else lines.push(`${hk}: ${val}`)
        } else {
          lines.push(`${hk}: ${val}`)
        }
      }
    }
    if (typeof rec.token === "string" && !s.token) s.token = rec.token.trim()
    if (typeof rec.apiKey === "string" && !s.token) s.token = rec.apiKey.trim()
    s.headersHint = lines.join("\n")
    if (rec.enabled === false || rec.disabled === true) s.enabled = false
    out.servers.push(s)
  }

  return out
}

/** 把当前服务器列表导出成标准 MCP 配置 JSON（方便复制给别的客户端）。 */
export function mcpServersToJson(servers: McpServer[]): string {
  const obj: Record<string, any> = {}
  for (const s of servers) {
    const entry: Record<string, any> = { url: s.url ?? "" }
    const headers: Record<string, string> = {}
    const tk = (s.token ?? "").trim()
    if (tk) headers["Authorization"] = "Bearer " + tk
    for (const line of (s.headersHint ?? "").split(/\r?\n/)) {
      const i = line.indexOf(":")
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      if (!k) continue
      headers[k] = line.slice(i + 1).trim()
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    if (!s.enabled) entry.disabled = true
    obj[s.name || s.id] = entry
  }
  return JSON.stringify({ mcpServers: obj }, null, 2)
}

export interface AgentConfig {
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  /**
   * 上次从 `<接口地址>/models` 拉回来的可用模型。设置页只能从这里选，不给手输；
   * 存进配置是为了重启后列表还在（不用每次重新拉）。
   */
  modelOptions?: string[]
  /** 上次拉取模型列表的时间（毫秒）。 */
  modelOptionsAt?: number
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
  /**
   * 私有 Git 仓库的访问令牌（可选），只用于「技能 → 从 Git 仓库导入」。
   * 留空就只能拉公开仓库。
   */
  gitToken?: string
  /**
   * 会话级挂载用的临时字段（不会写进配置文件）：只把技能库里这些 id 放进系统提示；
   * undefined = 用注册表里所有启用的技能。
   */
  onlySkillIds?: string[]
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
  /**
   * 调用编号：带 returns 的快捷指令工具会先记一条 pending，
   * 快捷指令回传时靠它对上号（回填真实结果）。
   */
  cid?: string
  /** 是否已经收到快捷指令的回传（此时 result 是回传内容，不再是「等待回传」）。 */
  callback?: boolean
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

/**
 * 会话级挂载：这一次对话要用到哪些能力。
 * undefined 表示「沿用设置里的默认」（全部启用的都用上）；
 * 一旦显式挂载过，就严格按列表来 —— 列表为空 = 这一类本轮不参与。
 */
export interface SessionMounts {
  /** 要挂载的本地快捷指令工具名（AgentTool.name）。 */
  tools: string[]
  /** 要挂载的 MCP 服务器 id。 */
  mcp: string[]
  /** 要挂载的技能 id。 */
  skills: string[]
  /** 是否挂载本地知识库。 */
  kb: boolean
}

/** 一个会话（一段独立的对话，各自带历史）。 */
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 会话级的挂载；没有这个字段就是「全用默认」。 */
  mounts?: SessionMounts
}

export interface SessionStore {
  currentId: string | null
  sessions: Session[]
}

const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
export { AGENT_DIR }
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
  gitToken: "",
}

// ———————————————————————— 工具参数 ————————————————————————

export interface ToolParamSpec {
  name: string
  description: string
  /** 参数类型，默认 string（快捷指令收到的都是文本，这里只影响模型怎么生成）。 */
  type?: "string" | "number" | "integer" | "boolean"
  /** 是否必填，默认 true —— 快捷指令里「获取词典值」少了键会取不到，宁缺毋滥。 */
  required?: boolean
  /** 限定取值，可以让模型只在几种模式里选。 */
  enum?: string[]
  /** 默认值（可写成提示）。 */
  default?: string | number | boolean
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

/** 一个工具最终生效的参数声明：结构化 params 优先，退回「一行一个」的文本写法。 */
export function toolParamSpecs(t: AgentTool): ToolParamSpec[] {
  if (t.params && t.params.length > 0) return t.params
  return parseToolParams(t.paramsHint)
}

const PARAM_TYPES = ["string", "number", "integer", "boolean"]

/** 单个参数 → JSON schema 片段。 */
function paramToSchema(s: ToolParamSpec): Record<string, any> {
  const ty = PARAM_TYPES.indexOf(String(s.type ?? "string")) >= 0 ? String(s.type ?? "string") : "string"
  const out: Record<string, any> = { type: ty }
  const bits: string[] = []
  if (s.description) bits.push(s.description)
  if (s.enum && s.enum.length > 0) {
    out.enum = s.enum.slice()
    bits.push("取值：" + s.enum.join(" / "))
  }
  if (s.default !== undefined && s.default !== null && String(s.default) !== "") {
    out.default = s.default
    bits.push("默认：" + String(s.default))
  }
  if (s.required === false) bits.push("可选，没提到就别传")
  out.description = bits.join("；")
  return out
}

/** 送给模型看的 JSON schema（无参数时是一个空对象）。 */
export function toolParameters(t: AgentTool): Record<string, any> {
  if (t.parameters && Object.keys(t.parameters).length > 0) return t.parameters
  const specs = toolParamSpecs(t)
  if (specs.length === 0) return { type: "object", properties: {} }
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const s of specs) {
    properties[s.name] = paramToSchema(s)
    if (s.required !== false) required.push(s.name)
  }
  const out: Record<string, any> = { type: "object", properties }
  if (required.length > 0) out.required = required
  return out
}

/** 参数在说明里的简写：name / name? / name:number。 */
function paramSummary(s: ToolParamSpec): string {
  const ty = s.type && s.type !== "string" ? ":" + s.type : ""
  const opt = s.required === false ? "?" : ""
  return s.name + opt + ty
}

/** 送给模型看的工具说明（含参数名提醒 + 单向/回传声明）。 */
export function toolDescription(t: AgentTool): string {
  const desc = (t.description ?? "").trim()
  const specs = toolParamSpecs(t)
  const params =
    specs.length === 0
      ? ""
      : "\n调用时以 JSON 对象返回参数，字段名：" + specs.map(paramSummary).join("、")
  const tail = t.returns
    ? "\n（这个快捷指令会把执行结果回传：结果到达后会作为一条新消息出现，届时再回答；" +
      "在收到之前不要编造结果，先说明已经执行、结果稍后到。）"
    : "\n（单向触发：调用后无返回值，不要编造执行结果。）"
  return desc + params + tail
}

// ———————————————————————— 快捷指令工具：粘贴 JSON 导入 / 导出 ————————————————————————

/** 从一段快捷指令工具配置 JSON 里解析出来的结果。 */
export interface ToolParseResult {
  /** 解析出来的工具（name 已清洗去重）。 */
  tools: AgentTool[]
  /** 被跳过 / 被改写的条目的说明，可直接展示给用户。 */
  skipped: string[]
}

function strOf(v: any): string {
  if (v === undefined || v === null) return ""
  return typeof v === "string" ? v : String(v)
}

/** 参数类型归一化：不认识的一律当 string（快捷指令收到的本来就是文本）。 */
function normalizeParamType(v: any): ToolParamSpec["type"] {
  const t = strOf(v).trim().toLowerCase()
  if (t === "number" || t === "float" || t === "double") return "number"
  if (t === "integer" || t === "int") return "integer"
  if (t === "boolean" || t === "bool") return "boolean"
  return "string"
}

/** 一个参数的完整写法 → ToolParamSpec。 */
function specFromRecord(rec: Record<string, any>, fallbackName: string): ToolParamSpec {
  const out: ToolParamSpec = {
    name: strOf(rec.name ?? rec.key ?? fallbackName).trim(),
    description: strOf(rec.description ?? rec.desc ?? rec["说明"] ?? "").trim(),
  }
  if (rec.type !== undefined) out.type = normalizeParamType(rec.type)
  if (rec.required === false || rec.optional === true) out.required = false
  const en = Array.isArray(rec.enum) ? rec.enum : Array.isArray(rec.options) ? rec.options : null
  if (en) {
    const vals = en.map((x) => strOf(x)).filter((x) => !!x)
    if (vals.length > 0) out.enum = vals
  }
  const dv = rec.default
  if (typeof dv === "string" || typeof dv === "number" || typeof dv === "boolean") out.default = dv
  return out
}

/** 「参数」字段的三种写法：一行一个的字符串 / 数组 / 对象。 */
function parseParamsField(v: any): { specs: ToolParamSpec[]; problem?: string } {
  if (v === undefined || v === null || v === "") return { specs: [] }
  if (typeof v === "string") return { specs: parseToolParams(v) }
  if (Array.isArray(v)) {
    const specs: ToolParamSpec[] = []
    for (const it of v) {
      if (typeof it === "string") {
        const one = parseToolParams(it)
        if (one.length > 0) specs.push(one[0])
        continue
      }
      const rec = asRecord(it)
      if (!rec) continue
      const s = specFromRecord(rec, "")
      if (s.name) specs.push(s)
    }
    return { specs }
  }
  const rec = asRecord(v)
  if (rec) {
    const specs: ToolParamSpec[] = []
    for (const [key, val] of entriesOf(rec)) {
      const nm = key.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) continue
      if (typeof val === "string") {
        specs.push({ name: nm, description: val.trim() })
        continue
      }
      const d = asRecord(val)
      if (!d) {
        specs.push({ name: nm, description: strOf(val).trim() })
        continue
      }
      specs.push(specFromRecord(d, nm))
    }
    return { specs }
  }
  return { specs: [], problem: "「参数」写法看不懂（应该是对象或数组）" }
}

/** 从任意写法里取出「一条工具 = 一个对象」的数组。 */
function pickToolEntries(root: any): any[] | null {
  if (Array.isArray(root)) return root
  const rec = asRecord(root)
  if (!rec) return null
  for (const key of ["shortcuts", "tools", "shortcutTools", "本地快捷指令工具", "快捷指令"]) {
    const v = rec[key]
    if (Array.isArray(v)) return v
    const m = asRecord(v)
    if (m && Object.keys(m).length > 0) {
      return entriesOf(m).map(([k, val]) => {
        const r = asRecord(val)
        return r ? { ...r, __key: k } : { __key: k, __value: strOf(val) }
      })
    }
  }
  if (rec.name || rec.shortcut || rec.shortcutName || rec["快捷指令"]) return [rec]
  // 裸映射：{"导航回家": {…}}（值都是对象时才这么认，避免把乱粘的 JSON 当成工具）
  const keys = Object.keys(rec)
  if (keys.length > 0 && entriesOf(rec).every(([, v]) => !!asRecord(v))) {
    return entriesOf(rec).map(([k, val]) => ({ ...(asRecord(val) as Record<string, any>), __key: k }))
  }
  return null
}

const FUNC_NAME_CHARS = /[^A-Za-z0-9_-]+/g

/** 生成模型看到的函数名（只允许 [A-Za-z0-9_-]，去重，≤ 64 字符）。 */
export function makeToolFunctionName(
  rawName: string,
  shortcutName: string,
  index: number,
  used: Set<string>,
): { name: string; note?: string } {
  const clean = (s: string) => s.replace(FUNC_NAME_CHARS, "_").replace(/^[_-]+|[_-]+$/g, "")
  let base = clean(rawName)
  let note: string | undefined
  if (!base) {
    base = clean(shortcutName)
    if (base) note = `${shortcutName}：没写 name，用「${base}」做函数名`
  }
  if (!base) base = "tool" + (index + 1)
  if (base.length > 64) base = base.slice(0, 64)
  let name = base
  let i = 2
  while (used.has(name)) {
    name = base + "_" + i
    i += 1
  }
  used.add(name)
  if (name !== base && !note) note = `${rawName}：函数名重复，改用「${name}」`
  return { name, note }
}

/**
 * 解析一段「快捷指令工具」配置 JSON。这些写法都认：
 * - `[{…}, …]`、`{"shortcuts":[{…}]}`、`{"tools":[{…}]}`、`{"名字":{…}}`、单个 `{name, shortcut}`
 * - 字段别名：`shortcut`/`shortcutName`/`快捷指令`；`params`/`args`/`paramsHint`/`参数`
 * - 参数三种写法：`"destination": "目的地"` / `{"description":…, "type":…, "required":false, "enum":[…]}` / 数组
 * - `parameters` 写成真 JSON schema（带 properties）时原样当高级 schema
 */
export function parseShortcutsJson(text: string): ToolParseResult {
  const raw = (text ?? "").trim()
  if (!raw) throw new Error("请先粘贴快捷指令工具的 JSON")
  let root: any
  try {
    root = JSON.parse(raw)
  } catch (e: any) {
    throw new Error("JSON 格式不对：" + (e?.message ?? "解析失败"))
  }
  const entries = pickToolEntries(root)
  if (!entries) {
    throw new Error(
      '没找到工具列表。支持 [{"name":…,"shortcut":…}]、{"shortcuts":[…] }，或单个 {"name":…,"shortcut":…}',
    )
  }

  const out: ToolParseResult = { tools: [], skipped: [] }
  const used = new Set<string>()
  const seenShortcut = new Set<string>()

  for (let i = 0; i < entries.length; i += 1) {
    const rec = asRecord(entries[i])
    const key = strOf(rec?.__key ?? "").trim()
    const label = key || strOf(rec?.__value ?? "") || "未命名"
    if (!rec) {
      out.skipped.push(`${label}：配置看不懂（应该是一个对象）`)
      continue
    }
    const shortcutName = strOf(
      rec.shortcut ?? rec.shortcutName ?? rec.shortcut_name ?? rec["快捷指令"] ?? rec.__key ?? "",
    ).trim()
    const rawName = strOf(rec.name ?? rec.tool ?? rec.function ?? rec["名称"] ?? "").trim()
    const description = strOf(
      rec.description ?? rec.desc ?? rec["说明"] ?? rec.__value ?? "",
    ).trim()
    if (!shortcutName) {
      out.skipped.push(`${rawName || label}：没写快捷指令名（shortcut）`)
      continue
    }
    if (seenShortcut.has(shortcutName)) {
      out.skipped.push(`${shortcutName}：同一个快捷指令重复了，只留第一条`)
      continue
    }
    seenShortcut.add(shortcutName)

    const named = makeToolFunctionName(rawName || key, shortcutName, i, used)
    if (named.note) out.skipped.push(named.note)
    const tool: AgentTool = {
      name: named.name,
      description: description || shortcutName,
      shortcutName,
    }

    // 手写的完整 JSON schema（形如 {"type":"object","properties":{…}}）
    const schemaLike = asRecord(rec.parameters ?? rec.schema)
    const isSchema = !!asRecord(schemaLike?.properties)
    if (isSchema && schemaLike) tool.parameters = schemaLike

    const paramField =
      rec.params ?? rec.args ?? rec.paramsHint ?? rec["参数"] ?? (isSchema ? undefined : schemaLike)
    if (typeof paramField === "string") {
      const h = paramField.trim()
      if (h) tool.paramsHint = h
    } else if (paramField !== undefined) {
      const parsed = parseParamsField(paramField)
      if (parsed.specs.length > 0) tool.params = parsed.specs
      if (parsed.problem) out.skipped.push(`${named.name}：${parsed.problem}`)
    }

    if (rec.returns === true || rec.callback === true || rec.hasResult === true) tool.returns = true
    out.tools.push(tool)
  }

  return out
}

/** 把当前工具列表导出成可直接粘贴的 JSON（存档 / 复制给别人）。 */
export function shortcutsToJson(tools: AgentTool[]): string {
  const arr = tools.map((t) => {
    const o: Record<string, any> = {
      name: t.name,
      description: t.description,
      shortcut: t.shortcutName,
    }
    if (t.params && t.params.length > 0) {
      const ps: Record<string, any> = {}
      for (const s of t.params) {
        const d: Record<string, any> = {}
        if (s.description) d.description = s.description
        if (s.type && s.type !== "string") d.type = s.type
        if (s.required === false) d.required = false
        if (s.enum && s.enum.length > 0) d.enum = s.enum
        if (s.default !== undefined && s.default !== null && String(s.default) !== "") d.default = s.default
        ps[s.name] = Object.keys(d).length > 0 ? d : ""
      }
      o.params = ps
    } else if (t.paramsHint) {
      o.params = t.paramsHint
    }
    if (t.returns) o.returns = true
    if (t.parameters) o.parameters = t.parameters
    return o
  })
  return JSON.stringify({ shortcuts: arr }, null, 2)
}

/** 示例配置（也是提示框里显示的内容）。 */
export const TOOL_JSON_EXAMPLE =
  '{\n  "shortcuts": [\n' +
  '    {\n      "name": "navigate_home",\n      "description": "用地图导航到某个地点",\n' +
  '      "shortcut": "导航回家",\n      "returns": true,\n      "params": {\n' +
  '        "destination": "目的地名称",\n' +
  '        "mode": {\n          "description": "出行方式",\n' +
  '          "enum": ["driving", "walking", "transit"],\n' +
  '          "required": false,\n          "default": "driving"\n        }\n' +
  '      }\n    }\n  ]\n}'

/** 快捷指令侧要两次配置 —— 给用户复制到「快捷指令」编辑器里的协议说明。 */
export function shortcutProtocolText(scriptName: string): string {
  const name = (scriptName ?? "").trim() || "智能体"
  return [
    "【智能体 → 快捷指令：怎么接参数】",
    "1. 快捷指令开头加「接收输入」（输入类型：文本）。",
    "2. 加「从输入获取词典」，输入取「快捷指令输入」。",
    "3. 每个参数加一个「获取词典值」，键名就是参数名（destination、mode…）。",
    "",
    "【快捷指令 → 智能体：怎么把结果传回来（可选）】",
    "最后加三个动作：",
    "1. 「URL 编码」：输入 = 要回传的内容（文本）。",
    "2. 「文本」：内容写 ",
    "   scripting://run/" + name + "?result=",
    "   紧接着插入上一步「URL 编码」的结果（中间不要有空格或换行）。",
    "3. 「打开 URL」：输入取上一步的文本。",
    "",
    "对应地把工具的 returns 打开（或“回传结果”开关）。",
    "注意：整条 URL 越短越好（建议 2000 字符以内），结果太长就只回传摘要。",
    "注意：回调会同时把 Scripting 拉回前台；结果到达后智能体会自动接着回复你。",
    "注意：一次只派一个工具时不用管；同一轮派了多个，可以在 ?result= 前加 tool=快捷指令名&",
    "      （例如 ?tool=导航回家&result=）让智能体知道是哪一个回来了。",
    "注意：回传记录会在磁盘上留 10 分钟，App 中途被关掉也接得上。",
  ].join("\n")
}

/**
 * 把会话级挂载应用到配置上，得到这一轮真正生效的配置。
 * 挂载为 undefined 时原样返回（沿用设置里的默认），
 * 所以 agent_core 里读的还是同一套 cfg 字段（tools / mcpServers / kbEnabled / skillsEnabled /
 * onlySkillIds），不用改函数签名。
 */
export function effectiveConfig(cfg: AgentConfig, mounts?: SessionMounts): AgentConfig {
  if (!mounts) return cfg
  const toolNames = new Set(mounts.tools)
  const mcpIds = new Set(mounts.mcp)
  return {
    ...cfg,
    tools: cfg.tools.filter((t) => toolNames.has(t.name)),
    mcpServers: cfg.mcpServers.filter((s) => mcpIds.has(s.id)),
    kbEnabled: mounts.kb && cfg.kbEnabled,
    skillsEnabled: mounts.skills.length > 0 && cfg.skillsEnabled,
    onlySkillIds: mounts.skills,
  }
}

/**
 * 会话还没单独挂载过时，「挂载面板」要展示一份可改的初始值：
 * 就是设置里的默认（这里 enabledSkillIds 由调用方传进来，避免 agent_store 反向依赖 skills_store）。
 */
export function mountsFromConfig(cfg: AgentConfig, enabledSkillIds: string[]): SessionMounts {
  return {
    tools: cfg.tools.map((t) => t.name),
    mcp: cfg.mcpServers.filter((s) => s.enabled).map((s) => s.id),
    skills: enabledSkillIds.slice(),
    kb: cfg.kbEnabled,
  }
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
  "showSteps", "agentName", "agentEmoji", "greetText", "avatarPath", "gitToken",
  "modelOptions", "modelOptionsAt",
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
