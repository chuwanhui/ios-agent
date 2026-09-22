/**
 * 外部通过 x-callback-url 给智能体派活。
 *
 * 目前支持的动作：
 *   ✓ registerShortcut —— 注册一条「本地快捷指令工具」写进配置，之后在对话里让 AI 调用它。
 *   （快捷指令「调用对不上」的提示在 agent_core 里已经有了：打不开会如实说「可能快捷指令名不存在」。）
 *
 * 协议（x-callback-url 风格，走 Scripting 的 URL scheme，query 由 Script.queryParameters 解析）：
 *
 *   scripting://run/智能体?action=registerShortcut
 *     &x-source=调用方名字                        （可选，回跳时会原样带上）
 *     &name=navigate_home                         （可选：AI 看到的函数名；缺省按快捷指令名自动生成）
 *     &shortcutName=导航回家                       （必填：手机里『快捷指令』App 中那条的真实名字，须一字不差）
 *     &description=用地图导航到某个目的地          （必填：告诉 AI 这条快捷指令什么时候用）
 *     &params=[{"name":"destination","description":"目的地"}]   （可选：结构化参数 JSON 数组）
 *     &paramsHint=destination=目的地               （可选：一行一个 `字段名=说明`，params 优先）
 *     &returns=true                               （可选：这条快捷指令会按协议把结果回传给助手）
 *     &silent=1                                   （可选：注册结果不塞进会话历史，只回跳 URL）
 *     &x-success=myapp://done?text={text}&name={name}
 *     &x-error=myapp://error?message={errorMessage}
 *
 * 成功跳 x-success、失败跳 x-error（都没带就不跳）。占位符 {text} {name} {shortcutName}
 * {errorMessage} {source} 会在打开前替换成真实值（URL 编码）。
 * 重复注册同一条快捷指令会覆盖更新，不会叠出两条。
 */
import {
  AgentTool, ToolParamSpec, loadConfig, makeToolFunctionName, parseToolParams, saveConfig,
} from "./agent_store"
import { normalizeParams } from "./capabilities"

/** 一次 x-callback-url 请求的处理结果（chat_page 拿它决定要不要进会话历史）。 */
export interface XCallbackOutcome {
  ok: boolean
  /** 给用户看的注册结果文案。 */
  text: string
  /** silent=1 时只回跳 URL，不写会话历史。 */
  silent: boolean
  /** 注册成功后的函数名（AI 调用时用的）。 */
  toolName?: string
}

function queryText(params: any, keys: string[]): string {
  if (!params || typeof params !== "object") return ""
  for (const k of keys) {
    const v = (params as any)[k]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (typeof v === "number" || typeof v === "boolean") return String(v)
  }
  return ""
}

function queryBool(v: any): boolean {
  return v === true || v === "true" || v === "1" || v === 1 || v === "yes"
}

function enc(s: string): string {
  return encodeURIComponent(s ?? "")
}

function fillPlaceholders(url: string, vars: Record<string, string>): string {
  let out = url ?? ""
  for (const k of Object.keys(vars)) {
    out = out.split("{" + k + "}").join(vars[k])
  }
  return out
}

async function jump(url?: string): Promise<void> {
  const t = (url ?? "").trim()
  if (!t) return
  try {
    await Safari.openURL(t)
  } catch {
    // 回跳不是注册成功与否的判据，跳不跳没关系
  }
}

/** params 传结构化 JSON 数组，否则退回 paramsHint 的 `字段名=说明` 简写。 */
function parseParamsInput(jsonOrEmpty: string, hint: string): ToolParamSpec[] {
  const t = (jsonOrEmpty ?? "").trim()
  if (t.startsWith("[")) {
    try {
      return normalizeParams(JSON.parse(t)) ?? []
    } catch {
      // JSON 坏了就退回简写，别让整条注册因为格式问题失败
    }
  }
  return parseToolParams(hint)
}

/**
 * 处理「注册快捷指令工具」的 x-callback 请求。
 * 不是 registerShortcut 动作（或压根不是 x-callback）就返回 null，由调用方继续走别的入口。
 */
export async function handleRegisterShortcut(params: any): Promise<XCallbackOutcome | null> {
  if (!params || typeof params !== "object") return null
  if (queryText(params, ["action", "cmd"]).toLowerCase() !== "registershortcut") return null

  const cfg = loadConfig()
  const shortcutName = queryText(params, ["shortcutName", "shortcut", "快捷指令"])
  const rawName = queryText(params, ["name", "toolName", "工具名"])
  const description = queryText(params, ["description", "desc", "说明"])
  const returns = queryBool(params?.["returns"] ?? params?.["withResult"] ?? params?.["回传"])
  const silent = queryBool(params?.["silent"])
  const source = queryText(params, ["x-source", "source"])

  const fail = async (reason: string): Promise<XCallbackOutcome> => {
    const errorMessage = "注册快捷指令工具失败：" + reason
    await jump(
      fillPlaceholders(queryText(params, ["x-error", "error"]), {
        errorMessage: enc(errorMessage),
        source: enc(source),
      }),
    )
    return { ok: false, silent, text: errorMessage }
  }

  if (!shortcutName) {
    return fail("缺少 shortcutName（要跟手机里『快捷指令』App 那条的名字一字不差）。")
  }
  if (!description) {
    return fail("缺 description（填一句这条快捷指令什么时候用，AI 才知道何时该调用它）。")
  }

  const used = new Set((cfg.tools ?? []).map((t) => t.name))
  const { name, note } = makeToolFunctionName(rawName, shortcutName, used.size, used)

  const tool: AgentTool = { name, shortcutName, description }
  const specs = parseParamsInput(
    params?.["params"] != null ? String(params["params"]) : "",
    queryText(params, ["paramsHint", "hint"]),
  )
  if (specs.length > 0) tool.params = specs
  if (returns) tool.returns = true

  const tools = (cfg.tools ?? []).slice()
  const existing = tools.findIndex((t) => t.shortcutName === shortcutName)
  if (existing >= 0) tools[existing] = tool
  else tools.push(tool)

  try {
    saveConfig({ ...cfg, tools })
  } catch (e: any) {
    return fail("写配置出错：" + (e?.message ?? String(e)))
  }

  const paramsSum =
    specs.length === 0
      ? "无"
      : specs.map((p) => p.name + (p.required === false ? "（可选）" : "")).join("、")
  const text =
    `✅ 已注册快捷指令工具「${shortcutName}」。\n` +
    `- AI 调用名：${name}\n` +
    `- 说明：${description}\n` +
    `- 参数：${paramsSum}\n` +
    `- 回传：${returns ? "会（按协议配了回调 URL 的话）" : "不会（单向触发）"}` +
    (note ? `\n（提示：${note}）` : "") +
    `\n之后在对话里直接说「帮我${description}」，AI 就会试着调用它。请确保手机里『快捷指令』App 已存在同名快捷指令（一字不差，否则 AI 调用时会提示「可能快捷指令名不存在」）。`

  await jump(
    fillPlaceholders(queryText(params, ["x-success", "success"]), {
      text: enc(text),
      name: enc(name),
      shortcutName: enc(shortcutName),
      source: enc(source),
    }),
  )
  return { ok: true, silent, text, toolName: name }
}