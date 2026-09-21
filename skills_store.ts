/**
 * 上传技能（skill）：把 zip / 文件夹 / 单个 .md 丢进
 * 「文件」App → 我的 iPhone → Scripting → 技能，设置页点「扫描并导入」。
 *
 * 一个技能 = 一个含 SKILL.md 的文件夹（可以带脚本、模板等附件）。
 * SKILL.md 头部的 YAML front matter 里写 name / description。
 *
 * 用法是「渐进式披露」：系统提示里只列出技能的 name + description，
 * 模型真正要用时再调 read_skill 工具读完整说明，省 token。
 */

/** 用户丢技能包的目录（在「文件」App 里可见）。 */
export const SKILL_INBOX = FileManager.documentsDirectory + "/技能"
export const SKILL_DONE = SKILL_INBOX + "/已导入"

const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
const SKILLS_DIR = AGENT_DIR + "/skills"
const SKILL_REG_FILE = AGENT_DIR + "/skills.json"
const SKILL_FILE = "SKILL.md"

const MAX_FILES = 300
const MAX_DEPTH = 5
const MAX_FILE_CHARS = 200 * 1024

export interface SkillMeta {
  id: string
  /** front matter 里的 name，退回文件夹名 / 文件名。 */
  name: string
  description: string
  enabled: boolean
  addedAt: number
  /** 原始来源名（zip / 文件夹 / md）。 */
  source: string
  /** `skills/` 下的子目录名。 */
  dir: string
  /** 相对路径文件清单（含 SKILL.md）。 */
  files: string[]
}

interface SkillRegistry {
  version: number
  skills: SkillMeta[]
}

export interface SkillImportResult {
  added: SkillMeta[]
  skipped: string[]
  errors: string[]
}

// —— 注册表 ——

let cache: SkillRegistry | null = null

function emptyRegistry(): SkillRegistry {
  return { version: 1, skills: [] }
}

export function loadRegistry(force = false): SkillRegistry {
  if (cache && !force) return cache
  let reg = emptyRegistry()
  try {
    if (FileManager.existsSync(SKILL_REG_FILE)) {
      const parsed = JSON.parse(FileManager.readAsStringSync(SKILL_REG_FILE)) as SkillRegistry
      if (parsed && Array.isArray(parsed.skills)) {
        reg = { version: 1, skills: parsed.skills }
      }
    }
  } catch {
    reg = emptyRegistry()
  }
  cache = reg
  return reg
}

export function saveRegistry(reg: SkillRegistry): void {
  try {
    FileManager.createDirectorySync(AGENT_DIR, true)
    FileManager.writeAsStringSync(SKILL_REG_FILE, JSON.stringify(reg))
  } catch {
    // ignore
  }
  cache = reg
}

export function listSkills(): SkillMeta[] {
  return loadRegistry().skills
}

export function skillCounts(): { total: number; enabled: number } {
  const all = listSkills()
  return { total: all.length, enabled: all.filter((s) => s.enabled).length }
}

// —— front matter ——

export function parseFrontMatter(md: string): { data: Record<string, string>; body: string } {
  const data: Record<string, string> = {}
  const text = (md ?? "").replace(/\r\n?/g, "\n")
  if (!text.startsWith("---")) return { data, body: text }
  const end = text.indexOf("\n---", 3)
  if (end < 0) return { data, body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, "")
  let lastKey = ""
  for (const raw of head.split("\n")) {
    const t = raw.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf(":")
    if (i < 0) {
      if (lastKey) data[lastKey] = (data[lastKey] + " " + t).trim()
      continue
    }
    const key = t.slice(0, i).trim().toLowerCase()
    if (!key) continue
    let val = t.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (val === ">" || val === "|" || val === ">-" || val === "|-") val = ""
    data[key] = val
    lastKey = key
  }
  return { data, body }
}

function firstHeading(md: string): string {
  for (const line of (md ?? "").split("\n")) {
    const t = line.trim()
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "").trim()
  }
  return ""
}

export function skillTitleOf(md: string, fallback: string): { name: string; description: string } {
  const { data } = parseFrontMatter(md)
  const name = (data.name || firstHeading(md) || fallback || "未命名技能").slice(0, 60)
  const description = (data.description || "").slice(0, 400)
  return { name, description }
}

// —— 文件工具 ——

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 列目录，统一返回**完整路径**。
 * 坑：`FileManager.readDirectorySync` 实际返回的是纯文件名（不是文档里写的完整路径），
 * 拿去 isDirectorySync / copyFileSync / unzip 会按当前目录解析而失败，必须自己拼。
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

function extOf(path: string): string {
  const i = path.lastIndexOf(".")
  return i < 0 ? "" : path.slice(i + 1).toLowerCase()
}

