/**
 * 智能体的「手脚」：文件读写 / 命令行 / 技能脚本执行 / 技能创建 / 快捷指令工具配置。
 *
 * 这一层只做两件事：
 *   ① `capabilitiesFor(cfg)` —— 按设置页的开关，告诉 agent_core 现在该挂哪些工具；
 *   ② 每个工具的 `run(args)` —— 真正干活，返回一段给模型看的文本（外加过程卡片的元信息）。
 *
 * 安全约定（默认全关，逐个在「设置 → 能力」里授权）：
 *   - 文件路径折叠 `..` 之后必须落在 App 的 Documents / App Group Documents 内，越界直接拒绝；
 *   - 命令行只放行白名单里的第一个命令词，管道 / 重定向 / 命令串联 / 命令替换一律拒绝
 *     （本机 iOS shell 本来也不支持），明显会大范围删文件的写法也拒绝；
 *   - 每次执行都有超时，输出统一截断，免得一次命令把上下文撑爆。
 */
import { Script } from "scripting"
import {
  AgentConfig, AgentConfigToggle, AgentTool, ToolParamSpec, loadConfig, makeToolFunctionName,
  saveConfig, shortcutProtocolText,
} from "./agent_store"
import { SKILL_INBOX, findSkill, importSkills, listSkills, skillDirOf } from "./skills_store"

/**
 * 去掉尾部斜杠。实测 `FileManager.documentsDirectory` 是带尾斜杠的
 * （`…/Documents/`），直接拼会得到 `Documents//工作区`，路径前缀比较也会失效。
 */
function trimSlash(p: string): string {
  return String(p ?? "").replace(/\/+$/, "")
}

/** 助手干活的默认目录（在「文件」App → Scripting 里能看到，用户可以直接拖文件进去）。 */
export const WORKSPACE_DIR = trimSlash(FileManager.documentsDirectory) + "/工作区"

/** 允许助手触碰的两个根目录。 */
const ROOTS = [
  trimSlash(FileManager.documentsDirectory),
  trimSlash(FileManager.appGroupDocumentsDirectory),
].filter((p) => !!p)

/** 命令 / 脚本的超时（秒）。 */
const CLI_DEFAULT_TIMEOUT = 30
const CLI_MAX_TIMEOUT = 120
/** 返回给模型的输出上限（字符）。 */
const OUT_CLIP = 8000
/** 一次读文件的上限（字符）。 */
const READ_CLIP = 20000
/** 列目录最多列多少条。 */
const LIST_MAX = 300

/** 回传 URL 里用的脚本名（就是本脚本在 Scripting 里的名字，兜底「智能体」）。 */
const CALLBACK_SCRIPT_NAME = (() => {
  try {
    const n: any = (Script as any)?.name
    // CLI 调试时 name 是「scripting-ts run」，只有真机上才是脚本名
    if (typeof n === "string" && n.trim() && n.indexOf("scripting-ts") < 0) return n.trim()
    return "智能体"
  } catch {
    return "智能体"
  }
})()

// ———————————————————————— 路径 ————————————————————————

/** 折叠 `.` 与 `..`，得到规范化的绝对路径。 */
function foldPath(input: string): string {
  const segs: string[] = []
  for (const seg of input.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      segs.pop()
      continue
    }
    segs.push(seg)
  }
  return "/" + segs.join("/")
}

/**
 * 解析成绝对路径：相对路径按 base（默认工作区）展开，绝对路径原样。
 * 折叠后不在允许的根目录里，或路径为空 → 返回 null。
 */
function resolvePath(raw: any, base = WORKSPACE_DIR): string | null {
  const text = String(raw ?? "").trim()
  if (text.indexOf("\u0000") >= 0) return null
  const joined = !text ? foldPath(base) : text.startsWith("/") ? text : foldPath(base + "/" + text)
  const abs = foldPath(joined)
  for (const root of ROOTS) {
    if (abs === root || abs.startsWith(root + "/")) return abs
  }
  return null
}

