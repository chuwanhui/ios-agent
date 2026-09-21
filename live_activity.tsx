import {
  Button,
  HStack,
  Image,
  Label,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIBuilder,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  ProgressView,
  Script,
  Text,
  VStack,
} from "scripting"
import { AgentActivityAction } from "./app_intents"

/**
 * 灵动岛 / 锁屏上的「智能体」活动。
 *
 * 一轮问答共用同一个 Live Activity，靠 contentState 切 UI：
 *   thinking   → 头像 + 阶段 + 进度圈 + 按钮
 *   done/error → 头像 + ✓/! + 一句摘要，结束后仍留在岛上（默认 3 分钟）
 *
 * 几条硬约束（来自 create-live-activity 技能）：
 *  - contentState 必须是可 JSON 序列化的纯数据（所以头像只传路径，不传对象）；
 *  - 扩展里读不到 documents / iCloud 目录，只有 appGroup 里的文件能显示出来 → 头像存在 appGroup；
 *  - 活动注册必须写在独立的 `live_activity.tsx` 里。
 */

export type AgentActivityPhase = "thinking" | "done" | "error"

export interface AgentActivityState {
  phase: AgentActivityPhase
  /** 一句话摘要（问题 / 正在调用哪个工具 / 回答摘要）。 */
  text: string
  /** 助手名字。 */
  title: string
  /** 自定义头像的绝对路径（appGroup 内）；没有则用 emoji。 */
  avatar?: string
  /** 没照片时的兜底 emoji。 */
  emoji: string
}

// ———————————————————————— 常量 ————————————————————————

/** 结束后在锁屏 / 灵动岛继续停留的秒数：回答完了别急着走，还能点一下回到对话。 */
export const KEEP_AFTER_END = 180
/** 超过这么久没更新，就交给系统标记为「已过期」，避免后台跑飞了留一张僵尸卡片。 */
const STALE_AFTER = 120

// 这些路径都放在函数里取：`live_activity.tsx` 在扩展环境也会被加载，
// 那里拿不到 appGroup 时不能让整个模块挂掉。
function agentDir(): string {
  try {
    return FileManager.appGroupDocumentsDirectory + "/agent"
  } catch {
    return ""
  }
}

interface Identity {
  title: string
  emoji: string
  avatar?: string
}

/** 从 config.json 读助手形象（在主进程调用，扩展进程不需要读）。 */
function readIdentity(): Identity {
  const fallback: Identity = { title: "智能体", emoji: "✨" }
  try {
    const file = agentDir() + "/config.json"
    if (!agentDir() || !FileManager.existsSync(file)) return fallback

    const cfg: any = JSON.parse(FileManager.readAsStringSync(file)) ?? {}
    const id: Identity = {
      title: typeof cfg.agentName === "string" && cfg.agentName.trim() ? cfg.agentName.trim() : fallback.title,
      emoji: typeof cfg.agentEmoji === "string" && cfg.agentEmoji.trim() ? cfg.agentEmoji.trim() : fallback.emoji,
    }
    const path = cfg.avatarPath
    if (typeof path === "string" && path && FileManager.existsSync(path)) {
      id.avatar = path
    }
    return id
  } catch {
    return fallback
  }
}

/**
 * 记一行活动流水（保留最近 12 条）。
 * 后台跑（快捷指令 / Siri）时看不见日志，就靠这个文件事后排查。
 */
function logActivity(event: string, detail: Record<string, any> = {}): void {
  try {
    const dir = agentDir()
    if (!dir) return
    const file = dir + "/activity.log.json"

    let list: any[] = []
    if (FileManager.existsSync(file)) {
      try {
        list = JSON.parse(FileManager.readAsStringSync(file))
      } catch {
        list = []
      }
    }
    if (!Array.isArray(list)) list = []

    let env = "?"
    try {
      env = Script.env
    } catch {
      env = "?"
    }

    list.push({ at: new Date().toISOString(), env, event, ...detail })
    while (list.length > 12) list.shift()

    FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(file, JSON.stringify(list))
  } catch {
    // 纯观测用，不能影响主流程
  }
}

// ———————————————————————— 视图 ————————————————————————

function iconName(phase: AgentActivityPhase): string {
  switch (phase) {
    case "thinking":
      return "sparkles"
    case "done":
      return "checkmark.circle.fill"
    default:
      return "exclamationmark.triangle.fill"
  }
}

function tint(phase: AgentActivityPhase): "systemPurple" | "systemGreen" | "systemRed" {
  switch (phase) {
    case "thinking":
      return "systemPurple"
    case "done":
      return "systemGreen"
    default:
      return "systemRed"
  }
}

function label(phase: AgentActivityPhase): string {
  switch (phase) {
    case "thinking":
      return "思考中"
    case "done":
      return "完成"
    default:
      return "出错"
  }
}

/** 头像：有照片就用照片，否则用 emoji。灵动岛那块地方很小，emoji 字号按尺寸挑。 */
function AvatarNode({ state, size }: { state: AgentActivityState; size: number }) {
  if (state.avatar) {
    return <Image filePath={state.avatar} resizable frame={{ width: size, height: size }} clipShape="circle" />
  }
  const font = size >= 32 ? "title2" : size >= 24 ? "callout" : "caption"
  return <Text font={font}>{state.emoji || "✨"}</Text>
}