function rand36(n: number): string {
  return Math.random().toString(36).slice(2, 2 + n)
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

function slugify(name: string): string {
  const ascii = (name ?? "")
    .toLowerCase()
    .replace(/\.(zip|md|markdown)$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return ascii || "skill-" + Date.now().toString(36)
}

function uniqueSlug(base: string, used: Set<string>): string {
  let slug = slugify(base)
  let i = 2
  while (used.has(slug)) {
    slug = slugify(base).slice(0, 34) + "-" + i
    i += 1
  }
  used.add(slug)
  return slug
}

function copyTree(src: string, dest: string, depth = 0, counter = { n: 0 }): string[] {
  const out: string[] = []
  if (depth > MAX_DEPTH || counter.n > MAX_FILES) return out
  try {
    FileManager.createDirectorySync(dest, true)
  } catch {
    return out
  }
  let entries = ls(src)
  for (const p of entries) {
    const name = baseName(p)
    if (!name || name === ".DS_Store" || name === "__MACOSX") continue
    counter.n += 1
    if (counter.n > MAX_FILES) break
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) {
      out.push(...copyTree(p, dest + "/" + name, depth + 1, counter))
    } else {
      try {
        FileManager.copyFileSync(p, dest + "/" + name)
        out.push(name)
      } catch {
        // 单个文件失败就跳过
      }
    }
  }
  return out
}

/** 列出目录下的相对路径（用于 SKILL.md 里引用附件）。 */
function listRelative(root: string, depth = 0, prefix = ""): string[] {
  const out: string[] = []
  if (depth > 3) return out
  const entries = ls(root)
  for (const p of entries) {
    const name = baseName(p)
    if (!name || name === ".DS_Store") continue
    const rel = prefix ? prefix + "/" + name : name
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) out.push(...listRelative(p, depth + 1, rel))
    else out.push(rel)
    if (out.length > 80) break
  }
  return out
}

/** 在读到的文本里找 SKILL.md（大小写不敏感）。 */
function findSkillFile(dir: string): string | null {
  for (const p of ls(dir)) {
    if (baseName(p).toLowerCase() === SKILL_FILE.toLowerCase()) return p
  }
  return null
}

/** 压缩包解开后，找出真正的技能根目录（含 SKILL.md 的那一层）。 */
function findSkillRoot(dir: string, depth = 0): string | null {
  if (findSkillFile(dir)) return dir
  if (depth >= 2) return null
  const entries = ls(dir)
  for (const p of entries) {
    const name = baseName(p)
    if (!name || name === "__MACOSX" || name.startsWith(".")) continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (!isDir) continue
    const hit = findSkillRoot(p, depth + 1)
    if (hit) return hit
  }
  return null
}

function readText(path: string): string {
  try {
    if (FileManager.statSync(path).size > MAX_FILE_CHARS) {
      return FileManager.readAsStringSync(path).slice(0, MAX_FILE_CHARS)
    }
    return FileManager.readAsStringSync(path)
  } catch {
    return ""
  }
}

// —— 导入 ——

/**
 * 扫描「技能」目录：
 *   - 含 SKILL.md 的文件夹 → 整个复制进 skills/
 *   - .zip（解开后能找到 SKILL.md）→ 同上
 *   - 单个 .md（带 name/description 的 YAML 头）→ 当成只有 SKILL.md 的技能
 * 处理完的来源会移到「已导入」。
 */
export async function importSkills(
  onProgress?: (text: string) => void,
): Promise<SkillImportResult> {
  const res: SkillImportResult = { added: [], skipped: [], errors: [] }
  const reg = loadRegistry(true)
  const used = new Set<string>(reg.skills.map((s) => s.dir))

  try {
    FileManager.createDirectorySync(SKILLS_DIR, true)
    FileManager.createDirectorySync(SKILL_DONE, true)
  } catch {
    // ignore
  }

  const entries = ls(SKILL_INBOX).sort()

  for (const p of entries) {
    const name = baseName(p)
    if (!name || name.startsWith(".") || name === "已导入") continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    const ext = extOf(name)

    onProgress?.(`正在处理「${name}」…`)
    try {
      if (isDir) {
        installFromDir(p, name, reg, used, res)
      } else if (ext === "zip") {
        const tmp = FileManager.temporaryDirectory + "/skill_" + Date.now().toString(36) + rand36(3)
        try {
          await FileManager.unzip(p, tmp)
        } catch (e: any) {
          res.errors.push(`${name}：解压失败（${e?.message ?? "不是有效的 zip"}）`)
          continue
        }
        const root = findSkillRoot(tmp)
        if (!root) {
          res.skipped.push(`${name}（压缩包里没找到 SKILL.md）`)
          continue
        }
        installFromDir(root, name.replace(/\.zip$/i, ""), reg, used, res)
        try {
          FileManager.removeSync(tmp)
        } catch {
          // ignore
        }
      } else if (ext === "md" || ext === "markdown") {
        installFromMarkdown(p, name, reg, used, res)
      } else {
        res.skipped.push(`${name}（只支持文件夹 / .zip / 单个 .md）`)
        continue
      }

      try {
        FileManager.renameSync(p, SKILL_DONE + "/" + uniqueName(SKILL_DONE, name))
      } catch {
        // 移动失败不影响导入
      }
    } catch (e: any) {
      res.errors.push(`${name}：${e?.message ?? "导入失败"}`)
    }
  }

  saveRegistry(reg)
  return res
}

