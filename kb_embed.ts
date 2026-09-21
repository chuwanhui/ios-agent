/**
 * 知识库「语义检索」的接线层：配置（`agent_store`）↔ 向量服务（`embed_client`）↔ 片段（`kb_store`）。
 *
 * 刻意独立成一个文件，好处是：
 *  1. `kb_store.ts` 完全不发网络请求（离线可用、可单独测试）；
 *  2. 检索链路（`agent_core`）只依赖这里的两个口子：`embedQueryVector` / `buildKbVectors`。
 *
 * 设计取向：**语义检索是锦上添花，任何失败都必须静默退回关键词检索**，
 * 绝不能让「向量服务挂了」变成「知识库不能用」。
 */

import {
  EMBED_BATCH,
  QUERY_TIMEOUT_MS,
  embedReady,
  embedSettingsOf,
  embedTexts,
  type EmbedSettings,
} from "./embed_client"
import {
  clearVectors,
  chunksMissingVectors,
  kbStats,
  pruneVectors,
  storeChunkVectors,
  vectorStats,
  type KbChunk,
  type KbVectorStats,
} from "./kb_store"
import { loadConfig } from "./agent_store"

/** 出过一次错就歇 60 秒（不然服务挂掉时每次提问都要干等一个超时）。 */
const FAIL_CACHE_MS = 60000

let failUntil = 0
let lastError = ""

export function embedLastError(): string {
  return lastError
}

export function embedCoolingDown(): boolean {
  return Date.now() < failUntil
}

export function embedSettings(): EmbedSettings {
  return embedSettingsOf(loadConfig())
}

/** 语义检索现在能不能用（开关开了 + 三个字段都填了）。 */
export function kbSemanticEnabled(): boolean {
  return embedReady(embedSettings())
}

/**
 * 混合检索是否真的会生效：配置好了，而且至少有一部分片段有（当前模型的）向量。
 * 用来决定工具描述里写不写「支持语义检索」。
 */
export function kbSemanticReady(): boolean {
  const s = embedSettings()
  if (!embedReady(s)) return false
  const st = vectorStats(s.model)
  return !st.stale && st.embedded > 0
}

export function kbVectorStatus(): KbVectorStats {
  return vectorStats(embedSettings().model)
}

/** 片段送去做向量的文本：带上标题、空格隔开，检索时「标题里的词」也能召回到。 */
function chunkEmbedText(chunk: KbChunk): string {
  return (chunk.title ? chunk.title + " " : "") + chunk.text
}

/**
 * 查询文本 → 向量。失败 / 没配 / 向量还没建 → `undefined`（调用方退回纯 BM25）。
 */
export async function embedQueryVector(query: string): Promise<number[] | undefined> {
  const q = (query ?? "").trim()
  if (!q) return undefined
  const s = embedSettings()
  if (!embedReady(s)) return undefined

  const st = vectorStats(s.model)
  if (st.stale || st.embedded === 0) return undefined
  if (Date.now() < failUntil) return undefined

  try {
    const vecs = await embedTexts([q], s, "query", QUERY_TIMEOUT_MS)
    failUntil = 0
    lastError = ""
    return vecs[0]
  } catch (e: any) {
    lastError = String(e?.message ?? e)
    failUntil = Date.now() + FAIL_CACHE_MS
    return undefined
  }
}

export interface KbBuildResult {
  /** 这次新算了几段。 */
  embedded: number
  /** 需要算的总段数（0 = 已经全部建好）。 */
  total: number
  dim: number
  seconds: number
  model: string
}

/** (已完成, 总数)，用于界面上的进度文案。 */
export type KbBuildProgress = (done: number, total: number) => void

/**
 * 给缺向量的片段补上向量（增量：已经有的不重算）。
 * 配置不对 / 服务报错会**抛出**，由界面显示给用户；每次都成功一小批就落盘一次，
 * 所以中途断网也不会白干。
 */
export async function buildKbVectors(onProgress?: KbBuildProgress): Promise<KbBuildResult> {
  const s = embedSettings()
  if (!embedReady(s)) throw new Error("先打开「知识库语义检索」，并填好接口地址与向量模型。")

  const all = kbStats().chunks
  const missing = chunksMissingVectors(s.model)
  if (all === 0) throw new Error("知识库还是空的，先导入资料再建向量。")
  if (missing.length === 0) {
    const st = vectorStats(s.model)
    return { embedded: 0, total: 0, dim: st.dim, seconds: 0, model: s.model }
  }

  onProgress?.(0, missing.length)
  const t0 = Date.now()
  let done = 0
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const slice = missing.slice(i, i + EMBED_BATCH)
    const inputs: string[] = []
    for (let j = 0; j < slice.length; j++) inputs.push(chunkEmbedText(slice[j]))
    const vecs = await embedTexts(inputs, s, "passage")
    const entries: { id: string; vec: number[] }[] = []
    for (let j = 0; j < slice.length; j++) {
      if (vecs[j] && vecs[j].length > 0) entries.push({ id: slice[j].id, vec: vecs[j] })
    }
    storeChunkVectors(s.model, entries)
    done += slice.length
    onProgress?.(done, missing.length)
  }
  pruneVectors()
  const st = vectorStats(s.model)
  return {
    embedded: done,
    total: missing.length,
    dim: st.dim,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    model: s.model,
  }
}

/** 换了模型 / 想重算时用：清掉全部向量（片段本身不动）。 */
export function dropKbVectors(): void {
  clearVectors()
}

/** 导入资料后自动补向量（开关开着才做；失败只返回错误文案，不打断导入流程）。 */
export async function autoEmbedAfterImport(
  onProgress?: KbBuildProgress,
): Promise<string | undefined> {
  if (!kbSemanticEnabled()) return undefined
  try {
    const r = await buildKbVectors(onProgress)
    return r.embedded > 0 ? `已为 ${r.embedded} 段新内容生成向量` : undefined
  } catch (e: any) {
    return "向量生成失败：" + String(e?.message ?? e)
  }
}
