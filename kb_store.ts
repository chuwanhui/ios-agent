/**
 * 本地知识库（离线、纯 JS，不依赖任何端上模型 / 付费能力）。
 *
 * 导入：把资料丢进「文件」App → 我的 iPhone → Scripting → 知识库，
 * 然后在设置页点「扫描并导入」。导入时就把文本切好片存进索引，
 * 原始文件会被移到同目录下的「已导入」，避免重复导入。
 *
 * 检索：中文按 bigram（双字）+ 英文按单词建倒排，BM25 排序，
 * 再对「整句原样命中」加分。全部在主线程里做，几千个片段也就几十毫秒。
 *
 * 可选的语义检索：配了远程向量服务（见 `embed_client.ts`）后，可以把每个片段
 * 预先算好的向量存在 `kb/vectors.json`，检索时 BM25 与向量余弦各自归一后加权融合
 * （任意一边没命中都能被另一边拉上来）。没配就完全是上面那套离线关键词检索。
 */

/** 用户丢资料的目录（在「文件」App 里可见）。 */
export const KB_INBOX = FileManager.documentsDirectory + "/知识库"
/** 导入完成的资料归档目录。 */
export const KB_DONE = KB_INBOX + "/已导入"

const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
const KB_DIR = AGENT_DIR + "/kb"
const KB_FILE = KB_DIR + "/index.json"
const KB_VECTORS = KB_DIR + "/vectors.json"
export { KB_VECTORS }

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
  /** `folder:<书签名>` = 来自外挂文件夹；空 = 从「知识库」文件夹导入的。 */
  origin?: string
  /** 外挂文件夹里的原始路径（只读，不动原文件）。 */
  path?: string
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
  /** 混合检索时这段是从哪边召回的（both = 关键词与向量都命中）。 */
  via?: "keyword" | "vector" | "both"
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

// —— 片段向量（可选：语义检索；向量由远程服务算，这里只存和算余弦） ——

export interface KbVectorIndex {
  version: number
  /** 建这批向量用的模型名。模型换了 = 换了套向量空间，旧向量必须重建。 */
  model: string
  /** 向量维度（384 / 768 / 1024 …）。 */
  dim: number
  /** chunkId → 量化成 -127…127 的向量。 */
  items: Record<string, number[]>
  updatedAt: number
}

function emptyVectors(): KbVectorIndex {
  return { version: 1, model: "", dim: 0, items: {}, updatedAt: 0 }
}

let vecCache: KbVectorIndex | null = null

export function loadVectors(force = false): KbVectorIndex {
  if (vecCache && !force) return vecCache
  let v = emptyVectors()
  try {
    if (FileManager.existsSync(KB_VECTORS)) {
      const parsed = JSON.parse(FileManager.readAsStringSync(KB_VECTORS)) as KbVectorIndex
      if (parsed && parsed.items && typeof parsed.items === "object") {
        v = {
          version: 1,
          model: parsed.model ?? "",
          dim: parsed.dim ?? 0,
          items: parsed.items,
          updatedAt: parsed.updatedAt ?? 0,
        }
      }
    }
  } catch {
    v = emptyVectors()
  }
  vecCache = v
  return v
}

export function saveVectors(v: KbVectorIndex): void {
  v.updatedAt = Date.now()
  try {
    FileManager.createDirectorySync(KB_DIR, true)
    FileManager.writeAsStringSync(KB_VECTORS, JSON.stringify(v))
  } catch {
    // 存不下也不该让检索/对话崩掉
  }
  vecCache = v
}

export interface KbVectorStats {
  /** 当前片段总数。 */
  total: number
  /** 已经有向量的片段数（只算还在索引里的）。 */
  embedded: number
  dim: number
  /** 存盘时用的模型名。 */
  model: string
  /** 换了模型 → 已有向量都不算数，需要重建。 */
  stale: boolean
}

export function vectorStats(model = ""): KbVectorStats {
  const idx = loadKbIndex()
  const v = loadVectors()
  let embedded = 0
  for (let i = 0; i < idx.chunks.length; i++) {
    if (v.items[idx.chunks[i].id]) embedded += 1
  }
  const stale = !!v.model && !!model && v.model !== model
  return { total: idx.chunks.length, embedded, dim: v.dim, model: v.model, stale }
}

/** 还没建向量（或换了模型需重算）的片段，按索引顺序。 */
export function chunksMissingVectors(model: string): KbChunk[] {
  const idx = loadKbIndex()
  const v = loadVectors()
  if (v.model && model && v.model !== model) return idx.chunks.slice()
  const out: KbChunk[] = []
  for (let i = 0; i < idx.chunks.length; i++) {
    if (!v.items[idx.chunks[i].id]) out.push(idx.chunks[i])
  }
  return out
}

