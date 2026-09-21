import { Intent, Script } from "scripting"
import { loadConfig, loadStore, saveStore, upsertSession, withCurrentSession, capMessages, deriveTitle, tryApplyConfigJson } from "./agent_store"
import { runAgent, dictate } from "./agent_core"
import { startThinking, updateThinking, finishActivity, rememberReply } from "./live_activity"

function excerpt(text: string): string {
  const t = (text ?? "").trim()
  return t.length > 60 ? t.slice(0, 60) + "…" : t
}

function getInputText(): string {
  const sp = Intent.shortcutParameter
  if (sp != null) {
    if (sp.type === "text") {
      const t = sp.value.trim()
      if (t) return t
    }
    if (sp.type === "json") {
      try { return JSON.stringify(sp.value) } catch { return "" }
    }
    if (sp.type === "fileURL") {
      return sp.value
    }
  }
  const texts = Intent.textsParameter
  if (texts && texts.length > 0 && texts[0]) {
    return texts[0]
  }
  return ""
}

async function run() {
  try {
    const inputText = getInputText()

    // 兼容路径：输入是一段含配置键的 JSON 时，当作「改配置」而不是聊天。
    if (inputText && tryApplyConfigJson(inputText)) {
      Script.exit(Intent.text("配置已更新"))
      return
    }

    const cfg = loadConfig()
    if (!cfg.apiKey) {
      Script.exit(Intent.text("请先在「智能体」里点右上角齿轮填写 API Key"))
      return
    }

    let userText = inputText
    if (!userText) {
      userText = await dictate()
    }
    if (!userText) {
      Script.exit(Intent.text("没有听到内容"))
      return
    }

    // 尽力而为：后台运行时 Live Activity 可能无法启动，失败不影响回答。
    await startThinking(excerpt(userText) || "正在思考…")

    const history = withCurrentSession(loadStore())
    const session = history.session
    const { reply, newHistory } = await runAgent(userText, cfg, session.messages, (e) => {
      void updateThinking(`正在调用「${e.target}」…`)
    })

    const capped = capMessages(newHistory, cfg.maxHistory)
    saveStore(
      upsertSession(history.store, {
        ...session,
        messages: capped,
        updatedAt: Date.now(),
        title: session.messages.length === 0 ? deriveTitle(capped) : session.title,
      }),
    )

    await finishActivity("done", excerpt(reply) || "完成")
    rememberReply(reply)

    if (cfg.speakReply) {
      await Speech.speak(reply)
    }

    Script.exit(Intent.text(reply))
  } catch (e: any) {
    const msg = "出错：" + (e?.message ?? String(e))
    await finishActivity("error", excerpt(msg) || "出错")
    Script.exit(Intent.text(msg))
  }
}

run()
