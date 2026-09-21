import {
  Button,
  Divider,
  HStack,
  Image,
  List,
  Text,
  VStack,
} from "scripting"
import type { SessionStore } from "./agent_store"
import { Avatar, AvatarSpec } from "./avatar"

export const DRAWER_WIDTH = 288
/** 抽屉右侧两角的圆角（左侧贴屏幕边，保持直角）*/
export const DRAWER_RADIUS = 24

/**
 * 整体走 iOS 单色风格：一律灰底 + label 文字，
 * 不用蓝色字体做强调，需要强调的行用更深的灰底 + 加粗。
 */
const FILL = "rgba(120,120,128,0.10)"
const FILL_STRONG = "rgba(120,120,128,0.22)"
const CARD_RADIUS = 14

/**
 * 行底必须显式设为透明：
 * List 默认会给每行铺一层不透明底色，行间距（listRowSpacing）处会露出
 * 一道道横条；换掉它才会透出抽屉自己的白底。
 * 代价是分隔线会跟着露出来，所以每行还要 listRowSeparator="hidden"。
 */
const rowStyle = {
  listRowBackground: (
    <VStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="clear"
    />
  ),
  listRowSeparator: "hidden" as const,
}

export function timeLabel(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  if (sameDay) return `今天 ${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

interface Props {
  store?: SessionStore
  agentName?: string
  avatar?: AvatarSpec
  onSelect?: (id: string) => void
  onNew?: () => void
  onDelete?: (id: string) => void
  onSettings?: () => void
}

export function Sidebar({
  store,
  agentName = "小助",
  avatar = {},
  onSelect = () => {},
  onNew = () => {},
  onDelete = () => {},
  onSettings = () => {},
}: Props) {
  const sessions = store ? store.sessions : []
  const currentId = store ? store.currentId : ""
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <VStack
      spacing={0}
      frame={{ width: DRAWER_WIDTH, maxHeight: "infinity" }}
      background="systemBackground"
      clipShape={{
        type: "rect",
        cornerRadii: { topTrailing: DRAWER_RADIUS, bottomTrailing: DRAWER_RADIUS },
      }}
    >
      {/* 头部：角色 */}
      <HStack
        spacing={12}
        padding={{ horizontal: 20, top: 22, bottom: 18 }}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        <Avatar spec={avatar} size={46} background="tertiarySystemFill" />
        <VStack alignment="leading" spacing={3}>
          <Text font="title3" fontWeight="semibold" lineLimit={1}>
            {agentName}
          </Text>
          <Text font="caption" foregroundStyle="secondaryLabel">
            {sessions.length} 个会话
          </Text>
        </VStack>
      </HStack>

      <Divider />

      {/* 主体 */}
      <List
        listStyle="plain"
        listRowSpacing={6}
        listRowInsets={{ top: 0, bottom: 0, leading: 14, trailing: 14 }}
        background="systemBackground"
      >
        <Button
          action={onNew}
          {...rowStyle}
          listRowInsets={{ top: 6, bottom: 0, leading: 14, trailing: 14 }}
        >
          <HStack
            spacing={10}
            padding={{ horizontal: 12, vertical: 12 }}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            background={FILL_STRONG}
            clipShape={{ type: "rect", cornerRadius: CARD_RADIUS }}
          >
            <Image
              systemName="square.and.pencil"
              font="subheadline"
              foregroundStyle="label"
            />
            <Text
              font="subheadline"
              fontWeight="semibold"
              foregroundStyle="label"
            >
              开启新会话
            </Text>
          </HStack>
        </Button>

        <Text
          font="caption"
          fontWeight="medium"
          foregroundStyle="secondaryLabel"
          padding={{ top: 14, bottom: 2, leading: 4 }}
          {...rowStyle}
        >
          最近对话
        </Text>

        {sorted.map((s) => {
          const isCurrent = s.id === currentId
          return (
            <Button
              key={s.id}
              action={() => onSelect(s.id)}
              {...rowStyle}
              trailingSwipeActions={{
                actions: [
                  <Button
                    title="删除"
                    role="destructive"
                    action={() => onDelete(s.id)}
                  />,
                ],
              }}
            >
              <HStack
                spacing={8}
                padding={{ horizontal: 12, vertical: 11 }}
                frame={{ maxWidth: "infinity" }}
                background={isCurrent ? FILL_STRONG : FILL}
                clipShape={{ type: "rect", cornerRadius: CARD_RADIUS }}
              >
                <VStack
                  alignment="leading"
                  spacing={3}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  <Text
                    lineLimit={1}
                    font="subheadline"
                    fontWeight={isCurrent ? "semibold" : "regular"}
                    foregroundStyle="label"
                  >
                    {s.title}
                  </Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">
                    {timeLabel(s.updatedAt)} · {s.messages.filter((m) => !m.hidden).length} 条
                  </Text>
                </VStack>
                {isCurrent ? (
                  <Image
                    systemName="checkmark.circle.fill"
                    font="footnote"
                    foregroundStyle="secondaryLabel"
                  />
                ) : null}
              </HStack>
            </Button>
          )
        })}
      </List>

      <Divider />

      {/* 底部：设置 */}
      <Button action={onSettings}>
        <HStack
          spacing={10}
          padding={{ horizontal: 20, vertical: 16 }}
          frame={{ maxWidth: "infinity" }}
        >
          <Image systemName="gearshape" foregroundStyle="secondaryLabel" />
          <Text
            font="body"
            foregroundStyle="label"
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            设置
          </Text>
          <Image
            systemName="chevron.right"
            font="footnote"
            foregroundStyle="tertiaryLabel"
          />
        </HStack>
      </Button>
    </VStack>
  )
}

export default Sidebar
