import {
  Button, HStack, Image, ProgressView, Text, VStack, useEffect, useState,
} from "scripting"
import {
  AgentConfig, SessionStore, capMessages, deriveTitle, loadConfig, loadStore, makeSession,
  saveStore, upsertSession,
} from "./agent_store"
import { dictate, runAgent } from "./agent_core"
import { finishActivity, startThinking, updateThinking } from "./live_activity"

/**
 * 「语音通话」模式 —— 参考 ChatGPT 的语音模式：
 *   聆听 → 思考（可调用工具）→ 朗读回复 → 再聆听，循环到用户挂断。
 * 文本聊天模式则完全不朗读。
 */

type Phase = "listening" | "thinking" | "speaking" | "idle" | "error"

/** 跨渲染共享的运行标志（闭包里的 loop 与按钮回调都要读写）。 */
const ctl = { alive: false, hangUp: false }

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function excerpt(text: string): string {
  const t = (text ?? "").trim()
  return t.length > 60 ? t.slice(0, 60) + "…" : t
}

function statusText(phase: Phase, name: string): string {
  if (phase === "listening") return "正在聆听…"
  if (phase === "thinking") return "思考中…"
  if (phase === "speaking") return `${name} 正在回答…`
  if (phase === "error") return "出了点问题"
  return "没听清，再说一次"
}

interface Props {
  store: SessionStore
  cfg: AgentConfig
  onStore: (next: SessionStore) => void
  onClose: () => void
}

export function VoicePage({ cfg, onStore, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("listening")
  const [lastUser, setLastUser] = useState("")
  const [lastReply, setLastReply] = useState("")
  const [note, setNote] = useState("")

  const name = cfg.agentName || "智能体"
  const emoji = cfg.agentEmoji || "✨"

  /** 一轮：听 → 想 → 说。 */
  async function turn(): Promise<void> {
    setPhase("listening")
    setNote("")

    let heard = ""
    try {
      heard = await dictate()
    } catch (e: any) {
      if (!ctl.alive) return
      setPhase("error")
      setNote("听写失败：" + (e?.message ?? String(e)))
      return
    }
    if (!ctl.alive) return

    const text = (heard ?? "").trim()
    if (!text) {
      setPhase("idle")
      await sleep(400)
      return
    }

    setLastUser(text)
    setPhase("thinking")
    await startThinking("正在思考…")

    // 每次都从磁盘取最新配置与会话，保证和文本模式共享同一份历史。
    const cfgNow = loadConfig()
    const st = loadStore()
    const session = st.sessions.find((s) => s.id === st.currentId) ?? null
    const history = session?.messages ?? []

    let reply = ""
    let failed = false
    try {
      const res = await runAgent(text, cfgNow, history, (e) => {
        void updateThinking(`正在调用「${e.target}」…`)
      })
      reply = res.reply
      const capped = capMessages(res.newHistory, cfgNow.maxHistory)
      const base = session ?? makeSession()
      const next = upsertSession(st, {
        ...base,
        messages: capped,
        updatedAt: Date.now(),
        title: history.length === 0 ? deriveTitle(capped) : base.title,
      })
      saveStore(next)
      onStore(next)
    } catch (e: any) {
      failed = true
      reply = "出错：" + (e?.message ?? String(e))
    }

    if (!ctl.alive || ctl.hangUp) {
      await finishActivity("done", "已结束")
      return
    }

    setLastReply(reply)
    setPhase("speaking")
    await finishActivity(failed ? "error" : "done", excerpt(reply) || "完成")
    if (!ctl.alive || ctl.hangUp) return

    try {
      // isMarkdown 让 `**加粗**`、列表符号等不会被念出来
      await Speech.speak(reply, { isMarkdown: true })
    } catch {
      // 朗读失败就当这一轮说完了
    }
    if (!ctl.alive || ctl.hangUp) return
    await sleep(250)
  }

  async function loop(): Promise<void> {
    while (ctl.alive && !ctl.hangUp) {
      await turn()
    }
  }

  useEffect(() => {
    ctl.alive = true
    ctl.hangUp = false
    loop()
    return () => {
      ctl.alive = false
      Speech.stop().catch(() => {})
      SpeechRecognition.stop().catch(() => {})
    }
  }, [])

  /** 回答途中轻点头像 → 打断朗读，立刻回到聆听。 */
  function interrupt() {
    if (phase !== "speaking") return
    Speech.stop().catch(() => {})
  }

  function hangUp() {
    ctl.alive = false
    ctl.hangUp = true
    Speech.stop().catch(() => {})
    SpeechRecognition.stop().catch(() => {})
    finishActivity("done", "已结束")
    onClose()
  }

  const pulsing = phase === "listening" || phase === "speaking"

  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="systemBackground"
    >
      {/* 顶部 */}
      <HStack padding={{ horizontal: 20, top: 14 }} frame={{ maxWidth: "infinity" }}>
        <Text font="footnote" foregroundStyle="secondaryLabel">
          语音通话
        </Text>
        <Button action={hangUp} frame={{ maxWidth: "infinity", alignment: "trailing" }}>
          <Image systemName="xmark.circle.fill" font="title3" foregroundStyle="tertiaryLabel" />
        </Button>
      </HStack>

      {/* 中间：头像 + 状态 + 字幕 */}
      <VStack spacing={16} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack
          frame={{ width: 132, height: 132 }}
          background={pulsing ? "secondarySystemFill" : "tertiarySystemFill"}
          clipShape="circle"
          onTapGesture={interrupt}
        >
          <Text font="largeTitle" scaleEffect={2}>
            {emoji}
          </Text>
        </VStack>

        <Text font="headline">{name}</Text>

        <HStack spacing={8}>
          {phase === "thinking" ? <ProgressView controlSize="small" /> : null}
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {note || statusText(phase, name)}
          </Text>
        </HStack>

        <VStack spacing={10} padding={{ horizontal: 26 }} frame={{ maxWidth: "infinity" }}>
          {lastUser ? (
            <Text
              font="callout"
              foregroundStyle="secondaryLabel"
              lineLimit={{ max: 3 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {lastUser}
            </Text>
          ) : null}
          {lastReply ? (
            <Text
              font="body"
              lineLimit={{ max: 10 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {lastReply}
            </Text>
          ) : null}
        </VStack>
      </VStack>

      {/* 底部：挂断 */}
      <VStack spacing={10} padding={{ top: 16, bottom: 48 }}>
        <Button action={hangUp}>
          <VStack frame={{ width: 68, height: 68 }} background="systemRed" clipShape="circle">
            <Image systemName="phone.down.fill" font="title2" foregroundStyle="white" />
          </VStack>
        </Button>
        <Text font="caption2" foregroundStyle="tertiaryLabel">
          说完自动发送 · 回答时点一下头像可打断
        </Text>
      </VStack>
    </VStack>
  )
}

export default VoicePage
