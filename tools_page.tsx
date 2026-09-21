import { Button, Form, Section, Text, TextField, VStack, useState } from "scripting"
import { AgentTool } from "./agent_store"

/**
 * 设置页里「本地快捷指令工具」的草稿行（字段全是字符串，保存时才转成 AgentTool）。
 * 单独抽出来是为了让设置页和子页共用同一套转换逻辑。
 */
export interface ToolRow {
  /** 表单内的行标识（不是 AgentTool 的字段，只用来做 key）。 */
  id: string
  name: string
  description: string
  shortcutName: string
  /** 参数声明，每行一个 `字段名=说明`。 */
  paramsHint: string
  /** 高级：配置 JSON 里手写的完整 JSON schema（优先级高于参数声明）。 */
  parameters?: Record<string, any>
}

function newId(): string {
  return "t" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36)
}

export function newToolRow(): ToolRow {
  return { id: newId(), name: "", description: "", shortcutName: "", paramsHint: "" }
}

export function toToolRow(t: AgentTool): ToolRow {
  return {
    id: newId(),
    name: t.name ?? "",
    description: t.description ?? "",
    shortcutName: t.shortcutName ?? "",
    paramsHint: t.paramsHint ?? "",
    parameters: t.parameters,
  }
}

/**
 * 草稿 → AgentTool[]。
 * 整行空白跳过；缺「名称」或「快捷指令名」直接返回 error（设置页拿它弹提示并中止保存）。
 */
export function toAgentTools(rows: ToolRow[]): { tools: AgentTool[]; error?: string } {
  const tools: AgentTool[] = []
  for (const r of rows) {
    const name = (r.name ?? "").trim()
    const shortcutName = (r.shortcutName ?? "").trim()
    const description = (r.description ?? "").trim()
    if (!name && !shortcutName && !description) continue
    if (!name || !shortcutName) {
      return { tools, error: "每个本地快捷指令工具都要填「名称」和「快捷指令名」" }
    }
    tools.push({
      name,
      description: description || name,
      shortcutName,
      paramsHint: (r.paramsHint ?? "").trim() || undefined,
      parameters: r.parameters,
    })
  }
  return { tools }
}

interface Props {
  /** 设置页里当前的草稿行。 */
  rows: ToolRow[]
  /** 每次改动都推回设置页（设置页的 state 才是保存时的唯一来源）。 */
  onChange: (rows: ToolRow[]) => void
}

/**
 * 「本地快捷指令工具」子页：一个真·快捷指令 = 一个工具。
 * 由设置页用 NavigationLink 推进来，所以这里**不用**再套 NavigationStack。
 */
export function ToolsPage({ rows, onChange }: Props) {
  const [draft, setDraft] = useState<ToolRow[]>(rows.map((r) => ({ ...r })))

  function push(next: ToolRow[]) {
    setDraft(next)
    onChange(next)
  }

  function update(i: number, p: Partial<ToolRow>) {
    push(draft.map((r, idx) => (idx === i ? { ...r, ...p } : r)))
  }

  function add() {
    push([...draft, newToolRow()])
  }

  function remove(i: number) {
    push(draft.filter((_, idx) => idx !== i))
  }

  return (
    <VStack navigationTitle="本地快捷指令工具" navigationBarTitleDisplayMode="inline">
      <Form>
        {draft.map((t, i) => (
          <Section
            key={t.id}
            header={
              <Text>{`本地快捷指令工具 ${i + 1}${t.name.trim() ? " · " + t.name.trim() : ""}`}</Text>
            }
          >
            <TextField
              title="名称"
              value={t.name}
              prompt="如 open_dnd"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => update(i, { name: v })}
            />
            <TextField
              title="说明"
              value={t.description}
              prompt="给模型看的用途说明"
              onChanged={(v) => update(i, { description: v })}
            />
            <TextField
              title="快捷指令名"
              value={t.shortcutName}
              prompt="与「快捷指令」App 里完全一致"
              onChanged={(v) => update(i, { shortcutName: v })}
            />
            <TextField
              title="参数"
              value={t.paramsHint}
              prompt={"每行一个：字段名=说明\n例如 destination=目的地名称\nmode=出行方式 driving/walking"}
              axis="vertical"
              lineLimit={{ min: 1, max: 5 }}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => update(i, { paramsHint: v })}
            />
            <Button title="删除这个工具" role="destructive" action={() => remove(i)} />
          </Section>
        ))}

        <Section
          header={<Text>添加</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                一个真实快捷指令 = 一个「本地快捷指令工具」。需要参数就在「参数」里一行写一个「字段名=说明」，模型就会按这些字段名生成参数。
              </Text>
              <Text>
                调用时脚本把参数拼成 JSON 文本，作为快捷指令的输入传过去（无参数就不传）。所以快捷指令里要接住输入：「从输入获取词典」→「获取词典值」按字段名取值。
              </Text>
              <Text>
                快捷指令是单向触发：模型只能知道「已触发」，拿不到执行结果，也不会编造结果。需要它知道结果的话，让快捷指令自己弹个通知告诉你。
              </Text>
              <Text>改完回设置页点「保存」才会生效。</Text>
            </VStack>
          }
        >
          <Button title="添加快捷指令工具" systemImage="plus.circle.fill" action={add} />
          {draft.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有本地快捷指令工具</Text>
          ) : null}
        </Section>
      </Form>
    </VStack>
  )
}

export default ToolsPage
