/**
 * 余额查询：设置页「模型」那一栏顺手看一眼这个接口还剩多少钱。
 *
 * 为什么不是「一个端点打天下」：**余额查询不在 OpenAI 兼容协议里** ——
 * 每一家各写各的路径和字段（DeepSeek / OpenRouter / 硅基流动 / Moonshot…），
 * 中转站更是多半干脆不给。所以这里的做法是：
 *
 *   1. 按「候选端点」挨个试一遍（供应商最可能的那条排前面）；
 *   2. 谁能返回**能解析出金额**的响应就用谁；
 *   3. 全都试不通就老实说这个接口查不到 —— 不猜、不编、不拿别的字段凑。
 *
 * 已知形状（就是候选端点存在的理由）：
 *   - DeepSeek   `GET /user/balance`            → `{ is_available, balance_infos:[{ currency, total_balance, granted_balance, topped_up_balance }] }`
 *   - OpenRouter `GET /api/v1/credits`          → `{ data: { total_credits, total_usage } }`
 *   - OpenRouter `GET /api/v1/auth/key`         → `{ data: { label, usage, limit, is_free_tier } }`
 *   - 硅基流动    `GET /v1/user/info`            → `{ data: { …, balance } }`
 *   - Moonshot   `GET /v1/users/me/balance`     → `{ data: { available_balance, voucher_balance, cash_balance } }`
 */

import { fetch } from "scripting"

export interface BalanceResult {
  ok: boolean
  /** 结论行，如 `¥110.00`。 */
  text: string
  /** 明细行，如 `赠送 ¥10.00 · 充值 ¥100.00`（可能为空）。 */
  detail: string
  /** 命中的端点，如 `api.deepseek.com/user/balance`。 */
  source: string
  /** 查不到时的说明（可照着排查）。 */
  error?: string
}

/** 单个端点的超时。候选端点要挨个试，所以每条都必须短。 */
export const BALANCE_TIMEOUT_MS = 8000

const CURRENCY_SIGN: Record<string, string> = {
  CNY: "¥", RMB: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥",
}

/** 币种代码 → 符号；认不出来就原样带代码（宁可啰嗦也别标错符号）。 */
function money(currency: string, amount: any): string {
  const s = String(amount ?? "").trim()
  if (!s) return ""
  const c = String(currency ?? "").trim().toUpperCase()
  const sign = CURRENCY_SIGN[c] ?? (c ? c + " " : "")
  // 服务端给的字符串一律原样保留（`110.00` 别被改成 `110`）
  return sign + s
}

function isNum(v: any): boolean {
  if (typeof v === "number") return Number.isFinite(v)
  if (typeof v === "string") return v.trim() !== "" && Number.isFinite(Number(v))
  return false
}

function toNum(v: any): number {
  return Number(v)
}

/** 解析结果：一行结论 + 一行明细。 */
interface Parsed {
  text: string
  detail: string
}

/** DeepSeek：`{ balance_infos:[{ currency, total_balance, granted_balance, topped_up_balance }] }` */
function parseDeepSeek(data: any): Parsed | null {
  const infos = data?.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return null
  const mains: string[] = []
  const subs: string[] = []
  for (const it of infos) {
    if (!it || typeof it !== "object") continue
    const cur = String(it.currency ?? "")
    const main = money(cur, it.total_balance)
    if (main) mains.push(main)
    const extra: string[] = []
    const granted = money(cur, it.granted_balance)
    const topped = money(cur, it.topped_up_balance)
    if (granted) extra.push(`赠送 ${granted}`)
    if (topped) extra.push(`充值 ${topped}`)
    if (extra.length > 0) subs.push(extra.join(" · "))
  }
  if (mains.length === 0) return null
  return { text: mains.join(" · "), detail: subs.join(" · ") }
}

/** OpenRouter credits：`{ data: { total_credits, total_usage } }` → 剩余额度。 */
function parseOpenRouterCredits(data: any): Parsed | null {
  const d = data?.data ?? data
  if (!d || typeof d !== "object") return null
  if (!isNum(d.total_credits) || !isNum(d.total_usage)) return null
  const left = toNum(d.total_credits) - toNum(d.total_usage)
  return {
    text: money("USD", left.toFixed(2)),
    detail: `总额 ${money("USD", toNum(d.total_credits).toFixed(2))} · 已用 ${money("USD", toNum(d.total_usage).toFixed(2))}`,
  }
}

/** OpenRouter Key：`{ data: { usage, limit } }` → 剩余额度（limit 可能是 null = 没设上限）。 */
function parseOpenRouterKey(data: any): Parsed | null {
  const d = data?.data
  if (!d || typeof d !== "object" || !isNum(d.usage)) return null
  if (d.limit === null || d.limit === undefined) {
    return { text: `已用 ${money("USD", toNum(d.usage).toFixed(2))}`, detail: "这个 Key 没设额度上限" }
  }
  if (!isNum(d.limit)) return null
  const left = toNum(d.limit) - toNum(d.usage)
  return {
    text: money("USD", left.toFixed(2)),
    detail: `额度 ${money("USD", toNum(d.limit).toFixed(2))} · 已用 ${money("USD", toNum(d.usage).toFixed(2))}`,
  }
}

