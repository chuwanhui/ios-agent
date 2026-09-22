import {
  Button, Navigation, NavigationStack, ScrollView, Toolbar, ToolbarItem, VStack, ZStack, useEffect, useState,
} from "scripting"
import {
  AgentConfig, ChatMessage, SessionMounts, SessionStore, ToolStep, capMessages,
  deriveTitle, effectiveConfig, loadConfig, loadStore, makeSession, removeSession, saveStore,
  upsertSession, withCurrentSession,
} from "./agent_store"
import { runAgent } from "./agent_core"
import { ConfigPage } from "./config_page"
import { MountPage } from "./mount_page"
import { DRAWER_WIDTH, Sidebar } from "./sidebar"
import { AvatarSpec } from "./avatar"
import { AssistantMessage, Bubble, EmptyState, LiveThinking } from "./message_bubble"
import { ChatInputBar, MountStrip } from "./chat_input"
import { useCallbackAutoJob } from "./callback"

export function ChatPage() {
  const dismiss = Navigation.useDismiss()
  const [cfg, setCfg] = useState<AgentConfig>(() => loadConfig())
  const [store, setStore] = useState<SessionStore>(() => withCurrentSession(loadStore()).store)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showMounts, setShowMounts] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 正在跑的这一轮的过程（实时画在聊天流里，结束后随消息落库）。
  const [liveReasoning, setLiveReasoning] = useState("")
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([])
  const [liveText, setLiveText] = useState("")

  // 快捷指令回传：两条入口（冷启动 URL / 被唤起 onResume）统一接在这里，
  // 解析出文本就刷新 config/store，等不忙了再 hidden 续跑。
  useCallbackAutoJob({
    onConsumed: () => {
      setCfg(loadConfig())
      setStore(loadStore())
    },
    onFire: (text) => void send(text, { hidden: true }),
    busy,
  })

  const current = store.sessions.find((s) => s.id === store.currentId) ?? null
  const messages = current?.messages ?? []
  /** 界面上真正画出来的消息：hidden 的那些（工具回传）只进上下文，不上屏。 */
  const visible = messages.filter((m) => !m.hidden)

  function apply(next: SessionStore) {
    saveStore(next)
    setStore(next)
  }

  function closeSettings() {
    setShowSettings(false)
    setCfg(loadConfig())
  }

  /** 会话级挂载：改了就跟着这个会话一起存（历史 / 挂载都在一起）。 */
  function setMounts(next?: SessionMounts) {
    const base = current ?? makeSession()
    apply(upsertSession(store, { ...base, mounts: next }))
  }

  /** 进入设置页（先收起抽屉）。 */
  function openSettings() {
    setDrawerOpen(false)
    setShowSettings(true)
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

  /** hidden：这条输入不在聊天界面显示，只作为上下文喂给模型（工具回传续跑走这里）。 */
  async function send(text: string, opts?: { hidden?: boolean }) {
    const trimmed = text.trim()
    if (!trimmed || busy) return

    if (!cfg.apiKey) {
      Dialog.alert({ message: "还没配置：点右上角齿轮填一下 API Key" })
      setShowSettings(true)
      return
    }

    const base = current ?? makeSession()
    const isFirst = base.messages.length === 0
    // 这个会话的挂载：助手中途给自己登记了新工具的话，要把新工具并进来，
    // 否则会话挂载会把它过滤掉，下一轮它就看不见了。
    let mountsNow = base.mounts

    setBusy(true)
    setInput("")
    const userMsg: ChatMessage = { role: "user", content: trimmed, hidden: opts?.hidden ? true : undefined }
    apply(upsertSession(store, { ...base, messages: [...base.messages, userMsg], updatedAt: Date.now() }))
    setLiveReasoning("")
    setLiveSteps([])
    setLiveText("")

    // 流式增量一秒能来几十次，合并到 ~60ms 刷一次，免得把界面刷爆。
    let pendingText = ""
    let pendingReasoning = ""
    let pendingSegment = false
    let lastFlush = 0
    const flush = () => {
      lastFlush = Date.now()
      if (pendingText) {
        const t = pendingText
        pendingText = ""
        setLiveText((prev) => prev + t)
      }
      if (pendingReasoning) {
        const r = pendingReasoning
        const sep = pendingSegment ? "\n\n" : ""
        pendingReasoning = ""
        pendingSegment = false
        setLiveReasoning((prev) => (prev ? prev + sep + r : r))
      }
    }

    try {
      // 会话级挂载在这里生效：工具 / MCP / 技能 / 知识库都按这个会话挂的来
      const eff = effectiveConfig(cfg, base.mounts)
      const { reply, newHistory } = await runAgent(trimmed, eff, base.messages, {
        onEvent: () => {
          // 调工具前可能擦过一句开场白，它不在最终回答里，清掉免得一闪就没
          pendingText = ""
          setLiveText("")
        },
        onStep: (s) => setLiveSteps((prev) => [...prev, s]),
        onToolsCreated: (names) => {
          setCfg(loadConfig())
          if (!mountsNow) return // 没单独挂载过 = 用设置里的全部工具，新工具自然可见
          const set = new Set(mountsNow.tools)
          let changed = false
          for (const n of names) {
            if (!set.has(n)) {
              set.add(n)
              changed = true
            }
          }
          if (changed) mountsNow = { ...mountsNow, tools: Array.from(set) }
        },
        onDelta: (d) => {
          if (d.reset) {
            pendingText = ""
            pendingReasoning = ""
            pendingSegment = false
            setLiveText("")
            setLiveReasoning("")
            return
          }
          if (d.type === "text") {
            pendingText += d.content
          } else {
            if (d.newSegment) pendingSegment = true
            pendingReasoning += d.content
          }
          if (Date.now() - lastFlush >= 60) flush()
        },
      }, { hiddenInput: opts?.hidden })
      flush()
      const capped = capMessages(newHistory, cfg.maxHistory)
      apply(
        upsertSession(store, {
          ...base,
          mounts: mountsNow,
          messages: capped,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(capped) : base.title,
        }),
      )
    } catch (e: any) {
      const errMsg = "出错：" + (e?.message ?? String(e))
      const failed: ChatMessage[] = [
        ...base.messages,
        { role: "user", content: trimmed, hidden: opts?.hidden ? true : undefined },
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
    } finally {
      setBusy(false)
      setLiveReasoning("")
      setLiveSteps([])
      setLiveText("")
    }
  }

  const sendEnabled = !busy && input.trim().length > 0
  const avatar: AvatarSpec = { path: cfg.avatarPath }

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
          </Toolbar>
        }
        sheet={[
          {
            content: <ConfigPage onClose={closeSettings} />,
            isPresented: showSettings,
            onChanged: (v: boolean) => {
              setShowSettings(v)
              if (!v) setCfg(loadConfig())
            },
          },
          {
            content: (
              <MountPage
                cfg={cfg}
                mounts={current?.mounts}
                onChange={setMounts}
                onClose={() => setShowMounts(false)}
              />
            ),
            isPresented: showMounts,
            onChanged: setShowMounts,
          },
        ]}
      >
        {/* 主内容 */}
        <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <ScrollView defaultScrollAnchor="bottom" scrollDismissesKeyboard="interactively">
          <VStack spacing={0} padding={{ top: 12, bottom: 16 }}>
            {visible.length === 0 ? (
              <EmptyState name={cfg.agentName || "智能体"} avatar={avatar} />
            ) : null}
            {visible.map((m, i) =>
              m.role === "user" ? (
                <Bubble key={"m" + i} message={m} avatar={avatar} />
              ) : (
                <AssistantMessage
                  key={"m" + i}
                  message={m}
                  avatar={avatar}
                  showSteps={cfg.showSteps !== false}
                />
              ),
            )}
            {busy ? (
              <LiveThinking
                avatar={avatar}
                reasoning={liveReasoning}
                steps={liveSteps}
                text={liveText}
                showSteps={cfg.showSteps !== false}
              />
            ) : null}
          </VStack>
        </ScrollView>

        {current?.mounts ? (
          <MountStrip mounts={current?.mounts} onOpen={() => setShowMounts(true)} />
        ) : null}

        <ChatInputBar
          input={input}
          onInput={setInput}
          onSend={() => send(input)}
          sendEnabled={sendEnabled}
          busy={busy}
          hasMounts={!!current?.mounts}
          onOpenMounts={() => setShowMounts(true)}
        />
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