/** 展示用的短路径（在工作区里的显示相对路径，方便模型接着用小路径干活）。 */
function displayPath(abs: string): string {
  const roots = [WORKSPACE_DIR].concat(ROOTS)
  for (const root of roots) {
    if (abs === root) return "/"
    if (abs.startsWith(root + "/")) return abs.slice(root.length + 1)
  }
  return abs
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

function ensureDir(dir: string): void {
  try {
    FileManager.createDirectorySync(dir, true)
  } catch {
    // ignore
  }
}

function sizeText(path: string): string {
  try {
    const st = FileManager.statSync(path)
    return humanSize(st?.size ?? 0)
  } catch {
    return "?"
  }
}

function humanSize(n: number): string {
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  return (n / 1024 / 1024).toFixed(1) + " MB"
}

function clip(text: string, max = OUT_CLIP): string {
  const s = text ?? ""
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（输出太长，已截断，共 ${s.length} 字）`
}

function clampInt(raw: any, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw))
  if (!isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, n))
}

// ———————————————————————— 能力定义 ————————————————————————

/** 一次能力调用的结果。 */
export interface CapResult {
  /** 交给模型看的文本。 */
  text: string
  ok: boolean
  /** 过程卡片上的执行目标（不传就用工具标签）。 */
  target?: string
  /** 过程卡片上的参数摘要（不传就用 JSON）。 */
  argsText?: string
  /** 这次动作产出 / 改动的文件（绝对路径）：聊天页据此画「产出文件」卡片。 */
  files?: string[]
  /** 新建的快捷指令工具名：聊天页要把它并进当前会话的挂载。 */
  createdTools?: string[]
}

/** 能力的类别（决定过程卡片上的小标题）。 */
export type CapKind = "fs" | "cli" | "skill" | "shortcut"

export interface Capability {
  /** 控制它的设置开关。 */
  toggle: AgentConfigToggle
  kind: CapKind
  /** 模型看到的函数名。 */
  name: string
  description: string
  parameters: Record<string, any>
  /** 过程卡片上的默认目标文案。 */
  label: string
  run: (args: any) => Promise<CapResult>
}

const TYPES = ["string", "number", "integer", "boolean"]

/** 模型给的工具参数声明 → ToolParamSpec[]（坏数据直接丢掉，不报错）。 */
function normalizeParams(raw: any): ToolParamSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ToolParamSpec[] = []
  for (const item of raw) {
    const p: any = typeof item === "string" ? { name: item } : item
    const name = String(p?.name ?? "").trim()
    if (!name) continue
    const spec: ToolParamSpec = {
      name,
      description: String(p?.description ?? "").trim(),
    }
    const ty = String(p?.type ?? "")
    if (TYPES.indexOf(ty) >= 0) spec.type = ty as ToolParamSpec["type"]
    if (p?.required === false) spec.required = false
    if (Array.isArray(p?.enum) && p.enum.length > 0) spec.enum = p.enum.map((x: any) => String(x))
    out.push(spec)
  }
  return out.length > 0 ? out : undefined
}

function fail(text: string): CapResult {
  return { text, ok: false }
}

// —— 文件：列目录 ——

function capListFiles(): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "list_files",
    label: "文件",
    description:
      "列出助手工作区里的文件和目录。path 写相对路径（相对工作区，例如 \"报告\"），留空就是工作区根目录；" +
      `工作区默认在「文件」App 的 ${displayPath(WORKSPACE_DIR) || "工作区"} 目录下。` +
      "要用别的目录就先 list_files 看一眼再操作，不要凭猜路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要列出的目录，留空 = 工作区根目录" },
        depth: { type: "number", description: "往下展开几层，默认 2，最多 4" },
      },
    },
    run: async (args) => {
      const abs = resolvePath(args?.path)
      if (!abs) return fail("路径不允许：只能读写这个 App 自己的「文件」目录。")
      if (!FileManager.existsSync(abs)) {
        return fail(`没有这个路径：${displayPath(abs)}（工作区默认是空的，可以先用 write_file 建文件）`)
      }
      if (!FileManager.isDirectorySync(abs)) {
        return fail(`${displayPath(abs)} 是文件，用 read_file 读它。`)
      }
      const maxDepth = clampInt(args?.depth, 1, 4, 2)
      const lines: string[] = []
      let truncated = false
      const walk = (dir: string, depth: number, prefix: string) => {
        if (truncated) return
        let names: string[] = []
        try {
          names = FileManager.readDirectorySync(dir)
        } catch {
          return
        }
        // readDirectorySync 返回的是纯名字，得自己拼全路径
        const full = names
          .map((n: string) => (n.startsWith("/") ? n : dir.replace(/\/+$/, "") + "/" + n))
          .sort()
        for (const p of full) {
          if (lines.length >= LIST_MAX) {
            truncated = true
            return
          }
          let isDir = false
          try {
            isDir = FileManager.isDirectorySync(p)
          } catch {
            isDir = false
          }
          lines.push(prefix + baseName(p) + (isDir ? "/" : "  (" + sizeText(p) + ")"))
          if (isDir && depth < maxDepth) walk(p, depth + 1, prefix + baseName(p) + "/")
        }
      }
      walk(abs, 1, "")
      const head =
        lines.length === 0
          ? `${displayPath(abs) || "工作区"}是空的。`
          : `${displayPath(abs) || "工作区"}（${lines.length} 个条目${truncated ? "，只列了前 " + LIST_MAX + " 个" : ""}）：`
      return {
        text: [head, ...lines].join("\n"),
        ok: true,
        target: displayPath(abs) || "工作区",
        argsText: String(args?.path ?? "") || "（根目录）",
      }
    },
  }
}

// —— 文件：读 ——

function capReadFile(): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "read_file",
    label: "文件",
    description:
      "读一个文本文件的内容（Markdown / txt / json / csv / 代码都行）。" +
      "path 相对工作区，也可以用绝对路径。文件很长时用 offset 接着往下读。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区）" },
        offset: { type: "number", description: "从第几个字符开始读，默认 0" },
        maxChars: { type: "number", description: `最多读多少字，默认 ${READ_CLIP}` },
      },
      required: ["path"],
    },
    run: async (args) => {
      const abs = resolvePath(args?.path)
      if (!abs) return fail("路径不允许：只能读写这个 App 自己的「文件」目录。")
      if (!FileManager.existsSync(abs)) return fail(`文件不存在：${displayPath(abs)}`)
      if (FileManager.isDirectorySync(abs)) return fail(`${displayPath(abs)} 是目录，用 list_files 看里面。`)
      let binary = false
      try {
        binary = FileManager.isBinaryFileSync(abs)
      } catch {
        binary = false
      }
      if (binary) return fail(`${displayPath(abs)} 看起来是二进制文件（图片 / 压缩包等），读不了文本内容。`)
      let raw = ""
      try {
        raw = FileManager.readAsStringSync(abs)
      } catch (e: any) {
        return fail(`读取失败：${e?.message ?? String(e)}`)
      }
      const offset = Math.max(0, Math.floor(Number(args?.offset) || 0))
      const max = clampInt(args?.maxChars, 200, READ_CLIP, READ_CLIP)
      const body = raw.slice(offset, offset + max)
      const more =
        raw.length > offset + body.length
          ? `\n…（还有 ${raw.length - offset - body.length} 字没读完，接着读就用 offset=${offset + body.length}）`
          : ""
      return {
        text: `文件：${displayPath(abs)}（共 ${raw.length} 字）\n\n` + body + more,
        ok: true,
        target: displayPath(abs),
        argsText: displayPath(abs),
      }
    },
  }
}

// —— 文件：写 ——

function capWriteFile(): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "write_file",
    label: "文件",
    description:
      "把内容写进一个文本文件（已存在就整个覆盖，父目录会自动建）。" +
      "写完这个文件会作为「产出文件」显示在聊天里，用户可以一键存到「文件」App 或分享出去。" +
      "要给用户一份报告 / 代码 / 表格时，用这个工具落成文件，而不是把长内容全塞进回复。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区），例如 报告/月报.md" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
    run: async (args) => {
      const abs = resolvePath(args?.path)
      if (!abs) return fail("路径不允许：只能写在这个 App 自己的「文件」目录里。")
      const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "")
      const parent = abs.slice(0, abs.lastIndexOf("/"))
      ensureDir(parent)
      try {
        FileManager.writeAsStringSync(abs, content)
      } catch (e: any) {
        return fail(`写入失败：${e?.message ?? String(e)}`)
      }
      return {
        text: `已写入 ${displayPath(abs)}（${content.length} 字）。这个文件已经出现在聊天里，用户可以直接保存或分享。`,
        ok: true,
        target: displayPath(abs),
        argsText: displayPath(abs),
        files: [abs],
      }
    },
  }
}

// —— 文件：删 ——

function capDeleteFile(): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "delete_file",
    label: "文件",
    description:
      "删除工作区里的一个文件或目录（目录会连同里面的东西一起删，不可恢复）。删之前先 list_files 确认，不要删用户自己放进去的东西。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件 / 目录路径" },
      },
      required: ["path"],
    },
    run: async (args) => {
      const abs = resolvePath(args?.path)
      if (!abs) return fail("路径不允许：只能删这个 App 自己的「文件」目录里的东西。")
      for (const root of ROOTS) {
        if (abs === root) return fail("不能删除根目录。")
      }
      if (!FileManager.existsSync(abs)) return fail(`不存在：${displayPath(abs)}`)
      try {
        FileManager.removeSync(abs)
      } catch (e: any) {
        return fail(`删除失败：${e?.message ?? String(e)}`)
      }
      return {
        text: `已删除 ${displayPath(abs)}。`,
        ok: true,
        target: displayPath(abs),
        argsText: displayPath(abs),
      }
    },
  }
}

// —— 命令行 ——

/** 放行的命令（ios_system 在进程内注册的那批）。 */
const CLI_COMMANDS = [
  "python3", "python", "pip3", "pip", "scripting-ts", "node", "npm", "pnpm",
  "ls", "cat", "head", "tail", "grep", "sed", "awk", "sort", "uniq", "wc",
  "find", "du", "stat", "md5", "cksum", "tr", "diff", "tee", "base64",
  "mkdir", "touch", "cp", "mv", "rm", "chmod", "ln", "readlink",
  "echo", "date", "env", "printenv", "which", "pwd", "say",
  "tar", "gzip", "gunzip", "zip", "unzip", "curl", "ffmpeg", "ffprobe",
]

/** 一眼就很危险的写法。 */
const CLI_BLOCKED: RegExp[] = [
  /\brm\s+-[A-Za-z]*[rR][A-Za-z]*f?\s+(\/|~|\*)/,
  /\b(mv|cp)\s+[^\s]*\/\s*$/,
]

/** 参数里的引号 / 空格处理：简单参数原样，其余用双引号包住。 */
function quoteArg(s: string): string {
  const t = String(s ?? "")
  if (/^[A-Za-z0-9_\-.,:\/@+=%]+$/.test(t)) return t
  return '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/** 这条命令能不能跑；返回 null 表示放行。 */
function checkCommand(cmd: string): string | null {
  const text = (cmd ?? "").trim()
  if (!text) return "命令是空的。"
  if (/[|;&><`]/.test(text) || /\$\(/.test(text)) {
    return "本机的命令行不支持管道 | 、重定向 > 、命令串联 && / ; 和命令替换 $( )，请改成一次跑一条简单命令。"
  }
  const first = text.split(/\s+/)[0]
  const base = first.split("/").pop() || first
  if (CLI_COMMANDS.indexOf(base) < 0) {
    return `不允许执行「${base}」。可用的命令：${CLI_COMMANDS.join("、")}。`
  }
  for (const re of CLI_BLOCKED) {
    if (re.test(text)) return "这条命令看起来会大范围删改文件，已拒绝。真要删就用 delete_file 明确指定路径。"
  }
  return null
}

