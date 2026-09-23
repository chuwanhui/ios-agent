import { Script, useEffect, useState } from "scripting"
import { handleCallback } from "./tool_callback"
import { loadConfig, loadStore } from "./agent_store"

/**
 * 快捷指令回传有一条冷启动入口（queryParameters）和一条被唤起入口（onResume），
 * 两条都要接。这里统一成「解析 → 刷新 config/store → 排队续跑」的 hook：
 *   - 解析出文本（handleCallback）就触发 onConsumed（父级刷新 cfg/store）；
 *   - 续跑不能忙时发（send 忙时直接返回会吞掉），等不忙了才 onFire。
 * 真正发出去的那一轮是 toolReply 标记的（聊天界面显示为「工具回复」卡片）。
 */
export function useCallbackAutoJob({
  onConsumed, onFire, busy,
}: {
  /** 回传落盘后刷新 config/store。 */
  onConsumed: () => void
  /** 不忙时真正发出去的那一轮（父级用 send，hidden 续跑）。 */
  onFire: (text: string) => void
  busy: boolean
}) {
  const [autoJob, setAutoJob] = useState<{ text: string } | null>(null)

  useEffect(() => {
    const consume = (params: any) => {
      let out: ReturnType<typeof handleCallback> = null
      try {
        out = handleCallback(params)
      } catch {
        out = null
      }
      if (!out) return
      onConsumed()
      setAutoJob({ text: out.text })
    }
    consume(Script.queryParameters)
    const off = Script.onResume((d) => consume(d?.queryParameters ?? null))
    return () => {
      if (typeof off === "function") off()
    }
  }, [])

  useEffect(() => {
    if (!autoJob || busy) return
    const job = autoJob
    setAutoJob(null)
    onFire(job.text)
  }, [autoJob, busy])
}