const builder: LiveActivityUIBuilder<AgentActivityState> = (state) => (
  <LiveActivityUI
    content={
      <HStack spacing={10}>
        <AvatarNode state={state} size={36} />
        <VStack alignment="leading" spacing={2}>
          <Text font="headline">{`${state.title} · ${label(state.phase)}`}</Text>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {state.text}
          </Text>
        </VStack>
      </HStack>
    }
    compactLeading={<AvatarNode state={state} size={22} />}
    compactTrailing={
      <Text font="caption2" foregroundStyle={tint(state.phase)}>
        {label(state.phase)}
      </Text>
    }
    minimal={<AvatarNode state={state} size={16} />}
  >
    <LiveActivityUIExpandedLeading>
      <AvatarNode state={state} size={34} />
    </LiveActivityUIExpandedLeading>
    <LiveActivityUIExpandedCenter>
      <VStack alignment="leading" spacing={2}>
        <Text font="headline">{`${state.title} · ${label(state.phase)}`}</Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">
          {state.text}
        </Text>
      </VStack>
    </LiveActivityUIExpandedCenter>
    <LiveActivityUIExpandedBottom>
      <HStack spacing={8}>
        {state.phase === "thinking" ? <ProgressView /> : null}
        <Button intent={AgentActivityAction("stop")} role="destructive">
          <Label title="停止朗读" systemImage="stop.fill" />
        </Button>
        <Button intent={AgentActivityAction("replay")}>
          <Label title="再读一遍" systemImage="speaker.wave.2.fill" />
        </Button>
      </HStack>
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
)

export const AgentActivity = LiveActivity.register<AgentActivityState>("AgentActivity", builder)

let current: LiveActivity<AgentActivityState> | null = null

/** 当前脚本能不能起 Live Activity（用户可能在设置里关掉了）。 */
export async function activityEnabled(): Promise<boolean> {
  try {
    return await LiveActivity.areActivitiesEnabled()
  } catch {
    return false
  }
}

function stateOf(phase: AgentActivityPhase, text: string): AgentActivityState {
  const identity = readIdentity()
  const state: AgentActivityState = { phase, text, title: identity.title, emoji: identity.emoji }
  // 不写 undefined：contentState 要能 JSON 序列化
  if (identity.avatar) state.avatar = identity.avatar
  return state
}

/** 找回已经存在的活动实例：脚本重跑、快捷指令后台跑完之后还能接着 update / end。 */
async function ensureCurrent(): Promise<LiveActivity<AgentActivityState> | null> {
  if (current) return current
  try {
    const ids = await LiveActivity.getAllActivitiesIds()
    const id = ids && ids.length > 0 ? ids[ids.length - 1] : null
    if (!id) return null
    current = await LiveActivity.from<AgentActivityState>(id, "AgentActivity")
    return current
  } catch {
    return null
  }
}

/**
 * 开始一轮「思考中」。
 * 会先清掉上一次留下的卡片（不然灵动岛会叠着好几张）。
 * 后台运行时系统可能不允许启动，失败不抛错——回答照常进行。
 */
export async function startThinking(text: string): Promise<void> {
  try {
    const stale = await LiveActivity.getAllActivitiesIds()
    if (stale && stale.length > 0) {
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 })
    }
  } catch {
    // 清不掉就算了
  }

  try {
    const instance = AgentActivity()
    const ok = await instance.start(stateOf("thinking", text), {
      staleDate: Date.now() + STALE_AFTER * 1000,
    })
    current = ok ? instance : null
    logActivity("start", { ok, text })
  } catch (e: any) {
    current = null
    logActivity("start.failed", { message: String(e?.message ?? e) })
  }
}

/** 更新一下卡片上的文案（比如「正在调用『地图』…」）。 */
export async function updateThinking(text: string): Promise<void> {
  const instance = await ensureCurrent()
  if (!instance) {
    logActivity("update.skipped", { text })
    return
  }
  try {
    await instance.update(stateOf("thinking", text), {
      staleDate: Date.now() + STALE_AFTER * 1000,
    })
  } catch (e: any) {
    logActivity("update.failed", { message: String(e?.message ?? e) })
  }
}

/**
 * 结束这一轮。
 * 默认让卡片在锁屏 / 灵动岛上多留 `keepSeconds` 秒（点一下还能回到对话），
 * 想立刻收掉传 `0`。
 */
export async function finishActivity(
  phase: AgentActivityPhase,
  text: string,
  keepSeconds: number = KEEP_AFTER_END,
): Promise<void> {
  const instance = await ensureCurrent()
  current = null
  if (!instance) {
    logActivity("finish.skipped", { phase, text })
    return
  }
  try {
    await instance.end(stateOf(phase, text), { dismissTimeInterval: keepSeconds })
    logActivity("finish", { phase, text, keepSeconds })
  } catch (e: any) {
    logActivity("finish.failed", { message: String(e?.message ?? e) })
  }
}

/** 记下最后一次回复，岛上「再读一遍」按钮要用。 */
export function rememberReply(text: string): void {
  try {
    const dir = agentDir()
    if (!dir) return
    FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(dir + "/last_reply.txt", (text ?? "").trim())
  } catch {
    // 记不住不影响回答
  }
}

/** 收掉所有残留卡片（调试或退出时用）。 */
export async function clearActivities(): Promise<void> {
  current = null
  try {
    await LiveActivity.endAllActivities({ dismissTimeInterval: 0 })
  } catch {
    // 忽略
  }
}

/** 最近的活动流水，排查「岛上没反应」用。 */
export function readActivityLog(): any[] {
  try {
    const dir = agentDir()
    if (!dir) return []
    const file = dir + "/activity.log.json"
    if (!FileManager.existsSync(file)) return []
    const list = JSON.parse(FileManager.readAsStringSync(file))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

// 图标名集中一处，方便以后改。
export function phaseIcon(phase: AgentActivityPhase): string {
  return iconName(phase)
}
