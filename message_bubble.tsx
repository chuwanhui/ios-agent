import {
  HStack, Image, ProgressView, Spacer, Text, VStack, useState,
} from "scripting"
import { ChatMessage, TokenUsage, ToolStep } from "./agent_store"
import { toolKindLabel } from "./agent_core"
import { Avatar, AvatarSpec } from "./avatar"

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

/** 「AI 过程」卡片：思考过程 + 每次工具调用的参数与结果。整卡可收起。 */
export function ProcessCard({
  steps, reasoning, live, defaultOpen, stepDefaultOpen = false, usage,
}: {
  steps: ToolStep[]
  reasoning: string
  live: boolean
  defaultOpen: boolean
  stepDefaultOpen?: boolean
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

/** 正文渲染：走 Markdown。只用在 AI 答复；用户气泡保持纯文本。cursor 是流式光标。 */
export function MarkdownText({ text, cursor = false, font }: {
  text: string
  cursor?: boolean
  font?: any
}) {
  const body = cursor ? (text ?? "") + "\u258c" : (text ?? "")
  if (!body) return null
  return <Text attributedString={body} font={font} foregroundStyle="label" />
}

/** 取文件名（文件卡片标题用）。 */
function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/** 收集这一轮产出 / 改动的文件（去重，保持出现顺序）。 */
export function collectFiles(steps: ToolStep[]): string[] {
  const out: string[] = []
  for (const s of steps ?? []) {
    for (const f of s.files ?? []) {
      if (f && out.indexOf(f) < 0) out.push(f)
    }
  }
  return out
}

/** 弹出系统「存储到『文件』」面板；不可用时退回到旧菜单。 */
async function openFileMenu(path: string) {
  try {
    const data = FileManager.readAsDataSync(path)
    await DocumentPicker.exportFiles({ files: [{ data, name: baseName(path) }] })
  } catch (_) {
    try {
      await DocumentInteraction.optionsMenu(path)
    } catch (e: any) {
      Dialog.alert({ message: "打不开这个文件：" + (e?.message ?? String(e)) })
    }
  }
}

/** 助手产出的文件：点一下就能保存到「文件」App 或分享出去。 */
export function FileList({ files }: { files: string[] }) {
  if (!files || files.length === 0) return null
  return (
    <VStack spacing={6} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {files.map((path, i) => (
        <HStack
          key={"file" + i}
          spacing={10}
          padding={{ horizontal: 12, vertical: 9 }}
          background={CARD_FILL}
          clipShape={{ type: "rect", cornerRadius: 12 }}
          frame={{ maxWidth: "infinity" }}
          onTapGesture={() => openFileMenu(path)}
        >
          <Image systemName="doc.text" font="footnote" foregroundStyle="secondaryLabel" />
          <VStack spacing={2} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font="footnote" foregroundStyle="label" lineLimit={1}>{baseName(path)}</Text>
            <Text font="caption2" foregroundStyle="tertiaryLabel" lineLimit={1}>
              点一下：存储到「文件」/ 分享
            </Text>
          </VStack>
          <Image systemName="square.and.arrow.up" font="footnote" foregroundStyle="secondaryLabel" />
        </HStack>
      ))}
    </VStack>
  )
}

/** 用户的输入：纯文本气泡。 */
export function Bubble({ message, avatar }: { message: ChatMessage; avatar: AvatarSpec }) {
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

/** 工具回传卡片：快捷指令异步返回的结果，用特殊样式标注「工具回复」。 */
export function ToolReplyCard({ message }: { message: ChatMessage }) {
  return (
    <HStack
      spacing={8}
      alignment="bottom"
      padding={{ horizontal: 12, vertical: 4 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Spacer />
      <VStack
        padding={{ horizontal: 14, vertical: 10 }}
        background={CARD_FILL}
        clipShape={{ type: "rect", cornerRadius: 14 }}
        frame={{ maxWidth: 280 }}
        spacing={4}
      >
        <HStack spacing={5}>
          <Image systemName="arrowshape.turn.up.left.fill" font="caption2" foregroundStyle="systemGreen" />
          <Text font="caption2" fontWeight="semibold" foregroundStyle="systemGreen">工具回复</Text>
        </HStack>
        <Text font="subheadline" foregroundStyle="label">{message.content}</Text>
      </VStack>
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
  const files = collectFiles(steps)
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
        <FileList files={files} />
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
  const files = collectFiles(steps)
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
        <FileList files={files} />
      </VStack>
      <Spacer />
    </HStack>
  )
}

/** 空会话时的「角色登场」界面。 */
export function EmptyState({ name, avatar }: { name: string; avatar: AvatarSpec }) {
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