function installFromDir(
  srcDir: string,
  label: string,
  reg: SkillRegistry,
  used: Set<string>,
  res: SkillImportResult,
): void {
  const skillFile = findSkillFile(srcDir)
  if (!skillFile) {
    res.skipped.push(`${baseName(srcDir)}（文件夹里没有 SKILL.md）`)
    return
  }
  const md = readText(skillFile)
  const { name, description } = skillTitleOf(md, label)
  const slug = uniqueSlug(name, used)
  const dest = SKILLS_DIR + "/" + slug
  const copied = copyTree(srcDir, dest)
  const files = listRelative(dest)
  const meta: SkillMeta = {
    id: "k" + Date.now().toString(36) + rand36(4),
    name,
    description,
    enabled: true,
    addedAt: Date.now(),
    source: baseName(srcDir),
    dir: slug,
    files: files.length > 0 ? files : copied,
  }
  reg.skills.push(meta)
  res.added.push(meta)
}

function installFromMarkdown(
  srcFile: string,
  fileName: string,
  reg: SkillRegistry,
  used: Set<string>,
  res: SkillImportResult,
): void {
  const md = readText(srcFile)
  const { data } = parseFrontMatter(md)
  if (!data.name && !data.description) {
    res.skipped.push(`${fileName}（不是技能文件：YAML 头里缺 name / description）`)
    return
  }
  const fallback = fileName.replace(/\.(md|markdown)$/i, "")
  const { name, description } = skillTitleOf(md, fallback)
  const slug = uniqueSlug(name, used)
  const dest = SKILLS_DIR + "/" + slug
  try {
    FileManager.createDirectorySync(dest, true)
    FileManager.copyFileSync(srcFile, dest + "/" + SKILL_FILE)
  } catch (e: any) {
    res.errors.push(`${fileName}：写入失败（${e?.message ?? "未知错误"}）`)
    return
  }
  const meta: SkillMeta = {
    id: "k" + Date.now().toString(36) + rand36(4),
    name,
    description,
    enabled: true,
    addedAt: Date.now(),
    source: fileName,
    dir: slug,
    files: [SKILL_FILE],
  }
  reg.skills.push(meta)
  res.added.push(meta)
}

// —— 使用 / 维护 ——

export function skillDirOf(meta: SkillMeta): string {
  return SKILLS_DIR + "/" + meta.dir
}

function norm(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, "")
}

export function findSkill(idOrName: string): SkillMeta | null {
  const all = listSkills()
  const key = (idOrName ?? "").trim()
  if (!key) return null
  for (const s of all) if (s.id === key) return s
  for (const s of all) if (norm(s.name) === norm(key)) return s
  for (const s of all) if (norm(s.dir) === norm(key)) return s
  for (const s of all) {
    if (norm(s.name).indexOf(norm(key)) >= 0 && norm(key).length >= 2) return s
  }
  return null
}

/** 读出技能完整说明 + 附件清单（给 read_skill 工具用）。 */
export function readSkill(
  idOrName: string,
): { meta: SkillMeta; content: string; files: string[] } | null {
  const meta = findSkill(idOrName)
  if (!meta) return null
  const dir = skillDirOf(meta)
  const skillFile = findSkillFile(dir)
  const content = skillFile ? readText(skillFile) : ""
  return { meta, content, files: listRelative(dir) }
}

export function deleteSkill(id: string): void {
  const reg = loadRegistry(true)
  const hit = reg.skills.find((s) => s.id === id)
  if (hit) {
    try {
      FileManager.removeSync(skillDirOf(hit))
    } catch {
      // ignore
    }
  }
  reg.skills = reg.skills.filter((s) => s.id !== id)
  saveRegistry(reg)
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  const reg = loadRegistry(true)
  for (const s of reg.skills) if (s.id === id) s.enabled = enabled
  saveRegistry(reg)
}

/**
 * 渐进式披露：只在系统提示里列出技能名 + 描述，
 * 模型要用时再调 read_skill 读全文。没有可用技能时返回 null。
 */
export function skillsPrompt(): string | null {
  const list = listSkills().filter((s) => s.enabled)
  if (list.length === 0) return null
  const lines = list.map((s) => {
    const desc = s.description ? s.description.replace(/\s+/g, " ").slice(0, 200) : "（没有写描述）"
    return `- ${s.name}：${desc}`
  })
  return (
    "用户上传了这些技能（skill）。它们是一份份操作说明，需要时**先**用 read_skill 工具读出完整步骤，" +
    "再照着做；不要凭技能名猜测内容。\n" +
    lines.join("\n")
  )
}

/** 技能在系统提示里占的字符数（用于设置页展示）。 */
export function skillsPromptSize(): number {
  const p = skillsPrompt()
  return p ? p.length : 0
}
