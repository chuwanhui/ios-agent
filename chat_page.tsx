import {
  Button, HStack, Image, Navigation, NavigationStack, ProgressView, ScrollView, Script, Spacer,
  Text, TextField, Toolbar, ToolbarItem, VStack, ZStack, useEffect, useState,
} from "scripting"
import {
  AgentConfig, ChatMessage, SessionMounts, SessionStore, TokenUsage, ToolStep, capMessages,
  deriveTitle, effectiveConfig, loadConfig, loadStore, makeSession, removeSession, saveStore,
  upsertSession, withCurrentSession,
} from "./agent_store"
import { runAgent, toolKindLabel } from "./agent_core"
import { ConfigPage } from "./config_page"
import { MountPage, mountChips } from "./mount_page"
import { DRAWER_WIDTH, Sidebar } from "./sidebar"
import { Avatar, AvatarSpec } from "./avatar"
import { handleCallback } from "./tool_callback"

/** 过程面板里嵌套小卡片的底色（iOS 单色风格，不用蓝色强调）。 */
const STEP_FILL = "rgba(120,120,128,0.12)"
const CARD_FILL = "rgba(120,120,128,0.08)"

/** token 数太长不好看，过千折成 1.2k。 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k"
}

/** 一次工具调用：一行摘要，点开看参数与返回结果。 */
export function StepRow({ step, defaultOpen = false }: { step: ToolStep; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <VStack
      spacing={6}
      alignment="leading"
      padding={{ horizontal: 10, vertical: 8 }}
      background={STEP_FILL}
      clipShape={{ type: "rect", cornerRadius: 12 }}
      frame={{ maxWidth: "infinity" }}
      onTapGesture={() => setOpen((v) => !v)}
    >
      <HStack spacing={6}>
        <Text font="caption2" fontWeight="semibold" foregroundStyle="secondaryLabel">
          {toolKindLabel(step.kind)}
        </Text>
        {step.target && step.target !== toolKindLabel(step.kind) ? (
          <Text font="caption" foregroundStyle="label" lineLimit={1}>{step.target}</Text>
        ) : null}
        {step.cid && step.callback ? (
          <Text font="caption2" fontWeight="semibold" foregroundStyle="systemGreen">已回传</Text>
        ) : null}
        {step.cid && !step.callback ? (
          <Text font="caption2" foregroundStyle="tertiaryLabel">等回传</Text>
        ) : null}
        <Spacer />
        <Image
          systemName={step.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"}
          font="caption2"
          foregroundStyle={step.ok ? "systemGreen" : "systemOrange"}
        />
        <Text font="caption2" foregroundStyle="tertiaryLabel">{step.ms}ms</Text>
      </HStack>
      {open && step.args ? (
        <VStack spacing={3} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font="caption2" foregroundStyle="tertiaryLabel">调用参数</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">{step.args}</Text>
        </VStack>
      ) : null}
      {open && step.result ? (
        <VStack spacing={3} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font="caption2" foregroundStyle="tertiaryLabel">返回结果</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">{step.result}</Text>
        </VStack>
      ) : null}
    </VStack>
  )
}

/**
 * 「AI 过程」卡片：思考过程 + 每次工具调用的参数与结果。
 * 整卡可收起；实时那一轮默认展开，历史消息默认收起。
 */
export function ProcessCard({
  steps, reasoning, live, defaultOpen, stepDefaultOpen = false, usage,
}: {
  steps: ToolStep[]
  reasoning: string
  live: boolean
  defaultOpen: boolean
  stepDefaultOpen?: boolean
  /** 这一轮的 token 用量（流式最后一帧带回来的），没有就不显示。 */
  usage?: TokenUsage
}) {
  const [open, setOpen] = useState(defaultOpen)
  const count = steps.length
  const title = live
    ? count > 0
      ? `正在处理 · 已调用 ${count} 个工具`
      : "正在思考"
    : count > 0
      ? `AI 过程 · 思考 + ${count} 个工具`
      : "AI 过程 · 思考"

  return (
    <VStack
      spacing={8}
      alignment="leading"
      padding={{ horizontal: 12, vertical: 10 }}
      background={CARD_FILL}
      clipShape={{ type: "rect", cornerRadius: 14 }}
      frame={{ maxWidth: "infinity" }}
      onTapGesture={() => setOpen((v) => !v)}
    >
      <HStack spacing={6}>
        <Image systemName="sparkles" font="caption2" foregroundStyle="secondaryLabel" />
        <Text font="footnote" fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
          {title}
        </Text>
        <Spacer />
        <Image
          systemName={open ? "chevron.up" : "chevron.down"}
          font="caption2"
          foregroundStyle="tertiaryLabel"
        />
      </HStack>
      {open ? (
        <VStack spacing={8} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {reasoning ? (
            <VStack spacing={3} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font="caption2" foregroundStyle="tertiaryLabel">思考过程</Text>
              <Text font="caption" foregroundStyle="secondaryLabel">{reasoning}</Text>
            </VStack>
          ) : null}
          {steps.map((s, i) => <StepRow key={"s" + i} step={s} defaultOpen={stepDefaultOpen} />)}
        </VStack>
      ) : null}
      {usage ? (
        <HStack spacing={0}>
          <Spacer />
          <Text font="caption2" foregroundStyle="tertiaryLabel">
            {`↑ ${fmtTokens(usage.inputTokens)} · ↓ ${fmtTokens(usage.outputTokens)} tokens`}
          </Text>
        </HStack>
      ) : null}
    </VStack>
  )
}

/**
 * 正文渲染：走 Markdown（`Text` 的 `attributedString` 就是 Markdown 模式）。
 * 只用在 AI 的答复上；用户气泡保持纯文本（彩色底上换色反而花）。
 * `cursor` 是流式输出时缀在末尾的光标。
 */
export function MarkdownText({ text, cursor = false, font }: {
  text: string
  cursor?: boolean
  font?: any
}) {
  const body = cursor ? (text ?? "") + "\u258c" : (text ?? "")
  if (!body) return null
  return <Text attributedString={body} font={font} foregroundStyle="label" />
}

/** 用户的输入：纯文本气泡。 */
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

/** 助手的消息：过程卡片在气泡上方，共用左侧一个头像。 */
export function AssistantMessage({
  message, avatar, showSteps, defaultOpen = false, stepDefaultOpen = false,
}: {
  message: ChatMessage
  avatar: AvatarSpec
  showSteps: boolean
  defaultOpen?: boolean
  stepDefaultOpen?: boolean
}) {
  const steps = message.steps ?? []
  const reasoning = message.reasoning ?? ""
  const hasProcess = steps.length > 0 || reasoning.length > 0
  return (
    <HStack
      spacing={8}
      alignment="bottom"
      padding={{ horizontal: 12, vertical: 4 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Avatar spec={avatar} />
      <VStack spacing={6} frame={{ maxWidth: 280 }} alignment="leading">
        {showSteps && hasProcess ? (
          <ProcessCard
            steps={steps}
            reasoning={reasoning}
            live={false}
            defaultOpen={defaultOpen}
            stepDefaultOpen={stepDefaultOpen}
            usage={message.usage}
          />
        ) : null}
        <HStack spacing={0}>
          <VStack
            padding={{ horizontal: 14, vertical: 10 }}
            background="secondarySystemFill"
            clipShape={{ type: "rect", cornerRadius: 18 }}
          >
            <MarkdownText text={message.content} />
          </VStack>
          <Spacer />
        </HStack>
      </VStack>
      <Spacer />
    </HStack>
  )
}

/** 正在跑的这一轮：过程实时长出来，正文边生成边显示（打字机）。 */
export function LiveThinking({
  avatar, reasoning, steps, showSteps, text,
}: { avatar: AvatarSpec; reasoning: string; steps: ToolStep[]; showSteps: boolean; text: string }) {
  const hasProcess = steps.length > 0 || reasoning.length > 0
  return (
    <HStack
      spacing={8}
      alignment="top"
      padding={{ horizontal: 12, vertical: 4 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Avatar spec={avatar} />
      <VStack spacing={6} frame={{ maxWidth: 280 }} alignment="leading">
        {showSteps && hasProcess ? (
          <ProcessCard steps={steps} reasoning={reasoning} live={true} defaultOpen={true} />
        ) : null}
        <HStack spacing={0}>
          <VStack
            padding={{ horizontal: 14, vertical: 10 }}
            background="secondarySystemFill"
            clipShape={{ type: "rect", cornerRadius: 18 }}
          >
            {text ? (
              <MarkdownText text={text} cursor />
            ) : (
              <HStack spacing={8}>
                <ProgressView controlSize="small" />
                <Text font="footnote" foregroundStyle="secondaryLabel">思考中…</Text>
              </HStack>
            )}
          </VStack>
          <Spacer />
        </HStack>
      </VStack>
      <Spacer />
    </HStack>
  )
}

/** 空会话时的「角色登场」界面。 */
function EmptyState({ name, avatar }: { name: string; avatar: AvatarSpec }) {
  return (
    <VStack
      spacing={12}
      padding={{ horizontal: 28, vertical: 56 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Avatar spec={avatar} size={76} />
      <Text font="title3" fontWeight="bold">{name}</Text>
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
  const [showMounts, setShowMounts] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 正在跑的这一轮的过程（实时画在聊天流里，结束后随消息落库）。
  const [liveReasoning, setLiveReasoning] = useState("")
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([])
  const [liveText, setLiveText] = useState("")
  /** 快捷指令回传后要自动接着跑的那一轮（先把结果落盘、切到那个会话，等不忙了再发）。
   *  hidden：这次输入不在聊天界面显示 —— 工具回传只需要喂给模型。 */
  const [autoJob, setAutoJob] = useState<{ text: string; hidden?: boolean } | null>(null)

  /**
   * 快捷指令回传有两条入口，都要接：
   *  ① 冷启动 —— App 被杀掉后由回调 URL 拉起，入口会重跑，result 在 queryParameters 里；
   *  ② 被唤起 —— 实例还活着时 `scripting://run` 只触发 onResume，入口不会重跑。
   * 这里只负责「解析 + 落盘 + 排队」；真正发出去交给下面那个 effect，
   * 因为它的闭包里装着刚刷新过的 store / cfg（onResume 的闭包是旧的）。
   */
  useEffect(() => {
    const consume = (params: any) => {
      let out: ReturnType<typeof handleCallback> = null
      try {
        out = handleCallback(params)
      } catch {
        out = null
      }
      if (!out) return
      setCfg(loadConfig())
      setStore(loadStore())
      setAutoJob({ text: out.text, hidden: true })
    }
    consume(Script.queryParameters)
    const off = Script.onResume((d) => consume(d?.queryParameters ?? null))
    return () => {
      if (typeof off === "function") off()
    }
  }, [])

  // 回传续跑：必须等这一轮不忙（send 自己在忙时是直接返回的，会白白吞掉）。
  useEffect(() => {
    if (!autoJob || busy) return
    const job = autoJob
    setAutoJob(null)
    void send(job.text, { hidden: job.hidden })
  }, [autoJob, busy])

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

    setBusy(true)
    setInput("")
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
          <ScrollView axes="horizontal">
            <HStack spacing={6} padding={{ horizontal: 12 }}>
              <Button action={() => setShowMounts(true)}>
                <Text font="caption2" foregroundStyle="tertiaryLabel">本轮挂载</Text>
              </Button>
              {mountChips(current.mounts).map((c) => (
                <Button key={c.key} action={() => setShowMounts(true)}>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{c.label}</Text>
                </Button>
              ))}
            </HStack>
          </ScrollView>
        ) : null}

        <HStack spacing={8} padding={{ horizontal: 12, top: 8, bottom: 10 }}>
          <Button action={() => setShowMounts(true)} disabled={busy}>
            <Image
              systemName="plus.circle.fill"
              font="title2"
              foregroundStyle={current?.mounts ? "systemBlue" : "tertiaryLabel"}
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
              onChanged={setInput}
              submitLabel="send"
              onSubmit={() => send(input)}
            />
          </HStack>
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