function capRunCli(): Capability {
  return {
    toggle: "cliEnabled",
    kind: "cli",
    name: "run_cli",
    label: "命令行",
    description:
      "在手机本地跑一条命令行命令，并拿到它的输出（stdout + stderr 合在一起）。" +
      `可用的命令：${CLI_COMMANDS.join("、")}（都跑在 App 内部，没有 git、bash，也不支持管道 / 重定向 / 后台进程）。` +
      "工作目录默认是助手工作区；命令是相对工作区执行的。要算什么、转什么格式、批量改文件都可以用它，" +
      "但每次只跑一条命令，超时大约 " + CLI_DEFAULT_TIMEOUT + " 秒。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整命令，例如 python3 -c \"print(1+1)\"" },
        cwd: { type: "string", description: "工作目录（相对工作区），默认工作区根目录" },
        timeout: { type: "number", description: `超时秒数，默认 ${CLI_DEFAULT_TIMEOUT}，最多 ${CLI_MAX_TIMEOUT}` },
      },
      required: ["command"],
    },
    run: async (args) => {
      const command = String(args?.command ?? "").trim()
      const bad = checkCommand(command)
      if (bad) return fail(bad)
      const cwd = resolvePath(args?.cwd ?? "") ?? WORKSPACE_DIR
      ensureDir(cwd)
      const timeout = clampInt(args?.timeout, 1, CLI_MAX_TIMEOUT, CLI_DEFAULT_TIMEOUT)
      let res: any
      try {
        res = await Shell.run(command, { cwd, timeout })
      } catch (e: any) {
        return fail(`执行失败：${e?.message ?? String(e)}`)
      }
      const out = String(res?.output ?? "")
      const code = Number(res?.exitCode ?? 0)
      const head =
        `$ ${command}` +
        (cwd === WORKSPACE_DIR ? "" : `\n（工作目录：${displayPath(cwd)}）`)
      const tail = res?.timedOut
        ? `\n[超时 ${timeout} 秒被终止，输出可能不完整]`
        : `\nexit ${code}`
      return {
        text: clip(`${head}${tail}\n${out || "（没有任何输出）"}`),
        ok: !res?.timedOut && code === 0,
        target: command.length > 40 ? command.slice(0, 40) + "…" : command,
        argsText: cwd === WORKSPACE_DIR ? command : `${command}  @ ${displayPath(cwd)}`,
      }
    },
  }
}

