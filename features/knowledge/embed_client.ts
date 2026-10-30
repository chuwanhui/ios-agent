/**
 * 向量（embedding）客户端：只认 OpenAI 兼容的 `POST {接口地址}{路径}` + Bearer Key。
 *
 * 为什么走远程：Scripting 里没有端上 ML 推理运行时（CoreML / ONNX 都没暴露），
 * 端上那套 `NaturalLanguage.*` 又是付费门禁（碰一下会弹升级提示），
 * 所以「语义检索」只能调远程向量服务。**没配就完全退回本机纯 JS 的 BM25**，功能不受影响。
 *
 * 兼容的返回格式：`{data:[{embedding:[…]}]}`（OpenAI / 硅基流动 / 智谱 …）、
 * `{embeddings:[[…]]}`、以及裸的 `[[…]]`（text-embeddings-inference）。
 */

import { fetch } from "scripting"

export interface EmbedSettings {
  enabled: boolean
  baseUrl: string
  path: string
  apiKey: string
  model: string
}

export const DEFAULT_EMBED_PATH = "/embeddings"
/** 一次请求最多塞几条文本（各家上限不同，16 条 × 约 500 字很安全）。 */
export const EMBED_BATCH = 16
/** 查询侧超时短一些：知识库检索不该让人干等。 */
export const QUERY_TIMEOUT_MS = 12000
/** 建索引是批量任务，可以慢一点。 */
export const BULK_TIMEOUT_MS = 40000

/** 从智能体配置里取出向量服务设置。 */
export function embedSettingsOf(cfg: any): EmbedSettings {
  return {
    enabled: !!cfg?.embedEnabled,
    baseUrl: String(cfg?.embedBaseUrl ?? "").trim(),
    path: String(cfg?.embedPath ?? "").trim() || DEFAULT_EMBED_PATH,
    apiKey: String(cfg?.embedApiKey ?? "").trim(),
    model: String(cfg?.embedModel ?? "").trim(),
  }
}

/** 三项都填了才算可用；toggle 关掉一律当作没配。 */
export function embedReady(s: EmbedSettings): boolean {
  return !!s.enabled && !!s.baseUrl && !!s.model
}

export function embedEndpoint(s: EmbedSettings): string {
  return s.baseUrl.replace(/\/+$/, "") + "/" + (s.path || DEFAULT_EMBED_PATH).replace(/^\/+/, "")
}

/**
 * E5 系列要求给查询加 `query:`、给资料加 `passage:`，否则效果明显掉；
 * 其它模型（bge / text-embedding-3 / jina …）不加前缀。
 */
export function prefixFor(model: string, kind: "query" | "passage"): string {
  if (!/(^|[\/_.-])e5([\/_.-]|$)/i.test(model ?? "")) return ""
  return kind === "query" ? "query: " : "passage: "
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

/** 三种常见返回格式 → 向量数组（顺序按 index 排好；没有 index 就按返回顺序）。 */
function unwrapEmbeddings(data: any): number[][] {
  let rows: any[] = []
  if (Array.isArray(data?.data)) rows = data.data
  else if (Array.isArray(data?.embeddings)) rows = data.embeddings
  else if (Array.isArray(data)) rows = data

  let indexed = rows.length > 1
  for (let i = 0; i < rows.length; i++) {
    if (typeof rows[i]?.index !== "number") {
      indexed = false
      break
    }
  }
  if (indexed) rows = rows.slice().sort((a, b) => a.index - b.index)

  const out: number[][] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const vec = Array.isArray(row) ? row : Array.isArray(row?.embedding) ? row.embedding : null
    if (vec && vec.length > 0 && typeof vec[0] === "number") out.push(vec as number[])
  }
  return out
}

/** 一批文本 → 一批向量（长度和顺序与输入一致）。HTTP 错误会带上 `httpStatus`。 */
export async function embedTexts(
  texts: string[],
  s: EmbedSettings,
  kind: "query" | "passage" = "passage",
  timeoutMs: number = BULK_TIMEOUT_MS,
): Promise<number[][]> {
  if (!embedReady(s)) throw new Error("没配置向量服务（设置 → 知识库语义检索）")
  if (texts.length === 0) return []

  const input: string[] = []
  for (let i = 0; i < texts.length; i++) input.push(prefixFor(s.model, kind) + (texts[i] ?? ""))

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (s.apiKey) headers.Authorization = "Bearer " + s.apiKey

  const resp: any = await withTimeout(
    fetch(embedEndpoint(s), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: s.model, input }),
    }),
    timeoutMs,
    "调用向量服务",
  )

  if (!resp.ok) {
    let detail = ""
    try {
      detail = String(await resp.text()).trim().slice(0, 300)
    } catch {
      // 读不出来就算了
    }
    const hint =
      resp.status === 401 || resp.status === 403
        ? "（鉴权失败：检查向量服务的 Key）"
        : resp.status === 404
          ? "（地址不对：接口地址 + 路径要能拼出 …/embeddings）"
          : resp.status === 400
            ? "（参数被拒：确认模型名在这个服务上存在）"
            : ""
    const err: any = new Error(`向量服务 HTTP ${resp.status}${hint}${detail ? "：" + detail : ""}`)
    err.httpStatus = resp.status
    throw err
  }

  let data: any = null
  try {
    data = await resp.json()
  } catch {
    throw new Error("向量服务返回的不是 JSON")
  }
  const vectors = unwrapEmbeddings(data)
  if (vectors.length !== input.length) {
    const detail = data?.error?.message ? "：" + String(data.error.message).slice(0, 200) : ""
    throw new Error(`向量服务返回 ${vectors.length} 条向量，预期 ${input.length} 条${detail}`)
  }
  return vectors
}

export interface EmbedManyOptions {
  batch?: number
  timeoutMs?: number
  /** (已完成条数, 总条数) */
  onProgress?: (done: number, total: number) => void
}

/** 分批发（每批 `EMBED_BATCH` 条），任何一批失败就整体抛出。 */
export async function embedMany(
  texts: string[],
  s: EmbedSettings,
  kind: "query" | "passage" = "passage",
  opts: EmbedManyOptions = {},
): Promise<number[][]> {
  const size = Math.max(1, Math.floor(opts.batch ?? EMBED_BATCH))
  const timeoutMs = opts.timeoutMs ?? BULK_TIMEOUT_MS
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += size) {
    const slice = texts.slice(i, i + size)
    const vecs = await embedTexts(slice, s, kind, timeoutMs)
    for (let j = 0; j < vecs.length; j++) out.push(vecs[j])
    opts.onProgress?.(Math.min(texts.length, i + slice.length), texts.length)
  }
  return out
}
