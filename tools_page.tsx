import { Button, Form, Section, Script, Text, TextField, Toggle, VStack, useState } from "scripting"
import {
  AgentTool,
  ToolParamSpec,
  TOOL_JSON_EXAMPLE,
  parseShortcutsJson,
  shortcutProtocolText,
  shortcutsToJson,
} from "./agent_store"

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
  /** 粘贴 JSON 导入时给的完整参数声明（有它时优先，界面上就不让改简易写法了）。 */
  params?: ToolParamSpec[]
  /** 这个快捷指令末尾配了回调 URL、会把结果传回来。 */
  returns?: boolean
  /** 高级：配置 JSON 里手写的完整 JSON schema（优先级最高）。 */
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
    params: t.params,
    returns: t.returns === true,
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
      params: r.params && r.params.length > 0 ? r.params : undefined,
      returns: r.returns === true ? true : undefined,
      parameters: r.parameters,
    })
  }
  return { tools }
}

/** 参数摘要，如 `destination、mode?、count:number`。 */
function paramsSummary(specs: ToolParamSpec[]): string {
  return specs
    .map(
      (s) =>
        s.name +
        (s.required === false ? "?" : "") +
        (s.type && s.type !== "string" ? ":" + s.type : ""),
    )
    .join("、")
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
  const [json, setJson] = useState("")
  const [note, setNote] = useState("")

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

  // —— 粘贴 JSON 导入 ——

  async function pasteFromClipboard() {
    try {
      const t = await Pasteboard.getString()
      if (!t || !t.trim()) {
        setNote("剪贴板里没有文本。")
        return
      }
      setJson(t)
      setNote("已从剪贴板读入，点「导入」解析。")
    } catch (e: any) {
      setNote("读剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  function importJson() {
    let res
    try {
      res = parseShortcutsJson(json)
    } catch (e: any) {
      setNote(String(e?.message ?? e))
      return
    }
    const exists = new Set(draft.map((r) => r.shortcutName.trim()))
    const fresh = res.tools.filter((t) => !exists.has(t.shortcutName.trim()))
    const dup = res.tools.length - fresh.length
    if (fresh.length > 0) push([...draft, ...fresh.map(toToolRow)])

    const lines: string[] = []
    lines.push(fresh.length > 0 ? `✅ 导入 ${fresh.length} 个工具` : "没有可导入的工具")
    if (dup > 0) lines.push(`跳过 ${dup} 个（同一个快捷指令已经在了）`)
    if (res.skipped.length > 0) lines.push("提示：\n" + res.skipped.map((s) => "· " + s).join("\n"))
    if (fresh.length > 0) lines.push("回设置页点「保存」才会生效。")
    setNote(lines.join("\n\n"))
  }

  async function copyJson() {
    try {
      const tools = toAgentTools(draft)
      if (tools.error) {
        setNote(tools.error)
        return
      }
      await Pasteboard.setString(shortcutsToJson(tools.tools))
      setNote("已复制当前工具的 JSON，可以存档或贴给别人。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  /** 复制「快捷指令那边该怎么配」的说明（含回调 URL 模板）。 */
  async function copyProtocol() {
    try {
      let name = "智能体"
      try {
        name = (Script as any)?.name || name
      } catch {}
      await Pasteboard.setString(shortcutProtocolText(name))
      setNote("已复制协议说明：贴进备忘录照着改快捷指令即可。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  function fillExample() {
    setJson(TOOL_JSON_EXAMPLE)
    setNote("已填入示例，改完点「导入」。")
  }

  return (
    <VStack navigationTitle="本地快捷指令工具" navigationBarTitleDisplayMode="inline">
      <Form>
        <Section
          header={<Text>从 JSON 导入</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                一个真·快捷指令 = 一条配置。字段：name（函数名，英文）、shortcut（快捷指令名，要和 App 里完全一致）、description（给模型看的说明）、params（参数）、returns（会不会回传结果；开了回传，结果到达后会当一条新消息接着回复）。
              </Text>
              <Text>
                参数可以写得很细：{"\n"}
                {"· \"destination\": \"目的地名称\"（只要说明）"}
                {"\n"}
                {"· \"mode\": {\"enum\":[\"driving\",\"walking\"], \"required\":false, \"default\":\"driving\"}"}
                {"\n"}
                {"· type 支持 string / number / integer / boolean；默认全部必填"}
              </Text>
              <Text>导入是「追加」模式：同一个快捷指令已经在了就跳过，不会覆盖原来的。也可以把当前配置复制出去存档。</Text>
            </VStack>
          }
        >
          <TextField
            title="配置 JSON"
            value={json}
            prompt={'{"shortcuts":[{"name":"navigate_home","shortcut":"导航回家"}]}'}
            axis="vertical"
            lineLimit={{ min: 3, max: 10 }}
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setJson}
          />
          <Button title="从剪贴板粘贴" systemImage="doc.on.clipboard" action={pasteFromClipboard} />
          <Button title="导入" systemImage="square.and.arrow.down" disabled={!json.trim()} action={importJson} />
          <Button title="填入示例" systemImage="sparkles" action={fillExample} />
          <Button title="导出当前工具（复制）" systemImage="doc.on.doc" action={copyJson} />
          <Button title="复制快捷指令配置说明" systemImage="text.badge.checkmark" action={copyProtocol} />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>

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
            {t.params && t.params.length > 0 ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`参数（来自导入的 JSON）：${paramsSummary(t.params)}`}
              </Text>
            ) : (
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
            )}
            {t.params && t.params.length > 0 ? (
              <Button
                title="改成简易写法（清掉这些参数）"
                action={() => update(i, { params: undefined })}
              />
            ) : null}
            <Toggle
              title="快捷指令会回传结果"
              value={t.returns === true}
              onChanged={(v) => update(i, { returns: v })}
            />
            <Button title="删除这个工具" role="destructive" action={() => remove(i)} />
          </Section>
        ))}

        <Section
          header={<Text>添加</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                手动加一个也不麻烦：需要参数就在「参数」里一行写一个「字段名=说明」；要类型 / 可选 / 枚举这些就用上面的 JSON 导入。
              </Text>
              <Text>
                调用时脚本把参数拼成 JSON 文本，作为快捷指令的输入传过去（无参数就不传）。所以快捷指令里要接住输入：「接收输入」→「从输入获取词典」→「获取词典值」按字段名取值。
              </Text>
              <Text>
                默认是单向触发：模型只能知道「已触发」，拿不到执行结果，也不会编造结果。想让模型看到结果，就在快捷指令末尾加「URL 编码」+「文本」拼
                scripting://run/{Script?.name ?? "智能体"}?result=… +「打开 URL」，并把上面的「回传结果」打开（点上方「复制快捷指令配置说明」可以拿到完整步骤）。
              </Text>
              <Text>
                回传到达时（10 分钟内），智能体会把结果写回那张过程卡片（标上「已回传」）并接着回复你；哪怕 App 之前被关掉，回调也会把它拉回来接上。
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