/** 把浮点向量压成 int8：余弦只看方向，尺度会在分母里约掉，所以不用存比例。 */
export function quantize(vec: number[]): number[] {
  let max = 0
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i])
    if (a > max) max = a
  }
  const out: number[] = []
  if (!max) {
    for (let i = 0; i < vec.length; i++) out.push(0)
    return out
  }
  const k = 127 / max
  for (let i = 0; i < vec.length; i++) out.push(Math.round(vec[i] * k))
  return out
}

/** 余弦相似度（-1…1；长度不等时按短的算，正常不会发生）。 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** 存一批片段向量（模型或维度变了会先清空旧的）。 */
export function storeChunkVectors(model: string, entries: { id: string; vec: number[] }[]): void {
  if (entries.length === 0) return
  const v = loadVectors()
  const dim = entries[0].vec.length
  if (v.model && model && v.model !== model) v.items = {}
  if (v.dim && dim && v.dim !== dim) v.items = {}
  if (model) v.model = model
  if (dim) v.dim = dim
  for (let i = 0; i < entries.length; i++) v.items[entries[i].id] = quantize(entries[i].vec)
  saveVectors(v)
}

/** 丢掉已经不在索引里的片段向量（删资料后用）。 */
export function pruneVectors(): void {
  const idx = loadKbIndex()
  const alive = new Set<string>()
  for (let i = 0; i < idx.chunks.length; i++) alive.add(idx.chunks[i].id)
  const v = loadVectors()
  const keys = Object.keys(v.items)
  let changed = false
  for (let i = 0; i < keys.length; i++) {
    if (!alive.has(keys[i])) {
      delete v.items[keys[i]]
      changed = true
    }
  }
  if (changed) saveVectors(v)
}

export function clearVectors(): void {
  saveVectors(emptyVectors())
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
  pruneVectors()
}

export function clearKb(): void {
  saveKbIndex(emptyIndex())
  clearVectors()
}

// —— 导入：从「文件」App 选文件 / 挂一个外部文件夹（只读） ——

/** 外挂文件夹：书签持久化，重启后仍能读到（书签失效就要重新选一次）。 */
export interface KbFolder {
  /** 书签名（`FileManager.bookmarkedPath(bookmark)` 取回路径）。 */
  bookmark: string
  label: string
  path: string
  addedAt: number
}

const FOLDER_FILE = KB_DIR + "/folders.json"
const FOLDER_SKIP = ["node_modules", ".git", ".obsidian", ".trash", "已导入", "Library"]
const FOLDER_MAX_FILES = 300
const FOLDER_MAX_DEPTH = 5

let folderCache: KbFolder[] | null = null

export function listKbFolders(): KbFolder[] {
  if (folderCache) return folderCache
  let out: KbFolder[] = []
  try {
    if (FileManager.existsSync(FOLDER_FILE)) {
      const parsed = JSON.parse(FileManager.readAsStringSync(FOLDER_FILE))
      if (Array.isArray(parsed)) out = parsed as KbFolder[]
    }
  } catch {
    out = []
  }
  folderCache = out
  return out
}

function saveKbFolders(list: KbFolder[]): void {
  try {
    FileManager.createDirectorySync(KB_DIR, true)
    FileManager.writeAsStringSync(FOLDER_FILE, JSON.stringify(list))
  } catch {
    // ignore
  }
  folderCache = list
}

export function addKbFolder(bookmark: string, label: string, path: string): KbFolder {
  const list = listKbFolders().filter((f) => f.bookmark !== bookmark)
  const folder: KbFolder = { bookmark, label: label || bookmark, path, addedAt: Date.now() }
  list.push(folder)
  saveKbFolders(list)
  return folder
}

/** 忘掉一个外挂文件夹：连同它索引进去的资料一起删（原文件夹不动）。 */
export function removeKbFolder(bookmark: string): void {
  saveKbFolders(listKbFolders().filter((f) => f.bookmark !== bookmark))
  dropOriginDocs("folder:" + bookmark)
  try {
    FileManager.removeFileBookmark(bookmark)
  } catch {
    // ignore
  }
}

/** 删掉某个来源（外挂文件夹）上一次索引的资料。 */
function dropOriginDocs(origin: string): void {
  const idx = loadKbIndex(true)
  const dead: string[] = []
  for (const d of idx.docs) if (d.origin === origin) dead.push(d.id)
  if (dead.length === 0) return
  idx.docs = idx.docs.filter((d) => d.origin !== origin)
  idx.chunks = idx.chunks.filter((c) => dead.indexOf(c.docId) < 0)
  saveKbIndex(idx)
  pruneVectors()
}

