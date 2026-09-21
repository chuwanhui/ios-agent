/**
 * 快捷指令回传的另一半。
 *
 * 触发一个带 `returns` 的快捷指令工具时，先落一条 pending 记录（写在磁盘上，
 * App 被杀掉也还在，默认 10 分钟内有效）；快捷指令末尾「打开 URL」回调
 * `scripting://run/<脚本名>?result=…` 时，我们做两件事：
 *   1. 把结果回填到那条工具步骤（过程卡片上显示「已回传」+ 真实结果）；
 *   2. 把结果当成一条**隐藏输入**（hidden: true）让智能体接着回答 —— 只进上下文，聊天界面不显示。
 *
 * 时序不变：回传只是「多给模型一段输入」，不阻塞原来那轮回答，
 * 所以不需要等结果、也不会卡住界面。
 */
import {
  AGENT_DIR, ChatMessage, NEW_SESSION_TITLE, Session, SessionStore, ToolStep,
  deriveTitle, loadStore, makeSession, saveStore, upsertSession,
} from "./agent_store"

export const PENDING_FILE = AGENT_DIR + "/pending.json"

/** 超过这么久还没回传，就当成「这个快捷指令其实没配回传」，把记录清掉。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

const MAX_PENDING = 20
/** 记着最近处理过的回传，防止同一条 URL 被送达两次（冷启动 + resume）重复续跑。 */
const MAX_DONE = 20

/** 一次「已触发、等回传」的调用。 */
export interface PendingCall {
  /** 调用编号，回填步骤 / 去重都靠它。 */
  cid: string
  /** 模型看到的函数名。 */
  toolName: string
  /** 真实快捷指令名。 */
  shortcutName: string
  /** 传过去的参数 JSON（没有参数就是空串）。 */
  args: string
  createdAt: number
}

interface PendingFile {
  pending: PendingCall[]
  done: { cid: string; at: number }[]
}

function newCid(): string {
  return "sc" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
}

function readFile(): PendingFile {
  try {
    const raw = JSON.parse(FileManager.readAsStringSync(PENDING_FILE))
    return {
      pending: Array.isArray(raw?.pending) ? raw.pending : [],
      done: Array.isArray(raw?.done) ? raw.done : [],
    }
  } catch {
    return { pending: [], done: [] }
  }
}

function writeFile(f: PendingFile): void {
  try {
    FileManager.createDirectorySync(AGENT_DIR, true)
    FileManager.writeAsStringSync(
      PENDING_FILE,
      JSON.stringify({ pending: f.pending.slice(-MAX_PENDING), done: f.done.slice(-MAX_DONE) }, null, 2),
    )
  } catch {
    // 写盘失败就当没有 pending：只是回填不上过程卡片，不影响触发本身
  }
}

/** 丢掉过期记录（挂掉 / 没配回传的快捷指令留下的残渣）。 */
export function prunePending(list: PendingCall[], now = Date.now()): PendingCall[] {
  return list.filter((p) => !!p && !!p.cid && now - (p.createdAt || 0) <= PENDING_TTL_MS).slice(-MAX_PENDING)
}

/** 现在还在等回传的调用（已经顺手清掉过期的）。 */
export function loadPending(now = Date.now()): PendingCall[] {
  const f = readFile()
  const alive = prunePending(f.pending, now)
  if (alive.length !== f.pending.length) writeFile({ pending: alive, done: f.done })
  return alive
}

export function pendingCount(): number {
  return loadPending().length
}

/** 记一次「已触发、等回传」。 */
export function addPending(input: { toolName: string; shortcutName: string; args?: string }): PendingCall {
  const rec: PendingCall = {
    cid: newCid(),
    toolName: input.toolName || "",
    shortcutName: input.shortcutName || "",
    args: input.args ?? "",
    createdAt: Date.now(),
  }
  const f = readFile()
  writeFile({ pending: prunePending(f.pending).concat([rec]), done: f.done })
  return rec
}

/** 一条回传处理完了：从 pending 里拿掉，并记进 done（用于去重）。 */
export function finishPending(cid: string): void {
  const f = readFile()
  writeFile({
    pending: f.pending.filter((p) => p.cid !== cid),
    done: f.done.concat([{ cid, at: Date.now() }]),
  })
}

// ———————————————————————— 回调 URL 上带回来的东西 ————————————————————————

function pickText(params: any, keys: string[]): string {
  if (!params || typeof params !== "object") return ""
  for (let i = 0; i < keys.length; i++) {
    const v = params[keys[i]]
    if (typeof v === "string" && v.trim()) return v
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    if (v && typeof v === "object") {
      try {
        return JSON.stringify(v)
      } catch {
        // 循环引用之类，忽略
      }
    }
  }
  return ""
}

