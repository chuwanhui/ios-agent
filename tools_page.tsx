import {
  Button,
  Form,
  HStack,
  Image,
  Script,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  useState,
} from "scripting"
import {
  AgentTool,
  ToolParamSpec,
  makeToolFunctionName,
  shortcutProtocolText,
  toolParamSpecs,
} from "./agent_store"
import { saveToolbar } from "./config_save"
import { pushRoute, registerRoute } from "./nav_route"

/**
 * 设置页里「本地快捷指令工具」的草稿行。
 *
 * 一个真·快捷指令 = 一个工具：名字必须和「快捷指令」App 里完全一致，可以手输，也可以在
 * 「快捷指令」里拷来名字后点「粘贴剪贴板里的名字」（平台没有枚举快捷指令的 API，只能人对上）。
 * 说明 / 参数 / 回传由人写：那是模型的用法说明。
 */
export interface ToolRow {
  /** 表单内的行标识（不是 AgentTool 的字段，只用来做 key）。 */
  id: string
  /** 模型看到的函数名；留空 = 自动从快捷指令名派生。 */
  name: string
  description: string
  /** 快捷指令名：必须和「快捷指令」App 里的名字一致。 */
  shortcutName: string
  /** 参数声明，界面上一行一个。 */
  params: ParamDraft[]
  /** 这个快捷指令末尾配了回调 URL、会把结果传回来。 */
  returns?: boolean
  /** 高级：手写的完整 JSON schema（优先级最高）。 */
  parameters?: Record<string, any>
}

/** 一个参数在界面上的草稿（保存时才转成 ToolParamSpec）。 */
export interface ParamDraft {
  id: string
  name: string
  description: string
  required: boolean
  /** 可选值，用「、」或逗号分隔；留空表示不限。 */
  enumText: string
  /** 带类型 / 默认值的参数：界面不编辑这两项，保存时原样带回。 */
  type?: ToolParamSpec["type"]
  defaultValue?: ToolParamSpec["default"]
}

function newId(): string {
  return "t" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36)
}

export function newParamDraft(): ParamDraft {
  return { id: newId(), name: "", description: "", required: true, enumText: "" }
}

function toParamDraft(s: ToolParamSpec): ParamDraft {
  return {
    id: newId(),
    name: s.name ?? "",
    description: s.description ?? "",
    required: s.required !== false,
    enumText: (s.enum ?? []).join("、"),
    type: s.type,
    defaultValue: s.default,
  }
}

export function newToolRow(): ToolRow {
  return { id: newId(), name: "", description: "", shortcutName: "", params: [] }
}

export function toToolRow(t: AgentTool): ToolRow {
  return {
    id: newId(),
    name: t.name ?? "",
    description: t.description ?? "",
    shortcutName: t.shortcutName ?? "",
    params: toolParamSpecs(t).map(toParamDraft),
    returns: t.returns === true,
    parameters: t.parameters,
  }
}