// —— 技能脚本 ——

function capRunSkillScript(): Capability {
  let names: string[] = []
  try {
    names = listSkills().slice(0, 20).map((s) => s.name)
  } catch {
    names = []
  }
  return {
    toggle: "skillScriptEnabled",
    kind: "skill",
    name: "run_skill_script",
    label: "技能脚本",
    description:
      "运行某个技能自带的脚本（技能目录里的 .py 用 python3 跑，.ts/.tsx/.js 用 scripting-ts 跑），并拿到它的输出。" +
      (names.length > 0 ? `现在装着这些技能：${names.join("、")}。` : "") +
      "PATH 相对技能目录，例如 scripts/main.py。跑之前先用 read_skill 把技能说明读完，再按它说的方式调用，" +
      "不要盲跑、也不要自己编造运行结果。",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "技能名" },
        path: { type: "string", description: "脚本在技能目录里的相对路径，例如 scripts/main.py" },
        args: {
          type: "array",
          description: "传给脚本的参数，按顺序（Python 脚本会进 sys.argv）",
          items: { type: "string" },
        },
      },
      required: ["skill", "path"],
    },
    run: async (args) => {
      const key = String(args?.skill ?? "").trim()
      const meta = findSkill(key)
      if (!meta) return fail(`没找到技能「${key}」。`)
      const dir = skillDirOf(meta)
      const rel = String(args?.path ?? "").trim()
      if (!rel) return fail("要告诉我是哪个脚本，比如 scripts/main.py。")
      const abs = foldPath(dir + "/" + rel)
      if (!(abs === dir || abs.startsWith(dir + "/"))) return fail("脚本路径必须在这个技能目录里面。")
      if (!FileManager.existsSync(abs) || FileManager.isDirectorySync(abs)) {
        return fail(`技能里没有这个文件：${rel}`)
      }
      const ext = (baseName(abs).split(".").pop() ?? "").toLowerCase()
      const list: string[] = Array.isArray(args?.args)
        ? args.args.map((x: any) => String(x))
        : args?.args === undefined || args?.args === null || args?.args === ""
          ? []
          : [String(args.args)]
      let command: string
      if (ext === "py") {
        command = ["python3", quoteArg(abs)].concat(list.map(quoteArg)).join(" ")
      } else if (ext === "ts" || ext === "tsx" || ext === "js") {
        const payload = list.length > 0 ? JSON.stringify({ args: list }) : "{}"
        command = `scripting-ts run ${quoteArg(abs)} --queryparameters ${quoteArg(payload)}`
      } else {
        return fail("只支持技能里的 .py / .ts / .tsx / .js 脚本。")
      }
      let res: any
      try {
        res = await Shell.run(command, { cwd: dir, timeout: CLI_MAX_TIMEOUT })
      } catch (e: any) {
        return fail(`执行失败：${e?.message ?? String(e)}`)
      }
      const out = String(res?.output ?? "")
      const code = Number(res?.exitCode ?? 0)
      const head = `技能「${meta.name}」· ${rel}`
      const tail = res?.timedOut ? `\n[超时 ${CLI_MAX_TIMEOUT} 秒被终止]` : `\nexit ${code}`
      return {
        text: clip(`${head}${tail}\n${out || "（没有任何输出）"}`),
        ok: !res?.timedOut && code === 0,
        target: `${meta.name} · ${rel}`,
        argsText: list.length > 0 ? list.map(quoteArg).join(" ") : rel,
      }
    },
  }
}

