import {
  Button, HStack, Image, Navigation, NavigationStack, ProgressView, ScrollView, Spacer,
  Text, TextField, Toolbar, ToolbarItem, VStack, ZStack, useState,
} from "scripting"
import {
  AgentConfig, ChatMessage, SessionStore, capMessages, deriveTitle, loadConfig, loadStore,
  makeSession, removeSession, saveStore, upsertSession, withCurrentSession,
} from "./agent_store"
import { dictate, runAgent } from "./agent_core"
import { finishActivity, startThinking, updateThinking } from "./live_activity"
import { ConfigPage } from "./config_page"
import { VoicePage } from "./voice_page"
import { DRAWER_WIDTH, Sidebar } from "./sidebar"
import { Avatar, AvatarSpec } from "./avatar"

function excerpt(text: string): string {
  const t = (text ?? "").trim()
  return t.length > 60 ? t.slice(0, 60) + "…" : t
}

function Bubble({ message, avatar }: { message: ChatMessage; avatar: AvatarSpec }) {
  const isUser = message.role === "user"
  return (
    <HStack
      spacing={8}
      alignment="bottom"
      padding={{ horizontal: 12, vertical: 4 }}
      frame={{ maxWidth: "infinity" }}
    >
      {isUser ? <Spacer /> : <Avatar spec={avatar} />}
      <VStack
        padding={{ horizontal: 14, vertical: 10 }}
        background={isUser ? "systemBlue" : "secondarySystemFill"}
        clipShape={{ type: "rect", cornerRadius: 18 }}
        frame={{ maxWidth: 280, alignment: isUser ? "trailing" : "leading" }}
      >
        <Text foregroundStyle={isUser ? "white" : "label"}>{message.content}</Text>
      </VStack>
      {isUser ? null : <Spacer />}
    </HStack>
  )
}