/** 金额字段名 → 中文标签（通用兜底按这个顺序找）。 */
const MONEY_KEYS: [string, string][] = [
  ["total_balance", "余额"],
  ["available_balance", "可用余额"],
  ["remaining_balance", "剩余"],
  ["balance", "余额"],
  ["remaining", "剩余"],
  ["credits_remaining", "剩余额度"],
]

/** 在返回里找某个金额字段（同一层有 currency 就带上）。深度限 4 层，别在奇怪结构里迷路。 */
function findByKey(
  node: any,
  key: string,
  depth: number,
): { value: any; currency: string } | undefined {
  if (!node || typeof node !== "object" || depth > 4) return undefined
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = findByKey(it, key, depth + 1)
      if (r) return r
    }
    return undefined
  }
  if (key in node && isNum(node[key])) {
    return { value: node[key], currency: String(node.currency ?? node.currency_code ?? "") }
  }
  for (const k of Object.keys(node)) {
    const r = findByKey(node[k], key, depth + 1)
    if (r) return r
  }
  return undefined
}

/** 通用兜底：硅基流动 / Moonshot / 各种自成一派的接口，按字段名硬找。 */
function parseKnownKeys(data: any): Parsed | null {
  if (!data || typeof data !== "object") return null
  for (const [key, label] of MONEY_KEYS) {
    const hit = findByKey(data, key, 0)
    if (!hit) continue
    const text = money(hit.currency, hit.value)
    if (!text) continue
    return { text, detail: label === "余额" ? "" : label }
  }
  return null
}

/** 一次解析：先认各家专属形状，再通用兜底。 */
function parseAny(data: any): Parsed | null {
  return (
    parseDeepSeek(data) ??
    parseOpenRouterCredits(data) ??
    parseOpenRouterKey(data) ??
    parseKnownKeys(data)
  )
}

/** 取 `https://host[:port]`（不靠 URL 构造函数，JS 环境里不一定有）。 */
function originOf(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url)
  return m ? m[1] : ""
}

/** 候选端点：供应商最可能的排前面，重复的去掉。 */
function candidatesFor(baseUrl: string): string[] {
  const clean = baseUrl.replace(/\/+$/, "")
  const origin = originOf(clean)
  const list: string[] = []
  const push = (u: string) => {
    if (u && u.startsWith("http") && list.indexOf(u) < 0) list.push(u)
  }
  push(origin + "/user/balance") // DeepSeek
  push(origin + "/api/v1/credits") // OpenRouter
  push(origin + "/api/v1/auth/key") // OpenRouter（Key 自己的额度）
  push(origin + "/v1/user/info") // 硅基流动
  push(origin + "/v1/users/me/balance") // Moonshot
  push(clean + "/user/balance")
  push(clean + "/credits")
  return list
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

/**
 * 查余额：拿设置页「模型接口」那一栏的地址和 Key，把候选端点挨个试一遍。
 *
 * 只要有一个端点返回 200 且响应里能解析出金额就返回成功；
 * 全都不行就返回 `ok:false` + 每条端点各自为什么不行（用户能照着排查）。
 */
export async function queryBalance(baseUrlRaw: string, apiKey: string): Promise<BalanceResult> {
  const baseUrl = String(baseUrlRaw ?? "").trim()
  const key = String(apiKey ?? "").trim()
  if (!baseUrl) {
    return { ok: false, text: "", detail: "", source: "", error: "先填「接口地址」，比如 https://api.deepseek.com" }
  }

  const tried: string[] = []
  for (const url of candidatesFor(baseUrl)) {
    const short = url.replace(/^https?:\/\//, "")
    try {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (key) headers.Authorization = "Bearer " + key
      const resp = await withTimeout(fetch(url, { headers }), BALANCE_TIMEOUT_MS, "查询余额")
      if (!resp.ok) {
        tried.push(`${short} → HTTP ${resp.status}`)
        continue
      }
      const text = await resp.text()
      let data: any = null
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
      const parsed = data ? parseAny(data) : null
      if (!parsed) {
        tried.push(`${short} → 返回里没有金额字段`)
        continue
      }
      return { ok: true, text: parsed.text, detail: parsed.detail, source: short }
    } catch (e: any) {
      tried.push(`${short} → ${String(e?.message ?? e)}`)
    }
  }

  return {
    ok: false,
    text: "",
    detail: "",
    source: "",
    error: [
      "这个接口没给出余额。已经试过：",
      ...tried,
      "",
      "余额查询不在 OpenAI 兼容协议里，只有服务商自己实现（DeepSeek / OpenRouter / 硅基流动 / Moonshot 有）；中转站多半查不到 —— 这种情况只能上服务商官网看。",
    ].join("\n"),
  }
}
