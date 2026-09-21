import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIBuilder,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  ProgressView,
  Text,
  VStack,
} from "scripting"

/** 智能体当前处于哪个阶段。 */
export type AgentActivityPhase = "thinking" | "done" | "error"

/** Live Activity 的 contentState —— 必须是可 JSON 序列化的纯对象。 */
export type AgentActivityState = {
  phase: AgentActivityPhase
  text: string
}

function iconName(phase: AgentActivityPhase): string {
  if (phase === "done") return "checkmark.circle.fill"
  if (phase === "error") return "exclamationmark.triangle.fill"
  return "sparkles"
}

function tint(phase: AgentActivityPhase): "systemGreen" | "systemRed" | "systemPurple" {
  if (phase === "done") return "systemGreen"
  if (phase === "error") return "systemRed"
  return "systemPurple"
}

function label(phase: AgentActivityPhase): string {
  if (phase === "done") return "完成"
  if (phase === "error") return "出错"
  return "思考中"
}

const builder: LiveActivityUIBuilder<AgentActivityState> = (state) => (
  <LiveActivityUI
    content={
      <HStack>
        <Image systemName={iconName(state.phase)} foregroundStyle={tint(state.phase)} />
        <Text>{state.text}</Text>
      </HStack>
    }
    compactLeading={
      <Image systemName={iconName(state.phase)} foregroundStyle={tint(state.phase)} />
    }
    compactTrailing={<Text font="caption2">{label(state.phase)}</Text>}
    minimal={
      <Image systemName={iconName(state.phase)} foregroundStyle={tint(state.phase)} />
    }
  >
    <LiveActivityUIExpandedCenter>
      <VStack>
        <Text font="headline">{`智能体 · ${label(state.phase)}`}</Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">{state.text}</Text>
      </VStack>
    </LiveActivityUIExpandedCenter>
    <LiveActivityUIExpandedBottom>
      {state.phase === "thinking" ? <ProgressView /> : <Text> </Text>}
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
)

/** 注册灵动岛 / 锁屏 Live Activity。返回值是一个工厂函数。 */
export const AgentActivity = LiveActivity.register("AgentActivity", builder)

let current: LiveActivity<AgentActivityState> | null = null

/** 系统是否允许 Live Activity（用户可能在设置里关掉了）。 */
export async function activityEnabled(): Promise<boolean> {
  try {
    return await LiveActivity.areActivitiesEnabled()
  } catch {
    return false
  }
}

/** 开始展示「思考中」。任何失败都静默忽略，不影响主流程。 */
export async function startThinking(text: string): Promise<void> {
  try {
    const instance = AgentActivity()
    const ok = await instance.start({ phase: "thinking", text })
    current = ok ? instance : null
  } catch {
    current = null
  }
}

/** 更新「思考中」的文案（用于展示当前进度）。 */
export async function updateThinking(text: string): Promise<void> {
  if (!current) return
  try {
    await current.update({ phase: "thinking", text })
  } catch {
    // ignore
  }
}

/** 结束 Live Activity（完成后保留几秒再消失）。 */
export async function finishActivity(
  phase: AgentActivityPhase,
  text: string,
): Promise<void> {
  const instance = current
  current = null
  if (!instance) return
  try {
    await instance.end({ phase, text }, { dismissTimeInterval: 5 })
  } catch {
    // ignore
  }
}