/** 回调 URL 上带回来的结果文本；没有就返回空串。 */
export function callbackResultOf(params: any): string {
  return pickText(params, ["result", "text", "output", "结果", "回传", "内容"])
}

/** 一次回传的处理结果（聊天页拿它来续跑一轮）。 */
export interface CallbackOutcome {
  /** 落到哪个会话（已经写盘，并且把它设成了当前会话）。 */
  sessionId: string
  sessionTitle: string
  /** 记进会话的文本，同时也是续跑这一轮的输入。 */
  text: string
  /** 对上的工具（没对上就是空串）。 */
  toolName: string
  shortcutName: string
  /** 有没有回填到过程卡片上的那一步。 */
  patched: boolean
}

/** 在会话里找带这个 cid 的那一步。 */
function findStep(
  store: SessionStore,
  cid: string,
): { session: Session; msg: number; step: number } | null {
  for (let si = 0; si < store.sessions.length; si++) {
    const s = store.sessions[si]
    const msgs = s.messages ?? []
    for (let mi = 0; mi < msgs.length; mi++) {
      const steps = msgs[mi].steps ?? []
      for (let k = 0; k < steps.length; k++) {
        if (steps[k].cid === cid) return { session: s, msg: mi, step: k }
      }
    }
  }
  return null
}

/** 回传给模型看的那条文本（落进会话当隐藏上下文，聊天界面不显示）。 */
export function callbackText(shortcutName: string, result: string): string {
  const who = shortcutName ? `快捷指令「${shortcutName}」` : "快捷指令"
  return (
    `【工具回传】${who}返回：\n` + result +
    "\n\n（这是刚才调用工具的回传结果，结合它继续回答；不要再说拿不到结果，也不要重复调用。）"
  )
}

/**
 * 处理一次回传。params 来自 `Script.queryParameters` 或 `Script.onResume` 的事件详情。
 * 不是回传（没有 result）就返回 null。
 */
export function handleCallback(params: any): CallbackOutcome | null {
  const result = callbackResultOf(params)
  if (!result) return null

  const now = Date.now()
  const f = readFile()
  const pending = prunePending(f.pending, now)
  const wantedCid = pickText(params, ["cid", "id"])
  // 同一条回传送达两次（比如冷启动那次已经在 mount 时处理过）就忽略
  if (wantedCid && f.done.some((d) => d.cid === wantedCid)) return null

  let idx = -1
  if (wantedCid) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].cid === wantedCid) {
        idx = i
        break
      }
    }
  }
  const hint = pickText(params, ["tool", "name", "shortcut", "工具", "快捷指令"])
  if (idx < 0 && hint) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]
      if (p.shortcutName === hint || p.toolName === hint) {
        idx = i
        break
      }
    }
  }
  // 没给线索（普通的回调 URL 就是这样）：认最近一次触发的那个
  if (idx < 0 && pending.length > 0) idx = pending.length - 1
  const matched: PendingCall | null = idx >= 0 ? pending[idx] : null

  const store = loadStore()
  const hit = matched ? findStep(store, matched.cid) : null
  let session: Session | null = null
  if (hit) {
    for (let i = 0; i < store.sessions.length; i++) {
      if (store.sessions[i].id === hit.session.id) session = store.sessions[i]
    }
  }
  if (!session) {
    for (let i = 0; i < store.sessions.length; i++) {
      if (store.sessions[i].id === store.currentId) session = store.sessions[i]
    }
  }
  if (!session) session = makeSession()

  const shortcutName = matched?.shortcutName || hint || ""
  const text = callbackText(shortcutName, result)

  // ① 回填过程卡片上的那一步（结果被真实回传覆盖，标上「已回传」）
  const msgs: ChatMessage[] = (session.messages ?? []).slice()
  let patched = false
  if (hit && msgs[hit.msg] && msgs[hit.msg].steps) {
    const m: ChatMessage = { ...msgs[hit.msg] }
    const steps: ToolStep[] = (m.steps ?? []).slice()
    steps[hit.step] = { ...steps[hit.step], result, ok: true, callback: true }
    m.steps = steps
    msgs[hit.msg] = m
    patched = true
  }

  // ② 回传本身不落在这里 —— 交给聊天页的 send() 记下来（带上 hidden 标记，界面上不画），
  //    否则这条消息会在历史里出现两次（send 会自己把它加进历史）。
  const updated: Session = {
    ...session,
    updatedAt: now,
    title: session.title === NEW_SESSION_TITLE ? deriveTitle(msgs.concat([{ role: "user", content: text, hidden: true }])) : session.title,
    messages: msgs,
  }
  const next = upsertSession(store, updated)
  saveStore(next)
  if (matched) finishPending(matched.cid)

  return {
    sessionId: updated.id,
    sessionTitle: updated.title,
    text,
    toolName: matched?.toolName ?? "",
    shortcutName,
    patched,
  }
}