/** 「可选值」文本 → 数组：逗号 / 顿号 / 竖线 / 斜杠分隔都认。 */
export function splitEnumText(text?: string): string[] {
  return (text ?? "")
    .split(/[,，、|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 表单里的参数草稿 → ToolParamSpec[]（没填字段名的跳过，重名只留第一条）。 */
export function paramDraftsToSpecs(rows: ParamDraft[]): ToolParamSpec[] {
  const out: ToolParamSpec[] = []
  const seen = new Set<string>()
  for (const p of rows ?? []) {
    const name = (p.name ?? "").trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const spec: ToolParamSpec = { name, description: (p.description ?? "").trim() }
    if (p.type === "number" || p.type === "integer" || p.type === "boolean") spec.type = p.type
    if (p.required === false) spec.required = false
    const en = splitEnumText(p.enumText)
    if (en.length > 0) spec.enum = en
    if (p.defaultValue !== undefined && p.defaultValue !== null && String(p.defaultValue) !== "") {
      spec.default = p.defaultValue
    }
    out.push(spec)
  }
  return out
}

/**
 * 草稿 → AgentTool[]。
 * 整行空白跳过；缺「快捷指令名」直接返回 error（设置页拿它弹提示并中止保存）。
 * 「工具名」留空会自动从快捷指令名派生成英文函数名。
 */
export function toAgentTools(rows: ToolRow[]): { tools: AgentTool[]; error?: string } {
  const tools: AgentTool[] = []
  const used = new Set<string>()
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    const name = (r.name ?? "").trim()
    const shortcutName = (r.shortcutName ?? "").trim()
    const description = (r.description ?? "").trim()
    if (!name && !shortcutName && !description) continue
    if (!shortcutName) {
      return {
        tools,
        error: `第 ${i + 1} 条工具还没填「快捷指令名」，要和「快捷指令」App 里的名字完全一致。`,
      }
    }
    const params = paramDraftsToSpecs(r.params ?? [])
    tools.push({
      name: makeToolFunctionName(name, shortcutName, i, used).name,
      description: description || shortcutName,
      shortcutName,
      params: params.length > 0 ? params : undefined,
      returns: r.returns === true ? true : undefined,
      parameters: r.parameters,
    })
  }
  return { tools }
}

/** 本脚本的名字（回传 URL 里要用）。 */
function scriptName(): string {
  try {
    return (Script as any)?.name || "智能体"
  } catch {
    return "智能体"
  }
}

/** 回传 URL 前缀：快捷指令末尾把它和结果拼起来，编码后「打开 URL」。 */
function callbackURL(shortcut: string): string {
  return "scripting://run/" + scriptName() + "?tool=" + shortcut + "&result="
}

function runShortcutURL(name: string, input?: string): string {
  const base = "shortcuts://run-shortcut?name=" + encodeURIComponent(name)
  if (!input) return base
  return base + "&input=text&text=" + encodeURIComponent(input)
}

function sampleValue(s: ToolParamSpec): any {
  if (s.default !== undefined && s.default !== null && String(s.default) !== "") return s.default
  if (s.enum && s.enum.length > 0) return s.enum[0]
  if (s.type === "number" || s.type === "integer") return 1
  if (s.type === "boolean") return true
  return "测试"
}

/** 按参数声明拼一份「试运行」用的样例参数。 */
function sampleArgsJSON(specs: ToolParamSpec[]): string {
  if (specs.length === 0) return ""
  const out: Record<string, any> = {}
  for (const s of specs) out[s.name] = sampleValue(s)
  return JSON.stringify(out)
}

/** 「快捷指令」App 那边该怎么配（照抄就行）。 */
function stepsFor(shortcut: string, specs: ToolParamSpec[], returns: boolean): string {
  const hasArgs = specs.length > 0
  const lines: string[] = []
  let n = 1
  lines.push(`${n++}. 在「快捷指令」App 里建一条快捷指令，名字就叫「${shortcut}」（一个字符都不能差）`)
  if (hasArgs) {
    lines.push(`${n++}. 第一个动作放「接收输入」→ 类型选「文本」；智能体传来的是一整段 JSON 文本`)
    lines.push(
      `${n++}. 放「从输入获取词典」，再给每个参数加一条「获取词典值」，键名依次是 ${specs
        .map((s) => s.name)
        .join("、")}`,
    )
  } else {
    lines.push(`${n++}. 不用接输入：智能体只负责把这条快捷指令叫起来`)
  }
  lines.push(`${n++}. 中间放你真正要做的事（导航、开关、查询…）`)
  if (returns) {
    lines.push(
      `${n++}. 最后往回传：加「文本」，内容写 ${callbackURL(
        shortcut,
      )} 后面紧跟你要回传的内容 → 用「URL 编码」处理这段文本 → 再「打开 URL」`,
    )
  } else {
    lines.push(`${n++}. 想让智能体看到执行结果，就打开上面的「回传」开关，再按提示加回传动作`)
  }
  return lines.join("\n")
}

/** 拷给用户看的参数说明（怎么从输入里把字段取出来）。 */
function paramsHelp(shortcut: string, specs: ToolParamSpec[]): string {
  const sample: Record<string, any> = {}
  for (const s of specs) sample[s.name] = sampleValue(s)
  return (
    `「${shortcut}」会收到一段 JSON 文本，长这样：\n${JSON.stringify(sample)}\n\n` +
    "在快捷指令里这样取：\n" +
    "1.「接收输入」→ 类型选「文本」\n" +
    "2.「从输入获取词典」\n" +
    "3. 每个参数一条「获取词典值」，键名依次是：" +
    specs.map((s) => s.name).join("、")
  )
}

/** 表单里的「标签 + 输入框」一行（TextField 的 title 是占位符，只会消失，所以标签得自己画）。 */
export function FieldRow(props: { label: string; children: any }) {
  return (
    <HStack spacing={8}>
      <Text frame={{ width: 84, alignment: "leading" }} foregroundStyle="secondaryLabel">
        {props.label}
      </Text>
      {props.children}
    </HStack>
  )
}

/** 列表行的标题：优先用「快捷指令」App 里的真名。 */
function toolTitle(t: ToolRow): string {
  return (t.shortcutName ?? "").trim() || "（还没填快捷指令名）"
}

/** 列表行的一行摘要：模型看到的工具名 + 参数个数。 */
function toolSubtitle(t: ToolRow, i: number): string {
  const specs = paramDraftsToSpecs(t.params ?? [])
  const auto = makeToolFunctionName("", t.shortcutName, i, new Set<string>()).name
  const fn = (t.name ?? "").trim() || auto
  const bits = [fn, specs.length > 0 ? `${specs.length} 个参数` : "不带参数"]
  if (t.returns === true) bits.push("回传")
  if (t.parameters) bits.push("高级 schema")
  return bits.join(" · ")
}

/** 搜索匹配：快捷指令名 / 工具名 / 说明，大小写不敏感。 */
function matchesTool(t: ToolRow, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  return [t.shortcutName, t.name, t.description].some(
    (s) => ((s ?? "") as string).toLowerCase().indexOf(needle) >= 0,
  )
}

/** 列表行的「名字 + 摘要」，点进去才是详情。 */
function ToolListRow(props: { row: ToolRow; index: number; route: string }) {
  return (
    <HStack
      spacing={8}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      contentShape="rect"
      onTapGesture={() => pushRoute(props.route)}
    >
      <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text fontWeight="semibold" foregroundStyle="label">
          {toolTitle(props.row)}
        </Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">
          {toolSubtitle(props.row, props.index)}
        </Text>
      </VStack>
      <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

interface Props {
  /** 设置页里当前的草稿行。 */
  rows: ToolRow[]
  /** 每次改动都推回设置页（设置页的 state 才是保存时的唯一来源）。 */
  onChange: (rows: ToolRow[]) => void
}

/**
 * 「本地快捷指令工具」子页：上面搜索框，中间工具列表，点一条进详情页配。
 * 由设置页用 path 路由推进来（见 nav_route.ts），所以这里**不用**再套 NavigationStack。
 */
export function ToolsPage({ rows, onChange }: Props) {
  const [draft, setDraft] = useState<ToolRow[]>(rows.map((r) => ({ ...r })))
  /** 搜索关键词。 */
  const [query, setQuery] = useState("")

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

  // 详情页的路由：path 里出现 "tool:<id>" 就造这一条的详情页。写在渲染里，
  // 保证 update / remove 用的下标和当前草稿一致。
  registerRoute("tool:", (id) => {
    const i = draft.findIndex((r) => r.id === id)
    const t = draft[i]
    if (!t) return null
    return (
      <ToolDetail
        index={i}
        initial={t}
        onChange={(p) => update(i, p)}
        onDelete={() => remove(i)}
      />
    )
  })

  const indexed = draft.map((t, i) => ({ t, i }))
  const shown = indexed.filter((x) => matchesTool(x.t, query))

  return (
    <VStack
      navigationTitle="本地快捷指令工具"
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "搜工具名 / 快捷指令名",
      }}
    >
      <Form>
        <Section
          header={
            <Text>{draft.length > 0 ? `工具 ${draft.length} 条` : "本地快捷指令工具"}</Text>
          }
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                一个真·快捷指令 = 一个工具。点一条进去才是它的详细配置：名字必须和「快捷指令」App 里完全一致（可以手输，也可以先拷贝名字再点「粘贴剪贴板里的名字」）。
              </Text>
              <Text>改完点右上角「保存」就生效，并退回设置页（回设置页保存也一样）。</Text>
            </VStack>
          }
        >
          {draft.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有本地快捷指令工具，用下面的「＋ 添加快捷指令工具」加一条。</Text>
          ) : shown.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">{`没有名字里带「${query.trim()}」的工具。`}</Text>
          ) : (
            shown.map(({ t, i }) => (
              <ToolListRow key={t.id} row={t} index={i} route={"tool:" + t.id} />
            ))
          )}
        </Section>

        <Section
          header={<Text>添加</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                调用时脚本把参数拼成 JSON 文本，作为快捷指令的输入传过去（没有参数就不传）。所以快捷指令里要先接住输入：「接收输入」→「从输入获取词典」→「获取词典值」按字段名取值。
              </Text>
              <Text>
                默认是单向触发：模型只知道「已触发」，拿不到执行结果，也不会编造结果。想让模型看到结果，就进工具详情打开「回传」开关，再按「显示『快捷指令』那边怎么配」加回传动作（里面有可一键拷贝的 URL）。
              </Text>
              <Text>
                回传到达时（10 分钟内），结果会写回那张过程卡片（标「已回传」）并接着回复你——回传内容本身不会作为消息出现在聊天里；哪怕 App 之前被关掉，回调也会把它拉回来接上。
              </Text>
            </VStack>
          }
        >
          <Button title="＋ 添加快捷指令工具" systemImage="plus.circle" action={add} />
        </Section>
      </Form>
    </VStack>
  )
}

