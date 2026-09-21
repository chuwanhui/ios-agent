/**
 * 本地知识库（离线、纯 JS，不依赖任何端上模型 / 付费能力）。
 *
 * 导入：把资料丢进「文件」App → 我的 iPhone → Scripting → 知识库，
 * 然后在设置页点「扫描并导入」。导入时就把文本切好片存进索引，
 * 原始文件会被移到同目录下的「已导入」，避免重复导入。
 *
 * 检索：中文按 bigram（双字）+ 英文按单词建倒排，BM25 排序，
 * 再对「整句原样命中」加分。全部在主线程里做，几千个片段也就几十毫秒。
 */

/** 用户丢资料的目录（在「文件」App 里可见）。 */
export const KB_INBOX = FileManager.documentsDirectory + "/知识库"
/** 导入完成的资料归档目录。 */
export const KB_DONE = KB_INBOX + "/已导入"

const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
const KB_DIR = AGENT_DIR + "/kb"
const KB_FILE = KB_DIR + "/index.json"

export interface KbChunk {
  id: string
  docId: string
  title: string
  text: string
}

export interface KbDoc {
  id: string
  title: string
  source: string
  chars: number
  chunks: number
  addedAt: number
}

export interface KbIndex {
  version: number
  docs: KbDoc[]
  chunks: KbChunk[]
  updatedAt: number
}

export interface KbHit {
  title: string
  text: string
  score: number
}

export interface KbImportResult {
  added: KbDoc[]
  skipped: string[]
  errors: string[]
}

const CHUNK_TARGET = 500
const CHUNK_MAX = 900
const TEXT_EXT = ["txt", "text", "md", "markdown", "json", "csv", "log"]
const K1 = 1.2
const B = 0.7

function emptyIndex(): KbIndex {
  return { version: 1, docs: [], chunks: [], updatedAt: 0 }
}

// —— 索引读写（带进程内缓存） ——

let cache: KbIndex | null = null
let termMemo = new Map<string, Map<string, number>>()

export function loadKbIndex(force = false): KbIndex {
  if (cache && !force) return cache
  let idx = emptyIndex()
  try {
    if (FileManager.existsSync(KB_FILE)) {
      const parsed = JSON.parse(FileManager.readAsStringSync(KB_FILE)) as KbIndex
      if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.docs)) {
        idx = {
          version: 1,
          docs: parsed.docs,
          chunks: parsed.chunks,
          updatedAt: parsed.updatedAt ?? 0,
        }
      }
    }
  } catch {
    idx = emptyIndex()
  }
  cache = idx
  termMemo = new Map()
  return idx
}

export function saveKbIndex(idx: KbIndex): void {
  idx.updatedAt = Date.now()
  try {
    FileManager.createDirectorySync(KB_DIR, true)
    FileManager.writeAsStringSync(KB_FILE, JSON.stringify(idx))
  } catch {
    // 写不进去也不该让对话崩掉
  }
  cache = idx
  termMemo = new Map()
}

export function kbStats(): { docs: number; chunks: number; chars: number } {
  const idx = loadKbIndex()
  let chars = 0
  for (const d of idx.docs) chars += d.chars
  return { docs: idx.docs.length, chunks: idx.chunks.length, chars }
}

// —— 分词 / 切片 ——

/** 中文 bigram + 英文数字单词。不依赖 NaturalLanguage（那是付费能力）。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = (text ?? "").toLowerCase()
  const latin = lower.match(/[a-z0-9]+/g) ?? []
  for (const w of latin) {
    if (w.length > 1) out.push(w)
  }
  const cjk = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

function splitSentences(text: string): string[] {
  const out: string[] = []
  const breaks = "。！？；!?;\n"
  let buf = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (breaks.indexOf(ch) >= 0) {
      out.push(buf)
      buf = ""
    }
  }
  if (buf) out.push(buf)
  return out
}

/** 把整篇文本切成「约 500 字一段」的片段，长段落按句子边界切。 */
export function chunkText(text: string): string[] {
  const norm = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!norm) return []

  const chunks: string[] = []
  const paras = norm.split(/\n{2,}/)
  let cur = ""
  const flush = () => {
    const t = cur.trim()
    if (t) chunks.push(t)
    cur = ""
  }

  for (const raw of paras) {
    const p = raw.trim()
    if (!p) continue
    if (p.length > CHUNK_MAX) {
      flush()
      let buf = ""
      for (const s of splitSentences(p)) {
        if (buf.length > 0 && buf.length + s.length > CHUNK_TARGET) {
          chunks.push(buf.trim())
          buf = ""
        }
        buf += s
        if (buf.length >= CHUNK_MAX) {
          chunks.push(buf.trim())
          buf = ""
        }
      }
      if (buf.trim()) chunks.push(buf.trim())
      continue
    }
    if (cur.length > 0 && cur.length + p.length + 1 > CHUNK_TARGET) flush()
    cur += (cur ? "\n" : "") + p
  }
  flush()
  return chunks.filter((c) => c.trim().length > 0)
}

// —— 导入 ——

