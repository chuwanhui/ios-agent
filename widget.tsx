import { HStack, Image, Script, Spacer, Text, VStack, Widget } from "scripting"
import { loadConfig, loadStore } from "./agent_store"
import { Avatar } from "./avatar"

/**
 * 主屏启动器：桌面上的「智能体」卡片，点一下就进聊天页。
 *
 * 为什么要单独一个 widget：智能体的界面本体在 Scripting 里，iOS 不允许第三方
 * 脚本自己生成 App 图标 —— 所以「桌面启动」= 主屏上留一个入口，点它把 Scripting
 * 拉到前台并运行本脚本（index.tsx → 聊天页）。
 *
 * 两条可用通道（都写在这里了）：
 *  - `widgetURL`：整块卡片可点（SystemSmall 只能这样）；
 *  - `<Link>`：卡片里的局部热区（注意 `Link` 会让整块 widget 的 `widgetURL` 失效）。
 *
 * 不引 `agent_core` / `chat_page`：widget 扩展里只要配置和会话标题，别把网络、
 * 听写那些东西拖进来。
 */

/** 相对时间，widget 上够用就行（今天给时刻，否则给日期）。 */
function shortTime(ts: number): string {
  try {
    const d = new Date(ts)
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    const pad = (n: number) => (n < 10 ? "0" + n : String(n))
    if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes())
    if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + "月" + d.getDate() + "日"
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月"
  } catch {
    return ""
  }
}

interface Snapshot {
  name: string
  emoji: string
  avatarPath?: string
  /** 最近一次对话的一句话状态；没有会话就是空。 */
  recent: string
  needsKey: boolean
}

function snapshot(): Snapshot {
  let name = "智能体"
  let emoji = "🫧"
  let avatarPath: string | undefined
  let needsKey = false
  try {
    const cfg = loadConfig()
    if (cfg.agentName && cfg.agentName.trim()) name = cfg.agentName.trim()
    if (cfg.agentEmoji && cfg.agentEmoji.trim()) emoji = cfg.agentEmoji.trim()
    avatarPath = cfg.avatarPath
    needsKey = !cfg.apiKey
  } catch {
    // 配置还没建立：用默认形象
  }

  let recent = "还没有对话"
  try {
    const store = loadStore()
    const sessions = store.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    const cur = sessions[0]
    if (cur && cur.messages.length > 0) {
      recent = cur.title + " · " + shortTime(cur.updatedAt)
    } else if (cur) {
      recent = "「" + cur.title + "」还没开始"
    }
  } catch {
    // 会话文件还没建立
  }

  return { name, emoji, avatarPath, recent, needsKey }
}

/** 卡片里那一行小字：优先报告「还没填 Key」这种真的卡住的事。 */
function hintOf(snap: Snapshot): string {
  return snap.needsKey ? "还没填 API Key，点一下去设置" : "点一下开始对话"
}

function Launcher() {
  const snap = snapshot()
  const url = Script.createRunURLScheme("智能体", { from: "widget" })
  const small = Widget.family === "systemSmall"
  const hint = hintOf(snap)
  const hintColor = snap.needsKey ? "systemOrange" : "secondaryLabel"

  if (small) {
    return (
      <VStack
        alignment="leading"
        spacing={6}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        widgetURL={url}
      >
        <Avatar spec={{ emoji: snap.emoji, path: snap.avatarPath }} size={44} font="largeTitle" />
        <Spacer />
        <Text font="headline" fontWeight="bold" lineLimit={1}>
          {snap.name}
        </Text>
        <HStack spacing={4}>
          <Image systemName="sparkles" foregroundStyle={hintColor} />
          <Text font="caption2" foregroundStyle={hintColor} lineLimit={1}>
            {hint}
          </Text>
        </HStack>
      </VStack>
    )
  }

  return (
    <HStack
      spacing={14}
      alignment="center"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      widgetURL={url}
    >
      <Avatar spec={{ emoji: snap.emoji, path: snap.avatarPath }} size={54} font="title" />
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="title3" fontWeight="bold" lineLimit={1}>
          {snap.name}
        </Text>
        <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>
          {snap.recent}
        </Text>
        <HStack spacing={4}>
          <Image systemName="sparkles" foregroundStyle={hintColor} />
          <Text font="caption" foregroundStyle={hintColor} lineLimit={1}>
            {hint}
          </Text>
        </HStack>
      </VStack>
      <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

Widget.present(<Launcher />)
