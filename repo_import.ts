/**
 * 从 git 仓库导入技能：把仓库（或仓库里的某个子目录）下载成 zip、解开、
 * 找到含 SKILL.md 的那一层，装进技能库。
 *
 * 为什么走 zip 而不是 `git clone`：iOS 沙箱里没有 git 二进制，但仓库的
 * zip 归档是纯 HTTP 资源，一次 `fetch` 就能拿全，私有仓库加个令牌头即可。
 *
 * 支持的写法：
 *   chuwanhui/ios-agent                          （默认分支 main，找不到就试 master）
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/skills/foo   （只装子目录里的技能）
 *   https://gitlab.com/group/proj/-/tree/main/sub
 * 私有仓库要先在技能页填访问令牌（GitHub 用 `Authorization: Bearer`，
 * GitLab 用 `PRIVATE-TOKEN`），令牌会存进配置（gitToken）。
 */

import { fetch } from "scripting"
import { loadConfig, saveConfig } from "./agent_store"
import { SkillMeta, findSkillRoot, installSkillFolder } from "./skills_store"

const TMP_DIR = FileManager.appGroupDocumentsDirectory + "/agent/tmp"

export interface RepoRef {
  host: "github" | "gitlab"
  owner: string
  repo: string
  /** 显式指定的分支 / tag；空 = 自动试 main / master。 */
  branch: string
  /** 仓库里的子目录（含 SKILL.md 的那一层）。 */
  subdir: string
}

export interface RepoImportResult {
  added?: SkillMeta
  error?: string
  /** 实际下载到的分支 / tag。 */
  refLabel?: string
}

/** 认下 owner/repo、https://github.com/owner/repo、…/tree/main/sub 这些写法。 */
export function parseRepoRef(input: string): RepoRef | null {
  let s = (input ?? "").trim()
  if (!s) return null
  s = s.replace(/^git\+/, "").replace(/\.git$/i, "").replace(/\/+$/, "")

  let host: "github" | "gitlab" = "github"
  let path = s
  const m = s.match(/^https?:\/\/([^/]+)\/(.+)$/i)
  if (m) {
    const h = m[1].toLowerCase()
    if (h.indexOf("gitlab") >= 0) host = "gitlab"
    else if (h.indexOf("github") >= 0) host = "github"
    else return null // 自建 Gitea 等暂不支持
    path = m[2]
  }

  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1]
  let branch = ""
  let subdir = ""
  if (parts.length >= 4) {
    // GitLab 是 /-/tree/<branch>/<sub>，GitHub 是 /tree/<branch>/<sub>
    const mark = parts[2] === "-" ? 3 : 2
    if (parts[mark] === "tree" || parts[mark] === "blob") {
      branch = parts[mark + 1] ?? ""
      subdir = parts
        .slice(mark + 2)
        .join("/")
        .replace(/\/+$/, "")
    }
  }
  if (!owner || !repo) return null
  return { host, owner, repo, branch, subdir }
}

/** 候选下载地址（按顺序试）：先分支再 tag，没写分支就先 main 再 master。 */
function candidateUrls(ref: RepoRef): Array<{ url: string; label: string }> {
  const names = ref.branch ? [ref.branch] : ["main", "master"]
  const out: Array<{ url: string; label: string }> = []
  for (const b of names) {
    if (ref.host === "gitlab") {
      out.push({
        url: `https://gitlab.com/${ref.owner}/${ref.repo}/-/archive/${b}/${ref.repo}-${b}.zip`,
        label: b,
      })
      continue
    }
    // codeload 直连 zip（省一次 302）
    out.push({
      url: `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/heads/${b}`,
      label: b,
    })
    out.push({
      url: `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/tags/${b}`,
      label: b,
    })
  }
  return out
}

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

function isDir(p: string): boolean {
  try {
    return FileManager.isDirectorySync(p)
  } catch {
    return false
  }
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    try {
      FileManager.removeSync(p)
    } catch {
      // ignore
    }
  }
}

/**
 * 下载 + 安装。`token` 为空就以匿名访问（公开仓库够用）。
 * 成功后临时文件会被清掉，只留下技能库里的副本。
 */
export async function importSkillFromRepo(
  rawUrl: string,
  token: string,
  onProgress?: (text: string) => void,
): Promise<RepoImportResult> {
  const ref = parseRepoRef(rawUrl)
  if (!ref) {
    return { error: "只认 GitHub / GitLab 的仓库，例如 https://github.com/owner/repo" }
  }

  const tk = (token ?? "").trim()
  const headers: Record<string, string> = {}
  if (tk) {
    if (ref.host === "gitlab") headers["PRIVATE-TOKEN"] = tk
    else headers["Authorization"] = "Bearer " + tk
  }

  // 令牌顺手存进配置，下次打开技能页就有了
  const cfg = loadConfig()
  if ((cfg.gitToken ?? "") !== tk) saveConfig({ ...cfg, gitToken: tk })

  let buf: ArrayBuffer | null = null
  let refLabel = ""
  let lastErr = ""
  for (const cand of candidateUrls(ref)) {
    onProgress?.(`正在下载 ${ref.owner}/${ref.repo}@${cand.label} …`)
    try {
      const resp = await fetch(cand.url, { headers })
      if (!resp.ok) {
        lastErr = `${cand.label}：HTTP ${resp.status}`
        continue
      }
      buf = await resp.arrayBuffer()
      refLabel = cand.label
      break
    } catch (e: any) {
      lastErr = `${cand.label}：${e?.message ?? e}`
    }
  }
  if (!buf) {
    const hint = tk || ref.host === "gitlab" ? "" : "（私有仓库要先填访问令牌）"
    return { error: `下载失败：${lastErr || "未知错误"}${hint}` }
  }

  const stamp = Date.now().toString(36)
  const zipPath = `${TMP_DIR}/repo_${stamp}.zip`
  const outDir = `${TMP_DIR}/repo_${stamp}`
  try {
    FileManager.createDirectorySync(TMP_DIR, true)
    FileManager.writeAsBytesSync(zipPath, new Uint8Array(buf))
    onProgress?.("正在解压…")
    await FileManager.unzip(zipPath, outDir)
  } catch (e: any) {
    cleanup([zipPath, outDir])
    return { error: `解压失败：${e?.message ?? e}` }
  }

  try {
    // zip 顶层是 `<repo>-<branch>`，子目录再往下找
    let base = outDir
    const top = ls(outDir)
    if (top.length === 1 && isDir(top[0])) base = top[0]
    if (ref.subdir) {
      const target = base + "/" + ref.subdir
      if (isDir(target)) base = target
    }
    onProgress?.("正在安装…")
    const root = findSkillRoot(base) ?? findSkillRoot(outDir)
    if (!root) return { error: "仓库里没找到 SKILL.md（技能必须是一个含 SKILL.md 的文件夹）" }
    const installed = installSkillFolder(root)
    if (!installed.added) return { error: installed.reason ?? "安装失败" }
    return { added: installed.added, refLabel }
  } finally {
    cleanup([zipPath, outDir])
  }
}