function extOf(path: string): string {
  const i = path.lastIndexOf(".")
  return i < 0 ? "" : path.slice(i + 1).toLowerCase()
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 列目录，统一返回**完整路径**。
 * 坑：`FileManager.readDirectorySync` 实际返回的是纯文件名（不是文档里写的完整路径），
 * 拿去 isDirectorySync / readAsStringSync 会按当前目录解析而失败，必须自己拼。
 */
function ls(dir: string): string[] {
  let names: string[] = []
  try {
    names = FileManager.readDirectorySync(dir)
  } catch {
    return []
  }
  const d = dir.replace(/\/+$/, "")
  return names.map((n) => (n.startsWith("/") || n.indexOf("/") >= 0 ? n : d + "/" + n))
}

async function readDocText(path: string): Promise<string | null> {
  const ext = extOf(path)
  if (ext === "pdf") {
    try {
      const doc = PDFDocument.fromFilePath(path)
      if (!doc || doc.isLocked) return null
      const s = await doc.string
      return s ?? null
    } catch {
      return null
    }
  }
  if (TEXT_EXT.indexOf(ext) < 0) return null
  try {
    return FileManager.readAsStringSync(path)
  } catch {
    return null
  }
}

function uniqueName(dir: string, name: string): string {
  if (!FileManager.existsSync(dir + "/" + name)) return name
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let i = 2
  while (FileManager.existsSync(`${dir}/${stem}-${i}${ext}`)) i += 1
  return `${stem}-${i}${ext}`
}

function rand36(len: number): string {
  return Math.random().toString(36).slice(2, 2 + len)
}

/**
 * 扫描「知识库」目录，把支持的文件读成文本、切片、写进索引，
 * 然后把源文件移到「已导入」。
 */
export async function importKbInbox(
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  try {
    FileManager.createDirectorySync(KB_DONE, true)
  } catch {
    // ignore
  }

  const idx = loadKbIndex(true)
  const paths = ls(KB_INBOX).sort()

  for (const p of paths) {
    const name = baseName(p)
    if (name.startsWith(".")) continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) continue

    onProgress?.(`正在读取「${name}」…`)
    let text: string | null = null
    try {
      text = await readDocText(p)
    } catch (e: any) {
      res.errors.push(`${name}：${e?.message ?? "读取失败"}`)
      continue
    }
    if (text == null) {
      res.skipped.push(`${name}（不支持的格式，只支持 txt/md/json/csv/log/pdf）`)
      continue
    }
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      res.skipped.push(`${name}（没提取到文字，扫描版 PDF 需要一个字一个字的识别，暂时不支持）`)
      continue
    }

    const docId = "d" + Date.now().toString(36) + rand36(4)
    const title = name.replace(/\.[^.]+$/, "")
    for (let i = 0; i < chunks.length; i++) {
      idx.chunks.push({ id: `${docId}_${i}`, docId, title, text: chunks[i] })
    }
    const doc: KbDoc = {
      id: docId,
      title,
      source: name,
      chars: text.length,
      chunks: chunks.length,
      addedAt: Date.now(),
    }
    idx.docs.push(doc)
    res.added.push(doc)

    try {
      FileManager.renameSync(p, KB_DONE + "/" + uniqueName(KB_DONE, name))
    } catch {
      // 移动失败不影响导入结果
    }
  }

  saveKbIndex(idx)
  return res
}

export function deleteKbDoc(docId: string): void {
  const idx = loadKbIndex(true)
  idx.docs = idx.docs.filter((d) => d.id !== docId)
  idx.chunks = idx.chunks.filter((c) => c.docId !== docId)
  saveKbIndex(idx)
}

export function clearKb(): void {
  saveKbIndex(emptyIndex())
}

// —— 检索（BM25） ——

function chunkTerms(c: KbChunk): Map<string, number> {
  const hit = termMemo.get(c.id)
  if (hit) return hit
  const m = new Map<string, number>()
  const tokens = tokenize(c.title + "。 " + c.text)
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  termMemo.set(c.id, m)
  return m
}

/** 返回最相关的若干片段（按相关度降序）。没有任何命中时返回空数组。 */
export function searchKb(query: string, topK = 5): KbHit[] {
  const idx = loadKbIndex()
  const q = (query ?? "").trim()
  if (!q || idx.chunks.length === 0) return []

  const qTerms = Array.from(new Set(tokenize(q)))
  if (qTerms.length === 0) return []

  const N = idx.chunks.length
  const terms: Array<Map<string, number>> = []
  const lens: number[] = []
  const df = new Map<string, number>()
  let total = 0

  for (const c of idx.chunks) {
    const m = chunkTerms(c)
    terms.push(m)
    let len = 0
    m.forEach((v) => {
      len += v
    })
    lens.push(len)
    total += len
    for (const t of qTerms) {
      if (m.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const avg = total / N || 1
  const low = q.toLowerCase()

  const hits: KbHit[] = []
  for (let i = 0; i < N; i++) {
    const m = terms[i]
    const len = lens[i] || 1
    let score = 0
    for (const t of qTerms) {
      const f = m.get(t)
      if (!f) continue
      const dfi = df.get(t) ?? 0
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5))
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / avg))
    }
    // 整句原样出现 = 强信号
    if (score > 0 && idx.chunks[i].text.toLowerCase().indexOf(low) >= 0) score += 3
    if (score > 0) {
      hits.push({ title: idx.chunks[i].title, text: idx.chunks[i].text, score })
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, Math.max(1, topK))
}

/** 把检索结果拼成给模型看的文本。 */
export function formatKbHits(query: string, hits: KbHit[]): string {
  if (hits.length === 0) {
    return `知识库里没有找到和「${query}」相关的内容。可以告诉用户知识库里没有这份资料，不要凭空回答。`
  }
  const parts = hits.map(
    (h, i) => `【${i + 1}】来源：${h.title}\n${h.text}`,
  )
  return `知识库检索「${query}」命中 ${hits.length} 段：\n\n${parts.join("\n\n")}\n\n（以上是知识库原文，回答时以它为准并说明来源文件。）`
}