// —— 创建技能 ——

function safeDirName(name: string): string {
  const cleaned = (name ?? "")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 40)
  return cleaned || "skill-" + Date.now().toString(36)
}

function uniqueDirName(dir: string, name: string): string {
  if (!FileManager.existsSync(dir + "/" + name)) return name
  let i = 2
  while (FileManager.existsSync(`${dir}/${name}-${i}`)) i += 1
  return `${name}-${i}`
}

function capCreateSkill(): Capability {
  return {
    toggle: "skillCreateEnabled",
    kind: "skill",
    name: "create_skill",
    label: "技能",
    description:
      "把一套做事方法固化成一条新技能（会在助手技能库里建号，用户能在「设置 → 技能」里看到、停用或删除）。" +
      "什么时候用：用户让你「记住以后都这么做」「把这个流程做成技能」；或者你发现某个做法以后还会反复用。" +
      "content 就是 SKILL.md 的正文，要写清「什么时候用 / 一步步怎么做 / 有哪些坑」，别写空话；" +
      "需要配套脚本时用 files 一起写进去（例如 scripts/main.py），正文里写清怎么调用它。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（短、能一眼看懂）" },
        description: { type: "string", description: "一句话说明它干什么、什么时候该用（会出现在技能列表里）" },
        content: { type: "string", description: "SKILL.md 正文（Markdown）" },
        files: {
          type: "array",
          description: "要一起写进技能目录的附加文件（可选）",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "相对技能目录的路径，例如 scripts/main.py" },
              content: { type: "string", description: "文件内容" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["name", "description", "content"],
    },
    run: async (args) => {
      const name = String(args?.name ?? "").trim()
      const description = String(args?.description ?? "").trim()
      const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "")
      if (!name) return fail("技能得有个名字。")
      if (!description) return fail("技能要有一句话说明，否则模型以后不知道什么时候用它。")
      if (!content.trim()) return fail("SKILL.md 正文不能是空的，写清具体步骤。")

      const inbox = SKILL_INBOX
      ensureDir(inbox)
      const dirName = uniqueDirName(inbox, safeDirName(name))
      const dest = inbox + "/" + dirName
      const md = [
        "---",
        "name: " + name.replace(/[\r\n]/g, " "),
        "description: " + description.replace(/[\r\n]/g, " "),
        "---",
        "",
        content.replace(/\r\n?/g, "\n"),
        "",
      ].join("\n")

      const written: string[] = []
      try {
        ensureDir(dest)
        FileManager.writeAsStringSync(dest + "/SKILL.md", md)
        written.push(dest + "/SKILL.md")
      } catch (e: any) {
        return fail(`写技能文件失败：${e?.message ?? String(e)}`)
      }

      const extra = Array.isArray(args?.files) ? args.files : []
      for (const f of extra) {
        const rel = String(f?.path ?? "").trim()
        if (!rel) continue
        const target = foldPath(dest + "/" + rel)
        if (!target.startsWith(dest + "/")) continue
        const parent = target.slice(0, target.lastIndexOf("/"))
        ensureDir(parent)
        try {
          FileManager.writeAsStringSync(target, typeof f?.content === "string" ? f.content : String(f?.content ?? ""))
          written.push(target)
        } catch {
          // 单个附件失败不影响技能本体
        }
      }

      let added = ""
      let note = ""
      try {
        const res = await importSkills()
        if (res.added.length > 0) {
          added = res.added.map((s) => s.name).join("、")
        }
        if (res.errors.length > 0) note = `（有文件没装上：${res.errors[0]}）`
        if (res.added.length === 0 && res.skipped.length > 0) note = `（${res.skipped[0]}）`
      } catch (e: any) {
        note = `（导入时出错：${e?.message ?? String(e)}）`
      }

      const okText = added
        ? `已创建技能「${added}」，现在在「设置 → 技能」里能看到，用户随时可以停用或删掉它。`
        : `技能文件已经写好（${dirName}），但没能在技能库里注册${note}。`
      return {
        text: `${okText}\n描述：${description}\n目录：${displayPath(dest)}（${written.length} 个文件）`,
        ok: true,
        target: name,
        argsText: name + "（" + written.length + " 个文件）",
      }
    },
  }
}