function walkFolder(dir: string, out: string[], depth: number): void {
  if (depth > FOLDER_MAX_DEPTH || out.length >= FOLDER_MAX_FILES) return
  for (const p of ls(dir).sort()) {
    const name = baseName(p)
    if (!name || name.startsWith(".") || FOLDER_SKIP.indexOf(name) >= 0) continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) walkFolder(p, out, depth + 1)
    else out.push(p)
    if (out.length >= FOLDER_MAX_FILES) return
  }
}

/**
 * 重新索引一个外挂文件夹（只读、不动原文件）：
 * 先把它上一次索引的资料删掉，再按当前内容重建 —— 改了、删了文件都会反映过来。
 */
export async function importKbFolder(
  folder: KbFolder,
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  const root = FileManager.bookmarkedPath(folder.bookmark)
  if (!root) {
    res.errors.push(`「${folder.label}」的书签已失效，删掉重新选一次文件夹吧。`)
    return res
  }

  const idx = loadKbIndex(true)
  const origin = "folder:" + folder.bookmark
  const dead: string[] = []
  for (const d of idx.docs) if (d.origin === origin) dead.push(d.id)
  idx.docs = idx.docs.filter((d) => d.origin !== origin)
  idx.chunks = idx.chunks.filter((c) => dead.indexOf(c.docId) < 0)

  const files: string[] = []
  walkFolder(root, files, 0)
  if (files.length >= FOLDER_MAX_FILES) {
    res.skipped.push(`文件夹里文件太多，这次只索引前 ${FOLDER_MAX_FILES} 个`)
  }

  const prefix = root.replace(/\/+$/, "") + "/"
  for (const p of files) {
    const shown = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : baseName(p)
    onProgress?.(`正在读取「${shown}」…`)
    let text: string | null = null
    try {
      text = await readDocText(p)
    } catch (e: any) {
      res.errors.push(`${shown}：${e?.message ?? "读取失败"}`)
      continue
    }
    if (text == null) {
      res.skipped.push(`${shown}（格式不支持或扫描版 PDF）`)
      continue
    }
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      res.skipped.push(`${shown}（没提取到文字）`)
      continue
    }
    const docId = "d" + Date.now().toString(36) + rand36(4)
    const title = shown.replace(/\.[^.]+$/, "")
    for (let i = 0; i < chunks.length; i++) {
      idx.chunks.push({ id: `${docId}_${i}`, docId, title, text: chunks[i] })
    }
    const doc: KbDoc = {
      id: docId,
      title,
      source: `${folder.label} / ${shown}`,
      chars: text.length,
      chunks: chunks.length,
      addedAt: Date.now(),
      origin,
      path: p,
    }
    idx.docs.push(doc)
    res.added.push(doc)
  }

  saveKbIndex(idx)
  pruneVectors()
  return res
}

/** 把用户在「文件」App 选中的文件拷进「知识库」文件夹，再走一遍普通导入。 */
export async function importKbFiles(
  paths: string[],
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  try {
    FileManager.createDirectorySync(KB_INBOX, true)
  } catch {
    // ignore
  }
  let staged = 0
  for (const p of paths) {
    const name = baseName(p)
    if (!name) continue
    const ext = extOf(name)
    if (TEXT_EXT.indexOf(ext) < 0 && ext !== "pdf") {
      res.skipped.push(`${name}（不支持的格式，只支持 txt/md/json/csv/log/pdf）`)
      continue
    }
    const dest = KB_INBOX + "/" + uniqueName(KB_INBOX, name)
    try {
      await FileManager.copyFile(p, dest)
      staged += 1
    } catch (e: any) {
      res.errors.push(`${name}：拷贝失败（${e?.message ?? e}）`)
    }
  }
  if (staged === 0) return res
  onProgress?.("正在导入…")
  const done = await importKbInbox(onProgress)
  res.added.push(...done.added)
  res.skipped.push(...done.skipped)
  res.errors.push(...done.errors)
  return res
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

/**
 * BM25 原始分（与 idx.chunks 一一对应；含「整句原样命中」加分）。
 * 返回数组长度 = 片段数，没命中的片段是 0。
 */
function bm25Scores(idx: KbIndex, query: string): number[] {
  const q = (query ?? "").trim()
  const N = idx.chunks.length
  const scores: number[] = []
  for (let i = 0; i < N; i++) scores.push(0)
  if (!q || N === 0) return scores

  const qTerms = Array.from(new Set(tokenize(q)))
  if (qTerms.length === 0) return scores
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
    scores[i] = score
  }
  return scores
}

// —— 混合检索（关键词 ∪ 语义） ——

export type KbSearchMode = "bm25" | "hybrid"

export interface KbSearchResult {
  hits: KbHit[]
  mode: KbSearchMode
  /** 本该走语义、但一条向量都没有（还没建索引 / 换了模型）——已退回关键词。 */
  fellBack: boolean
}