interface DetailProps {
  /** 第几条（自动函数名要用它保持一致）。 */
  index: number
  initial: ToolRow
  /** 改动推回列表页（列表页再推给设置页）。 */
  onChange: (p: Partial<ToolRow>) => void
  onDelete: () => void
}

/**
 * 单条工具的详情页：原来铺在列表里的全部配置都在这里，一个不删。
 * 现在由「工具列表」页用 path 路由推进来（见 nav_route.ts），所以不用再套 NavigationStack。
 */
export function ToolDetail({ index, initial, onChange, onDelete }: DetailProps) {
  const [t, setT] = useState<ToolRow>({ ...initial, params: (initial.params ?? []).map((p) => ({ ...p })) })
  /** 即时反馈（试运行结果 / 拷贝结果）。 */
  const [note, setNote] = useState("")
  const [hintOpen, setHintOpen] = useState(false)

  function patch(p: Partial<ToolRow>) {
    setT({ ...t, ...p })
    onChange(p)
  }

  function addParam() {
    patch({ params: [...(t.params ?? []), newParamDraft()] })
  }

  function updateParam(j: number, p: Partial<ParamDraft>) {
    patch({ params: (t.params ?? []).map((x, idx) => (idx === j ? { ...x, ...p } : x)) })
  }

  function removeParam(j: number) {
    patch({ params: (t.params ?? []).filter((_, idx) => idx !== j) })
  }

  /** 一键把「快捷指令」App 里拷来的名字贴上，省得手敲出细微差别。 */
  async function pasteShortcutName() {
    try {
      const text = ((await Pasteboard.getString()) ?? "").trim()
      const first = text.split(/\r?\n/)[0].trim()
      if (!first) {
        setNote("剪贴板是空的：先在「快捷指令」里长按那条快捷指令 → 拷贝，再回来点这个按钮。")
        return
      }
      patch({ shortcutName: first })
      setNote(`已粘贴名字：${first}`)
    } catch (e: any) {
      setNote("读剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  async function copyText(text: string, msg: string) {
    try {
      await Pasteboard.setString(text)
      setNote(msg)
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  /** 真跑一次看看通不通：把样例参数当输入交给快捷指令。 */
  async function testRun() {
    const name = (t.shortcutName ?? "").trim()
    if (!name) {
      setNote("这条还没填快捷指令名，先在上面写上名字（要和「快捷指令」App 里一致）。")
      return
    }
    const input = sampleArgsJSON(paramDraftsToSpecs(t.params ?? []))
    try {
      const ok = await Safari.openURL(runShortcutURL(name, input))
      setNote(
        ok
          ? `已交给系统运行${input ? "，输入：" + input : "（不带输入）"}。要是没任何反应，就是名字和 App 里对不上。`
          : "打不开这条快捷指令：名字多半写错了（要和「快捷指令」App 里完全一致）。",
      )
    } catch (e: any) {
      setNote("打开失败：" + (e?.message ?? String(e)))
    }
  }

  const params = t.params ?? []
  const specs = paramDraftsToSpecs(params)
  const auto = makeToolFunctionName("", t.shortcutName, index, new Set<string>()).name
  /** 快捷指令名里没有英文字母时，自动函数名只能退化成 tool1 这种 —— 提醒用户自己起名。 */
  const autoWeak = /^tool\d+$/.test(auto) && (t.shortcutName ?? "").trim().length > 0
  const shortcut = (t.shortcutName ?? "").trim() || auto

  return (
    <VStack
      navigationTitle={toolTitle(t)}
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
    >
      <Form>
        <Section
          header={<Text>{`快捷指令工具 ${index + 1}`}</Text>}
          footer={
            <Text>
              名字要和「快捷指令」App 里完全一致：可以手输，也可以先在那儿拷贝名字再点下面的按钮。
            </Text>
          }
        >
          <FieldRow label="快捷指令名">
            <TextField
              title="要和「快捷指令」App 里一致"
              value={t.shortcutName}
              onChanged={(v: string) => patch({ shortcutName: v })}
            />
          </FieldRow>
          <Button
            title="粘贴剪贴板里的名字"
            systemImage="doc.on.clipboard"
            action={pasteShortcutName}
          />
          <Text font="footnote" foregroundStyle="secondaryLabel">
            名字对不上时「试运行」会打不开：去「快捷指令」App 里核对一下。
          </Text>
        </Section>

        <Section header={<Text>模型看到的</Text>}>
          <FieldRow label="说明">
            <TextField
              title="给模型看：这工具干什么"
              value={t.description}
              onChanged={(v: string) => patch({ description: v })}
            />
          </FieldRow>
          <FieldRow label="工具名">
            <TextField
              title={t.name.trim() ? "英文，如 navigate_home" : `留空自动：${auto}`}
              value={t.name}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v: string) => patch({ name: v })}
            />
          </FieldRow>
          {!t.name.trim() ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {autoWeak
                ? `「${t.shortcutName.trim()}」里没有英文字母，自动生成的工具名会是 ${auto}，模型不容易看懂 —— 建议填个英文名（如 navigate_home）。`
                : `模型看到的工具名会是 ${auto}。`}
            </Text>
          ) : null}
        </Section>

        <Section
          header={<Text>参数</Text>}
          footer={
            <Text>模型会把填了的参数拼成一段 JSON 文本传给快捷指令；字段名留空的行会被忽略。</Text>
          }
        >
          {params.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有参数。不需要参数的快捷指令可以不加。</Text>
          ) : null}
          {params.map((p, j) => (
            <VStack key={p.id} spacing={6} padding={{ vertical: 6 }}>
              <HStack spacing={8}>
                <Text font="footnote" foregroundStyle="secondaryLabel">{`参数 ${j + 1}`}</Text>
                <Spacer />
                <Button title="删除" role="destructive" action={() => removeParam(j)} />
              </HStack>
              <FieldRow label="字段名">
                <TextField
                  title="英文，如 destination"
                  value={p.name}
                  autocorrectionDisabled
                  textInputAutocapitalization="never"
                  onChanged={(v: string) => updateParam(j, { name: v })}
                />
              </FieldRow>
              <FieldRow label="说明">
                <TextField
                  title="给模型看，如「目的地名称」"
                  value={p.description}
                  onChanged={(v: string) => updateParam(j, { description: v })}
                />
              </FieldRow>
              <FieldRow label="可选值">
                <TextField
                  title="留空不限，如 driving、walking"
                  value={p.enumText}
                  autocorrectionDisabled
                  textInputAutocapitalization="never"
                  onChanged={(v: string) => updateParam(j, { enumText: v })}
                />
              </FieldRow>
              <Toggle
                title={`参数 ${j + 1} 必填`}
                value={p.required}
                onChanged={(v: boolean) => updateParam(j, { required: v })}
              />
            </VStack>
          ))}
          <Button title="＋ 添加参数" systemImage="plus.circle" action={addParam} />

          {t.parameters ? (
            <VStack alignment="leading" spacing={6}>
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`这条用的是手写的完整参数 schema（比上面的表单参数优先级高），字段：${Object.keys(
                  t.parameters?.properties ?? {},
                ).join("、") || "（没有声明字段）"}`}
              </Text>
              <Button
                title="改成表单参数（清掉高级 schema）"
                action={() => patch({ parameters: undefined })}
              />
            </VStack>
          ) : null}
        </Section>

        <Section
          header={<Text>回传</Text>}
          footer={
            <Text>
              开着「回传」时，快捷指令末尾要按提示加回传动作（「文本」+「URL
              编码」+「打开 URL」），结果才会回到聊天里的过程卡片。
            </Text>
          }
        >
          <Toggle
            title="快捷指令会把结果回传给我"
            value={t.returns === true}
            onChanged={(v: boolean) => patch({ returns: v })}
          />
          <Toggle
            title="显示「快捷指令」那边怎么配"
            value={hintOpen}
            onChanged={(v: boolean) => setHintOpen(v)}
          />
          {hintOpen ? (
            <VStack alignment="leading" spacing={10} padding={{ vertical: 6 }}>
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {stepsFor(shortcut, specs, t.returns === true)}
              </Text>
              <Button
                title="拷贝回调 URL"
                systemImage="link"
                action={() =>
                  copyText(
                    callbackURL(shortcut),
                    "已拷贝回调 URL：在快捷指令里用「文本」动作粘上它，后面紧跟要回传的内容。",
                  )
                }
              />
              {specs.length > 0 ? (
                <Button
                  title="拷贝参数说明"
                  systemImage="doc.on.clipboard"
                  action={() => copyText(paramsHelp(shortcut, specs), "已拷贝参数说明：照着在快捷指令里取字段。")}
                />
              ) : null}
              <Button
                title="拷贝完整说明（含回传）"
                systemImage="doc.text"
                action={() => copyText(shortcutProtocolText(scriptName()), "已拷贝完整说明：贴进备忘录照着配。")}
              />
            </VStack>
          ) : null}
        </Section>

        <Section>
          <Button title="试运行这条快捷指令" systemImage="play.circle" action={testRun} />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
          <Button title="删除这条工具" role="destructive" action={onDelete} />
        </Section>
      </Form>
    </VStack>
  )
}

export default ToolsPage