// —— 快捷指令工具配置 ——

function capCreateShortcutTool(): Capability {
  return {
    toggle: "toolCreateEnabled",
    kind: "shortcut",
    name: "create_shortcut_tool",
    label: "快捷指令工具",
    description:
      "帮用户在助手里登记一个「本地快捷指令工具」，登记完你就能像调用其它工具那样调用它。" +
      "注意：这一步只是写配置，用户手机里那条快捷指令还得用户自己在『快捷指令』App 里建出来（名字必须一模一样），" +
      "所以调用这个工具之后，你必须把「怎么在快捷指令 App 里建这条快捷指令」的步骤讲给用户听。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "工具名（模型调用时用的函数名，英文 / 拼音最好）" },
        shortcutName: { type: "string", description: "对应的快捷指令名（要跟用户手机里那条一模一样）" },
        description: { type: "string", description: "这个工具干什么、什么时候用" },
        params: {
          type: "array",
          description: "参数声明（可选）：快捷指令会收到一个 JSON 文本输入",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "参数名" },
              description: { type: "string", description: "参数说明" },
              type: { type: "string", description: "string / number / integer / boolean" },
              required: { type: "boolean", description: "是否必填，默认 true" },
              enum: { type: "array", description: "限定取值", items: { type: "string" } },
            },
            required: ["name"],
          },
        },
        returns: { type: "boolean", description: "这条快捷指令末尾会不会把结果回传给助手（需要用户按协议配回调 URL），默认否" },
      },
      required: ["name", "shortcutName", "description"],
    },
    run: async (args) => {
      const rawName = String(args?.name ?? "").trim()
      const shortcutName = String(args?.shortcutName ?? "").trim() || rawName
      const description = String(args?.description ?? "").trim()
      if (!rawName) return fail("工具得有名字。")
      if (!description) return fail("要给一句说明，否则模型以后不知道该在什么时候调用它。")

      const cfg = loadConfig()
      const used = new Set((cfg.tools ?? []).map((t) => t.name))
      const { name, note } = makeToolFunctionName(rawName, shortcutName, used.size, used)
      if (used.has(name)) return fail(`已经有一个叫「${name}」的工具了，换一个名字。`)

      const tool: AgentTool = { name, shortcutName, description }
      const params = normalizeParams(args?.params)
      if (params) tool.params = params
      if (args?.returns === true) tool.returns = true

      try {
        saveConfig({ ...cfg, tools: [...(cfg.tools ?? []), tool] })
      } catch (e: any) {
        return fail(`写配置失败：${e?.message ?? String(e)}`)
      }

      const detail = [
        `- 工具名（模型看到）：${name}`,
        `- 对应快捷指令：${shortcutName}`,
        params ? `- 参数：${params.map((p) => p.name + (p.required === false ? "（可选）" : "")).join("、")}` : "- 参数：无",
        `- 等回传：${tool.returns ? "会（用户要按协议配回调）" : "不会（单向触发）"}`,
      ].join("\n")

      const guide = [
        "【接下来用户要做的（务必转述给用户）】",
        "1. 打开『快捷指令』App → 右上角 + → 新建一条快捷指令。",
        `2. 把它重命名为「${shortcutName}」（必须和上面一模一样，差一个字都调不到）。`,
        "3. 按下面的协议接线：",
        "",
        shortcutProtocolText(CALLBACK_SCRIPT_NAME),
        "",
        tool.returns
          ? "（这条工具标了「等回传」：用户必须把末尾三个动作加上，否则助手会一直等不到结果。）"
          : "（这条工具是单向触发：用户不用配回调，助手也不会拿到结果。）",
      ].join("\n")

      return {
        text:
          `✅ 已把快捷指令工具登记进助手配置（用户下次打开设置页也能看到、能改）。\n` +
          detail +
          (note ? `\n（提示：${note}）` : "") +
          `\n\n${guide}`,
        ok: true,
        target: shortcutName,
        argsText: name,
        createdTools: [name],
      }
    },
  }
}

// ———————————————————————— 对外 ——

/** 当前开着哪些能力（按设置页的开关过滤，默认全关）。 */
export function capabilitiesFor(cfg: AgentConfig): Capability[] {
  const on = (k: AgentConfigToggle): boolean => (cfg as any)?.[k] === true
  const list: Capability[] = []
  if (on("fsEnabled")) {
    list.push(capListFiles(), capReadFile(), capWriteFile(), capDeleteFile())
  }
  if (on("cliEnabled")) list.push(capRunCli())
  if (on("skillScriptEnabled") && cfg.skillsEnabled !== false) list.push(capRunSkillScript())
  if (on("skillCreateEnabled")) list.push(capCreateSkill())
  if (on("toolCreateEnabled")) list.push(capCreateShortcutTool())
  return list
}