function ThinkingBubble({ avatar }: { avatar: AvatarSpec }) {
  return (
    <HStack
      spacing={8}
      alignment="bottom"
      padding={{ horizontal: 12, vertical: 4 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Avatar spec={avatar} />
      <HStack
        spacing={8}
        padding={{ horizontal: 14, vertical: 10 }}
        background="secondarySystemFill"
        clipShape={{ type: "rect", cornerRadius: 18 }}
      >
        <ProgressView controlSize="small" />
        <Text font="footnote" foregroundStyle="secondaryLabel">思考中…</Text>
      </HStack>
      <Spacer />
    </HStack>
  )
}

/** 空会话时的「角色登场」界面。 */
function EmptyState({ name, avatar, greet }: { name: string; avatar: AvatarSpec; greet: string }) {
  return (
    <VStack
      spacing={12}
      padding={{ horizontal: 28, vertical: 56 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Avatar spec={avatar} size={76} />
      <Text font="title3" fontWeight="bold">{name}</Text>
      <Text font="subheadline" foregroundStyle="secondaryLabel">{greet}</Text>
    </VStack>
  )
}

export function ChatPage() {
  const dismiss = Navigation.useDismiss()
  const [cfg, setCfg] = useState<AgentConfig>(() => loadConfig())
  const [store, setStore] = useState<SessionStore>(() => withCurrentSession(loadStore()).store)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showVoice, setShowVoice] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const current = store.sessions.find((s) => s.id === store.currentId) ?? null
  const messages = current?.messages ?? []

  function apply(next: SessionStore) {
    saveStore(next)
    setStore(next)
  }

  function closeSettings() {
    setShowSettings(false)
    setCfg(loadConfig())
  }

  function openSettings() {
    setDrawerOpen(false)
    setShowSettings(true)
  }

  /** 进入语音通话模式（文本聊天模式永远不朗读）。 */
  function openVoice() {
    if (!cfg.apiKey) {
      Dialog.alert({ message: "还没配置：点右上角齿轮填一下 API Key" })
      setShowSettings(true)
      return
    }
    setDrawerOpen(false)
    setShowVoice(true)
  }

  function closeVoice() {
    setShowVoice(false)
    setStore(loadStore())
    setCfg(loadConfig())
  }

  function newSession() {
    setDrawerOpen(false)
    if (current && current.messages.length === 0) return // 当前已经是空会话
    const s = makeSession()
    apply({ currentId: s.id, sessions: [s, ...store.sessions] })
  }

  function selectSession(id: string) {
    setDrawerOpen(false)
    apply({ ...store, currentId: id })
  }

  function deleteSession(id: string) {
    apply(withCurrentSession(removeSession(store, id)).store)
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return

    if (!cfg.apiKey) {
      Dialog.alert({ message: "还没配置：点右上角齿轮填一下 API Key" })
      setShowSettings(true)
      return
    }

    const base = current ?? makeSession()
    const isFirst = base.messages.length === 0

    setBusy(true)
    setInput("")
    await startThinking("正在思考…")

    try {
      const { reply, newHistory } = await runAgent(trimmed, cfg, base.messages, (e) => {
        void updateThinking(`正在调用「${e.target}」…`)
      })
      const capped = capMessages(newHistory, cfg.maxHistory)
      apply(
        upsertSession(store, {
          ...base,
          messages: capped,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(capped) : base.title,
        }),
      )
      await finishActivity("done", excerpt(reply) || "完成")
    } catch (e: any) {
      const errMsg = "出错：" + (e?.message ?? String(e))
      const failed: ChatMessage[] = [
        ...base.messages,
        { role: "user", content: trimmed },
        { role: "assistant", content: errMsg },
      ]
      apply(
        upsertSession(store, {
          ...base,
          messages: failed,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(failed) : base.title,
        }),
      )
      await finishActivity("error", excerpt(errMsg) || "出错")
    } finally {
      setBusy(false)
    }
  }

  async function onDictate() {
    if (busy) return
    setBusy(true)
    let text = ""
    try {
      text = await dictate()
    } catch (e: any) {
      Dialog.alert({ message: "听写失败：" + (e?.message ?? String(e)) })
    } finally {
      setBusy(false)
    }
    if (text) {
      await send(text)
    }
  }

  const sendEnabled = !busy && input.trim().length > 0
  const avatar: AvatarSpec = { emoji: cfg.agentEmoji || "✨", path: cfg.avatarPath }

  return (
    <NavigationStack>
      <ZStack
        alignment="topLeading"
        navigationTitle={cfg.agentName || "智能体"}
        navigationBarTitleDisplayMode="inline"
        toolbar={
          <Toolbar>
            <ToolbarItem placement="topBarLeading">
              <Button title="☰" action={() => setDrawerOpen((v) => !v)} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button title="完成" action={() => dismiss()} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button title="设置" action={openSettings} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button title="语音" action={openVoice} />
            </ToolbarItem>
          </Toolbar>
        }
        sheet={{
          content: <ConfigPage onClose={closeSettings} />,
          isPresented: showSettings,
          onChanged: (v: boolean) => {
            setShowSettings(v)
            if (!v) setCfg(loadConfig())
          },
        }}
        fullScreenCover={{
          content: (
            <VoicePage
              store={store}
              cfg={cfg}
              onStore={apply}
              onClose={closeVoice}
            />
          ),
          isPresented: showVoice,
          onChanged: (v: boolean) => {
            if (!v) closeVoice()
          },
        }}
      >
        {/* 主内容 */}
        <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <ScrollView defaultScrollAnchor="bottom" scrollDismissesKeyboard="interactively">
          <VStack spacing={0} padding={{ top: 12, bottom: 16 }}>
            {messages.length === 0 ? (
              <EmptyState name={cfg.agentName || "智能体"} avatar={avatar} greet={cfg.greetText} />
            ) : null}
            {messages.map((m, i) => (
              <Bubble key={"m" + i} message={m} avatar={avatar} />
            ))}
            {busy ? <ThinkingBubble avatar={avatar} /> : null}
          </VStack>
        </ScrollView>

        <HStack spacing={8} padding={{ horizontal: 12, top: 8, bottom: 10 }}>
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
              onChanged={setInput}
              submitLabel="send"
              onSubmit={() => send(input)}
            />
          </HStack>
          <Button action={onDictate} disabled={busy}>
            <Image systemName="mic.fill" font="body" foregroundStyle="systemBlue" />
          </Button>
          <Button action={() => send(input)} disabled={!sendEnabled}>
            <Image
              systemName="arrow.up.circle.fill"
              font="title2"
              foregroundStyle={sendEnabled ? "systemBlue" : "tertiaryLabel"}
            />
          </Button>
        </HStack>
        </VStack>

        {/* 遮罩：点一下关抽屉 */}
        <VStack
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          background="black"
          opacity={drawerOpen ? 0.28 : 0}
          allowsHitTesting={drawerOpen}
          onTapGesture={() => setDrawerOpen(false)}
          animation={{ animation: Animation.easeOut(0.22), value: drawerOpen }}
        />

        {/* 左侧抽屉（不要阴影：会与主内容之间拉出灰条）*/}
        <VStack
          offset={{ x: drawerOpen ? 0 : -DRAWER_WIDTH, y: 0 }}
          allowsHitTesting={drawerOpen}
          animation={{ animation: Animation.easeOut(0.22), value: drawerOpen }}
        >
          <Sidebar
            store={store}
            agentName={cfg.agentName || "小助"}
            avatar={avatar}
            onSelect={selectSession}
            onNew={newSession}
            onDelete={deleteSession}
            onSettings={openSettings}
          />
        </VStack>
      </ZStack>
    </NavigationStack>
  )
}

export default ChatPage