/** 融合权重：关键词略重（专有名词、编号、日期这类靠字面命中更稳）。 */
const W_KEYWORD = 0.55
const W_VECTOR = 0.45

/**
 * 线性归一到 0..1。
 * `useMin=false` 用于 BM25（下限天然是 0）；`useMin=true` 用于余弦（分布可能整体偏高/偏低）。
 */
function normalizeTo01(values: number[], useMin: boolean): number[] {
  let min = 0
  let max = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (i === 0 || v > max) max = v
    if (i === 0 || v < min) min = v
  }
  const lo = useMin ? min : 0
  const span = max - lo
  const out: number[] = []
  for (let i = 0; i < values.length; i++) out.push(span > 1e-9 ? (values[i] - lo) / span : 0)
  return out
}

function rankBy(
  scores: number[],
  idx: KbIndex,
  signals: { keyword: number[]; hasVec: boolean[] } | null,
): KbHit[] {
  const rows: KbHit[] = []
  for (let i = 0; i < scores.length; i++) {
    if (!(scores[i] > 0)) continue
    const hit: KbHit = { title: idx.chunks[i].title, text: idx.chunks[i].text, score: scores[i] }
    if (signals) {
      const kw = signals.keyword[i] > 0
      const vec = signals.hasVec[i]
      hit.via = kw && vec ? "both" : vec ? "vector" : "keyword"
    }
    rows.push(hit)
  }
  rows.sort((a, b) => b.score - a.score)
  return rows
}

/** 纯关键词检索（没配向量服务 / 还没建向量时用）。 */
export function searchKb(query: string, topK = 5): KbHit[] {
  return searchKbHybrid(query, topK).hits
}

/**
 * 混合检索：关键词 BM25 ∪ 语义向量，两边各自归一到 0..1 后加权求和。
 * 这样「只有字面命中」和「只有语义命中」的片段都能被召回来。
 * `queryVec` 是查询文本的向量（由 `kb_embed.ts` 算好传进来）；不给就是纯 BM25。
 */
export function searchKbHybrid(query: string, topK = 5, queryVec?: number[]): KbSearchResult {
  const idx = loadKbIndex()
  const N = idx.chunks.length
  const limit = Math.max(1, topK)
  if (!(query ?? "").trim() || N === 0) return { hits: [], mode: "bm25", fellBack: false }

  const keyword = bm25Scores(idx, query)
  const useVec = !!queryVec && queryVec.length > 0
  const vecs = useVec ? loadVectors() : null
  if (!vecs) {
    return { hits: rankBy(keyword, idx, null).slice(0, limit), mode: "bm25", fellBack: false }
  }

  const dense: number[] = []
  const hasVec: boolean[] = []
  let withVec = 0
  for (let i = 0; i < N; i++) {
    const v = vecs.items[idx.chunks[i].id]
    if (v) {
      dense.push(cosine(queryVec as number[], v))
      hasVec.push(true)
      withVec += 1
    } else {
      dense.push(0)
      hasVec.push(false)
    }
  }
  if (withVec === 0) {
    return { hits: rankBy(keyword, idx, null).slice(0, limit), mode: "bm25", fellBack: true }
  }

  const kwN = normalizeTo01(keyword, false)
  const denseN = normalizeTo01(dense, true)
  const fused: number[] = []
  for (let i = 0; i < N; i++) fused.push(W_KEYWORD * kwN[i] + W_VECTOR * denseN[i])
  const hits = rankBy(fused, idx, { keyword, hasVec }).slice(0, limit)
  return { hits, mode: "hybrid", fellBack: false }
}

/** 把检索结果拼成给模型看的文本。 */
export function formatKbHits(
  query: string,
  hits: KbHit[],
  opts?: { mode?: KbSearchMode; fellBack?: boolean },
): string {
  const modeLine =
    opts?.mode === "hybrid"
      ? "\n\n（检索方式：关键词 BM25 + 语义向量混合排序。）"
      : opts?.fellBack
        ? "\n\n（语义向量这次没取到，本次已退回纯关键词检索。）"
        : ""
  if (hits.length === 0) {
    return (
      `知识库里没有找到和「${query}」相关的内容。可以告诉用户知识库里没有这份资料，不要凭空回答。` +
      modeLine
    )
  }
  const parts = hits.map((h, i) => {
    const tag = h.via === "vector" ? "语义命中" : h.via === "both" ? "关键词 + 语义命中" : ""
    return `【${i + 1}】来源：${h.title}${tag ? "（" + tag + "）" : ""}\n${h.text}`
  })
  return `知识库检索「${query}」命中 ${hits.length} 段：\n\n${parts.join(
    "\n\n",
  )}\n\n（以上是知识库原文，回答时以它为准并说明来源文件。）${modeLine}`
}
