import { Intent, Script } from "scripting"
import { loadConfig, loadStore, saveStore, upsertSession, withCurrentSession, capMessages, deriveTitle, tryApplyConfigJson } from "./agent_store"
import { runAgent } from "./agent_core"

/**
 * 快捷指令入口：把传入的文本当一轮对话发给模型，结果作为快捷指令的返回值。
 * 输入为空就直接退出（不再走语音听写）。
 */
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

    if (!inputText) {
      Script.exit(Intent.text("没有收到输入内容：给这个快捷指令传一段文本再试"))
      return
    }

    const history = withCurrentSession(loadStore())
    const session = history.session
    const { reply, newHistory } = await runAgent(inputText, cfg, session.messages)

    const capped = capMessages(newHistory, cfg.maxHistory)
    saveStore(
      upsertSession(history.store, {
        ...session,
        messages: capped,
        updatedAt: Date.now(),
        title: session.messages.length === 0 ? deriveTitle(capped) : session.title,
      }),
    )

    Script.exit(Intent.text(reply))
  } catch (e: any) {
    Script.exit(Intent.text("出错：" + (e?.message ?? String(e))))
  }
}

run()
