import { AppIntentManager, AppIntentProtocol } from "scripting"

/**
 * 灵动岛 / 锁屏卡片上的按钮动作。
 *
 * 参数就是一个动作名，目前两个：
 *  - `"stop"`   停止朗读（回答太长念到一半不想听了）
 *  - `"replay"` 再念一遍最后一次回复
 *
 * 为什么单独放一个文件：Scripting 要求 AppIntent 注册在 `app_intents.tsx` 里，
 * 系统才会为按钮去找得到这个 intent；`live_activity.tsx` 里只是把工厂函数
 * 挂到 `<Button intent={...}>` 上。
 *
 * `LiveActivityIntent` 在 App 进程里执行，所以这里可以直接用 `Speech` / `FileManager`。
 */

/** 最后一次回复的落盘位置（和 live_activity.tsx 里的约定一致）。 */
function lastReplyFile(): string {
  try {
    return FileManager.appGroupDocumentsDirectory + "/agent/last_reply.txt"
  } catch {
    return ""
  }
}

export const AgentActivityAction = AppIntentManager.register<string>({
  name: "AgentActivityAction",
  protocol: AppIntentProtocol.LiveActivityIntent,
  perform: async (action: string) => {
    try {
      if (action === "stop") {
        await Speech.stop()
        return
      }

      if (action === "replay") {
        let text = ""
        try {
          const file = lastReplyFile()
          if (file && FileManager.existsSync(file)) {
            text = FileManager.readAsStringSync(file)
          }
        } catch {
          text = ""
        }
        if (text && text.trim()) {
          await Speech.speak(text.trim(), { isMarkdown: true })
        }
      }
    } catch {
      // 岛上按钮永远不该把 App 搞崩，失败就静默
    }
  },
})
