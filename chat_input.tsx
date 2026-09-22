import {
  Button, HStack, Image, ScrollView, Text, TextField,
} from "scripting"
import { SessionMounts } from "./agent_store"
import { mountChips } from "./mount_page"

/**
 * 会话挂载的 chip 行：只有这个会话单独挂载过东西才显示。
 * 点「本轮挂载」或任意 chip 都能打开挂载面板。
 */
export function MountStrip({ mounts, onOpen }: { mounts?: SessionMounts; onOpen: () => void }) {
  if (!mounts) return null
  return (
    <ScrollView axes="horizontal">
      <HStack spacing={6} padding={{ horizontal: 12 }}>
        <Button action={onOpen}>
          <Text font="caption2" foregroundStyle="tertiaryLabel">本轮挂载</Text>
        </Button>
        {mountChips(mounts).map((c) => (
          <Button key={c.key} action={onOpen}>
            <Text font="caption2" foregroundStyle="secondaryLabel">{c.label}</Text>
          </Button>
        ))}
      </HStack>
    </ScrollView>
  )
}

/**
 * 底部输入栏：+号打开挂载、胶囊输入框、发送按钮。
 * 纯展示——状态与事件全由父级传入。
 */
export function ChatInputBar({
  input, onInput, onSend, sendEnabled, busy, hasMounts, onOpenMounts,
}: {
  input: string
  onInput: (v: string) => void
  onSend: () => void
  sendEnabled: boolean
  busy: boolean
  hasMounts: boolean
  onOpenMounts: () => void
}) {
  return (
    <HStack spacing={8} padding={{ horizontal: 12, top: 8, bottom: 10 }}>
      <Button action={onOpenMounts} disabled={busy}>
        <Image
          systemName="plus.circle.fill"
          font="title2"
          foregroundStyle={hasMounts ? "systemBlue" : "tertiaryLabel"}
        />
      </Button>
      <HStack
        padding={{ horizontal: 14, vertical: 9 }}
        background="tertiarySystemFill"
        clipShape="capsule"
        frame={{ maxWidth: "infinity" }}
      >
        <TextField
          title=""
          prompt="说点什么…"
          value={input}
          onChanged={onInput}
          submitLabel="send"
          onSubmit={onSend}
        />
      </HStack>
      <Button action={onSend} disabled={!sendEnabled}>
        <Image
          systemName="arrow.up.circle.fill"
          font="title2"
          foregroundStyle={sendEnabled ? "systemBlue" : "tertiaryLabel"}
        />
      </Button>
    </HStack>
  )
}
