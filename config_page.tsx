import {
  Button, fetch, Form, HStack, Image, NavigationStack, Picker, Section, SecureField, Spacer, Text,
  TextField, Toggle, VStack, useState,
} from "scripting"
import {
  AgentConfig, AgentTool, DEFAULT_SYSTEM_PROMPT, McpServer, loadConfig, makeMcpServer, saveConfig,
  validateConfig,
} from "./agent_store"
import { listMcpTools } from "./mcp_client"
import { kbStats } from "./kb_store"
import { DEFAULT_EMBED_PATH, embedReady, embedSettingsOf, embedTexts, QUERY_TIMEOUT_MS } from "./embed_client"
import { skillCounts } from "./skills_store"
import { KbPage } from "./kb_page"
import { SkillsPage } from "./skills_page"
import {
  AVATAR_PATH, Avatar, PENDING_AVATAR_PATH, captureAvatarPhoto, chooseAvatarFromPhotos,
  commitAvatar, discardAvatar, removeAvatarFile,
} from "./avatar"

// ———————————————————————— 思考深度 ————————————————————————

type ThinkingTier = "off" | "low" | "medium" | "high"

const TIERS: { key: ThinkingTier; label: string; desc: string; cost: string }[] = [
  { key: "off", label: "关闭", desc: "不做额外推理，直接给答案", cost: "最快、最省 token" },
  { key: "low", label: "浅层", desc: "想一点点，适合简单问答", cost: "较快、消耗少" },
  { key: "medium", label: "标准", desc: "先理一遍再回答，日常够用", cost: "适中" },
  { key: "high", label: "深度", desc: "反复斟酌，多步任务更稳", cost: "最慢、最费 token" },
]

/** 把配置里的 thinkingEnabled + reasoningEffort 反解成档位。 */
function tierOf(cfg: AgentConfig): ThinkingTier {
  if (!cfg.thinkingEnabled) return "off"
  const effort = (cfg.reasoningEffort || "").toLowerCase()
  return effort === "low" || effort === "medium" ? effort : "high"
}

type ToolRow = Omit<AgentTool, "paramsHint"> & { id: string; paramsHint: string }

let toolSeq = 0
function toRow(seed?: AgentTool): ToolRow {
  toolSeq += 1
  return {
    id: "t" + toolSeq,
    name: seed?.name ?? "",
    description: seed?.description ?? "",
    shortcutName: seed?.shortcutName ?? "",
    paramsHint: seed?.paramsHint ?? "",
    parameters: seed?.parameters,
  }
}

interface FormState {
  // 角色
  agentName: string
  agentEmoji: string
  greetText: string
  /** 头像图片路径；空 = 用 emoji。选择照片时先指向暂存文件，保存时才转正。 */
  avatarPath: string
  // 模型
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  // 对话
  /** 智能体设定：发给模型的系统提示词。 */
  systemPrompt: string
  /** 上下文聊天记录数量（以文本保存，空值在保存时兜底 50）。 */
  maxHistory: string
  /** 思考深度档位，保存时映射回 thinkingEnabled + reasoningEffort。 */
  thinking: ThinkingTier
  /** 聊天页是否展示 AI 思考 / 工具调用过程。 */
  showSteps: boolean
  speakReply: boolean
  // 工具
  tools: ToolRow[]
  // MCP
  mcpServers: McpServer[]
  // 知识库 / 技能
  kbEnabled: boolean
  skillsEnabled: boolean
  // 知识库语义检索（可选）
  embedEnabled: boolean
  embedBaseUrl: string
  embedPath: string
  embedApiKey: string
  embedModel: string
}

function toFormState(cfg: AgentConfig): FormState {
  return {
    agentName: cfg.agentName,
    agentEmoji: cfg.agentEmoji,
    greetText: cfg.greetText,
    avatarPath: cfg.avatarPath ?? "",
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    apiPath: cfg.apiPath,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    maxHistory: String(cfg.maxHistory),
    thinking: tierOf(cfg),
    showSteps: cfg.showSteps !== false,
    speakReply: cfg.speakReply,
    tools: (cfg.tools ?? []).map((t) => toRow(t)),
    mcpServers: (cfg.mcpServers ?? []).map((m) => ({ ...m })),
    kbEnabled: cfg.kbEnabled,
    skillsEnabled: cfg.skillsEnabled,
    embedEnabled: cfg.embedEnabled === true,
    embedBaseUrl: cfg.embedBaseUrl ?? "",
    embedPath: cfg.embedPath ?? DEFAULT_EMBED_PATH,
    embedApiKey: cfg.embedApiKey ?? "",
    embedModel: cfg.embedModel ?? "",
  }
}

interface Props {
  /** 关闭设置页（保存 / 取消都走这里，由聊天页控制 sheet 状态）。 */
  onClose?: () => void
}

/** 设置页：角色 / 模型 / 对话 / 工具。以 sheet 形式从聊天页打开。 */
export function ConfigPage({ onClose = () => {} }: Props) {
  const [state, setState] = useState<FormState>(() => toFormState(loadConfig()))
  /** 正在测试连接的那个服务器 id（空字符串 = 没有在测试）。 */
  const [testing, setTesting] = useState("")
  /** 「拉取可用模型」拿到的模型名；空 = 还没拉过（那就不显示下拉）。 */
  const [models, setModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  /** 知识库 / 技能管理页的呈现状态。 */
  const [kbOpen, setKbOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  /** 向量服务测试状态 / 结果行。 */
  const [embedBusy, setEmbedBusy] = useState(false)
  const [embedMsg, setEmbedMsg] = useState("")

  const patch = (p: Partial<FormState>) => setState({ ...state, ...p })

  // 统计数字：管理页关闭时本页会重渲染，直接重算即可
  const kbStat = kbStats()
  const skillStat = skillCounts()

  function updateTool(index: number, p: Partial<AgentTool>) {
    patch({ tools: state.tools.map((t, i) => (i === index ? { ...t, ...p } : t)) })
  }

  function addTool() {
    patch({ tools: [...state.tools, toRow()] })
  }

  function removeTool(index: number) {
    patch({ tools: state.tools.filter((_, i) => i !== index) })
  }

  // —— 头像 ——

  async function pickAvatar() {
    try {
      const path = await chooseAvatarFromPhotos()
      if (path) patch({ avatarPath: path })
    } catch (e: any) {
      Dialog.alert({ message: "选择照片失败：" + (e?.message ?? String(e)) })
    }
  }

  async function shootAvatar() {
    try {
      const path = await captureAvatarPhoto()
      if (path) patch({ avatarPath: path })
    } catch (e: any) {
      Dialog.alert({ message: "拍照失败：" + (e?.message ?? String(e)) })
    }
  }

  /** 去掉自定义照片，回到 emoji。 */
  function dropAvatar() {
    discardAvatar()
    patch({ avatarPath: "" })
  }

  /** 取消：丢掉选了但没保存的照片。 */
  function cancel() {
    discardAvatar()
    onClose()
  }

  function updateServer(id: string, p: Partial<McpServer>) {
    patch({ mcpServers: state.mcpServers.map((m) => (m.id === id ? { ...m, ...p } : m)) })
  }

  function addServer() {
    patch({ mcpServers: [...state.mcpServers, makeMcpServer()] })
  }

  function removeServer(id: string) {
    patch({ mcpServers: state.mcpServers.filter((m) => m.id !== id) })
  }

  /** 测试连接：真发一次 initialize + tools/list，把工具名列出来。 */
  async function testServer(m: McpServer) {
    const url = (m.url ?? "").trim()
    if (!url) {
      Dialog.alert({ message: "先填服务器地址，比如 https://example.com/mcp" })
      return
    }
    setTesting(m.id)
    try {
      const list = await listMcpTools(
        { ...m, url, name: m.name.trim() || m.id, enabled: true },
        true,
      )
      if (list.error) {
        Dialog.alert({ title: "连接失败", message: list.error })
        return
      }
      if (list.tools.length === 0) {
        Dialog.alert({ title: "连接成功", message: "连上了，但服务器没有提供任何工具。" })
        return
      }
      const names = list.tools.slice(0, 12).map((t) => "· " + t.name).join("\n")
      const more = list.tools.length > 12 ? `\n…另外 ${list.tools.length - 12} 个` : ""
      Dialog.alert({
        title: "连接成功",
        message: `拿到 ${list.tools.length} 个工具：\n${names}${more}`,
      })
    } catch (e: any) {
      Dialog.alert({ title: "测试失败", message: e?.message ?? String(e) })
    } finally {
      setTesting("")
    }
  }

  /** 上下文条数的说明弹窗（表单里放不下 tooltip，用弹窗替代）。 */
  function showHistoryTip() {
    Dialog.alert({
      title: "上下文聊天记录数量",
      message: [
        "每次请求最多带上最近这么多条消息（你发的和助手回的都算）。",
        "",
        "调大：助手记得更久，适合长对话；代价是每次请求体更大、更慢、也更费 token。",
        "调小：更快更省，但助手会「忘掉」前面说过的话。",
        "",
        "默认 50 条，一般不用改。",
      ].join("\n"),
    })
  }

  // —— 知识库语义检索（可选） ——

  /** 用表单里**当前**填的值（不必先保存）拼一份设置。 */
  function embedSettingsFromForm(enabled: boolean) {
    return embedSettingsOf({
      embedEnabled: enabled,
      embedBaseUrl: state.embedBaseUrl,
      embedPath: state.embedPath,
      embedApiKey: state.embedApiKey,
      embedModel: state.embedModel,
    })
  }

  /** 真发一次 /embeddings，把返回维度和耗时告诉用户。 */
  async function testEmbed() {
    const s = embedSettingsFromForm(true)
    if (!s.baseUrl || !s.model) {
      Dialog.alert({
        message: "先填「接口地址」和「向量模型」，比如 https://api.siliconflow.cn/v1 + BAAI/bge-m3",
      })
      return
    }
    setEmbedBusy(true)
    setEmbedMsg("正在测试…")
    const t0 = Date.now()
    try {
      const vecs = await embedTexts(["这是一次连通性测试"], s, "query", QUERY_TIMEOUT_MS)
      const dim = vecs[0] ? vecs[0].length : 0
      const ms = Date.now() - t0
      setEmbedMsg(`✅ 可用：${dim} 维，${ms} ms`)
      Dialog.alert({
        title: "向量服务可用",
        message: `返回 ${dim} 维向量，用时 ${ms} ms。\n\n保存后进「管理知识库」点一下「建向量」，就能用上语义检索。`,
      })
    } catch (e: any) {
      setEmbedMsg("❌ " + String(e?.message ?? e))
    } finally {
      setEmbedBusy(false)
    }
  }

  /** 拉模型列表：拿上面的地址和 Key 请求一次 <接口地址>/models。 */
  async function fetchModels() {
    const baseUrl = state.baseUrl.trim().replace(/\/+$/, "")
    if (!baseUrl) {
      Dialog.alert({ message: "先填接口地址，比如 https://api.deepseek.com" })
      return
    }
    setFetchingModels(true)
    try {
      const headers: Record<string, string> = { Accept: "application/json" }
      const key = state.apiKey.trim()
      if (key) headers.Authorization = "Bearer " + key
      const resp = await fetch(baseUrl + "/models", { headers })
      if (!resp.ok) {
        const text = await resp.text()
        Dialog.alert({
          title: `拉取失败（${resp.status}）`,
          message: text.slice(0, 400) || "服务端没返回可用模型列表，手动填「模型」就行。",
        })
        return
      }
      const data: any = await resp.json()
      const raw: any[] = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : []
      const list: string[] = []
      for (const item of raw) {
        const id = typeof item === "string" ? item : item?.id ?? item?.name
        if (typeof id === "string" && id.trim() && list.indexOf(id) < 0) list.push(id.trim())
      }
      list.sort()
      if (list.length === 0) {
        Dialog.alert({
          title: "没拿到模型",
          message: "接口返回里没有模型列表，手动填「模型」就行。",
        })
        return
      }
      setModels(list)
      if (list.indexOf(state.model) < 0) patch({ model: list[0] })
    } catch (e: any) {
      Dialog.alert({ title: "拉取失败", message: e?.message ?? String(e) })
    } finally {
      setFetchingModels(false)
    }
  }

  function save() {
    const tools: AgentTool[] = []
    for (const t of state.tools) {
      const name = (t.name ?? "").trim()
      const shortcutName = (t.shortcutName ?? "").trim()
      const description = (t.description ?? "").trim()
      if (!name && !shortcutName && !description) continue // 整行空白 → 跳过
      if (!name || !shortcutName) {
        Dialog.alert({ message: "每个工具都要填「名称」和「快捷指令名」" })
        return
      }
      tools.push({
        name,
        description: description || name,
        shortcutName,
        parameters: t.parameters,
      })
    }

    const mcpServers: McpServer[] = []
    for (const m of state.mcpServers) {
      const url = (m.url ?? "").trim()
      if (!url) continue // 没填地址的一律丢掉
      mcpServers.push({
        ...m,
        id: m.id || makeMcpServer().id,
        name: (m.name ?? "").trim() || url.replace(/^https?:\/\//, "").split("/")[0],
        url,
        token: (m.token ?? "").trim(),
        headersHint: m.headersHint ?? "",
      })
    }

    // 头像：暂存文件转正；没选照片就把旧文件删掉
    let avatarPath = state.avatarPath.trim()
    if (avatarPath === PENDING_AVATAR_PATH) {
      avatarPath = commitAvatar() ? AVATAR_PATH : ""
    } else if (avatarPath !== AVATAR_PATH) {
      avatarPath = ""
    }
    if (!avatarPath) removeAvatarFile()

    const cfg: AgentConfig = {
      ...loadConfig(),
      agentName: state.agentName.trim() || "小助",
      agentEmoji: state.agentEmoji.trim() || "✨",
      avatarPath: avatarPath || undefined,
      greetText: state.greetText.trim(),
      apiKey: state.apiKey.trim(),
      baseUrl: state.baseUrl.trim(),
      apiPath: state.apiPath.trim(),
      model: state.model.trim(),
      systemPrompt: state.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      maxHistory: Math.max(1, parseInt(state.maxHistory, 10) || 50),
      thinkingEnabled: state.thinking !== "off",
      reasoningEffort: state.thinking === "off" ? "" : state.thinking,
      showSteps: state.showSteps,
      speakReply: state.speakReply,
      tools,
      mcpServers,
      kbEnabled: state.kbEnabled,
      skillsEnabled: state.skillsEnabled,
      embedEnabled: state.embedEnabled,
      embedBaseUrl: state.embedBaseUrl.trim(),
      embedPath: state.embedPath.trim() || DEFAULT_EMBED_PATH,
      embedApiKey: state.embedApiKey.trim(),
      embedModel: state.embedModel.trim(),
    }

    const err = validateConfig(cfg)
    if (err) {
      Dialog.alert({ message: err })
      return
    }
    saveConfig(cfg)
    onClose()
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle="设置"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarLeading: <Button title="取消" action={cancel} />,
          topBarTrailing: <Button title="保存" action={save} fontWeight="semibold" />,
        }}
        sheet={[
          {
            content: <KbPage onClose={() => setKbOpen(false)} />,
            isPresented: kbOpen,
            onChanged: setKbOpen,
          },
          {
            content: <SkillsPage onClose={() => setSkillsOpen(false)} />,
            isPresented: skillsOpen,
            onChanged: setSkillsOpen,
          },
        ]}
      >
        <Form>
          <Section
            header={<Text>角色</Text>}
            footer={
              <Text>
                助手名字会显示在聊天页顶部和左侧侧边栏。头像可以上传一张照片，也可以只填一个 emoji（✨ 🐱 🤖 🧠）。改完点「保存」生效。
              </Text>
            }
          >
            <TextField
              title="助手名字"
              value={state.agentName}
              prompt="小助"
              onChanged={(v) => patch({ agentName: v })}
            />
            <HStack spacing={14} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity" }}>
              <Avatar
                spec={{ emoji: state.agentEmoji.trim() || "✨", path: state.avatarPath }}
                size={56}
              />
              <VStack alignment="leading" spacing={2}>
                <Text>助手头像</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {state.avatarPath ? "使用自定义照片" : "当前是 emoji"}
                </Text>
              </VStack>
              <Spacer />
            </HStack>
            <Button title="从相册选择照片" action={pickAvatar} />
            <Button title="拍一张照片" action={shootAvatar} />
            {state.avatarPath ? (
              <Button title="恢复 emoji 头像" role="destructive" action={dropAvatar} />
            ) : null}
            <TextField
              title="头像 emoji"
              value={state.agentEmoji}
              prompt="✨"
              onChanged={(v) => patch({ agentEmoji: v })}
            />
            <TextField
              title="开场白"
              value={state.greetText}
              prompt="说点什么，或者点下面的麦克风直接听写"
              onChanged={(v) => patch({ greetText: v })}
            />
          </Section>

          <Section
            header={<Text>模型接口</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  API Key：DeepSeek 的形如 sk-xxxxxxxx（32 位字符），在 platform.deepseek.com 的「API Keys」里创建。只保存在本机，不会上传到别处。
                </Text>
                <Text>
                  接口地址：只填到域名（或 /v1）为止，比如 https://api.deepseek.com；请求路径另填，默认 /chat/completions。换成別的 OpenAI 兼容服务时改这两项。
                </Text>
              </VStack>
            }
          >
            <SecureField
              title="API Key"
              value={state.apiKey}
              prompt="sk-…"
              onChanged={(v) => patch({ apiKey: v })}
            />
            <TextField
              title="接口地址"
              value={state.baseUrl}
              prompt="https://api.deepseek.com"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ baseUrl: v })}
            />
            <TextField
              title="请求路径"
              value={state.apiPath}
              prompt="/chat/completions"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ apiPath: v })}
            />
          </Section>

          <Section
            header={<Text>模型</Text>}
            footer={
              <Text>
                点「拉取可用模型」会用上面的地址和 Key 请求一次 /models，把服务端支持的模型列出来；列不出来就手动填。
              </Text>
            }
          >
            {models.length > 0 ? (
              <Picker
                title="模型"
                pickerStyle="menu"
                value={state.model}
                onChanged={(v: string) => patch({ model: v })}
              >
                {models.map((m) => (
                  <Text key={m} tag={m}>
                    {m}
                  </Text>
                ))}
              </Picker>
            ) : null}
            <TextField
              title={models.length > 0 ? "模型（手动填写）" : "模型"}
              value={state.model}
              prompt="deepseek-flash"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ model: v })}
            />
            <Button
              title={fetchingModels ? "正在拉取…" : "拉取可用模型"}
              systemImage="arrow.down.circle"
              disabled={fetchingModels}
              action={fetchModels}
            />
            {models.length > 0 ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`已拿到 ${models.length} 个模型`}
              </Text>
            ) : null}
          </Section>

          <Section
            header={<Text>思考深度</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                {TIERS.map((t) => (
                  <Text key={t.key}>
                    {`${state.thinking === t.key ? "●" : "○"} ${t.label}：${t.desc}（${t.cost}）`}
                  </Text>
                ))}
                <Text>
                  档位越高，模型回答前想得越多：多步任务、需要斟酌工具参数时更准，但也更慢、更费 token。
                </Text>
              </VStack>
            }
          >
            <Picker
              title="思考深度"
              pickerStyle="segmented"
              value={state.thinking}
              onChanged={(v: string) => patch({ thinking: v as ThinkingTier })}
            >
              {TIERS.map((t) => (
                <Text key={t.key} tag={t.key}>
                  {t.label}
                </Text>
              ))}
            </Picker>
          </Section>

          <Section
            header={<Text>智能体设定</Text>}
            footer={
              <Text>
                这段文字就是发给模型的系统提示词，决定它的人设、语气和边界。改坏了点「恢复默认设定」。
              </Text>
            }
          >
            <TextField
              title="系统提示词"
              value={state.systemPrompt}
              axis="vertical"
              lineLimit={{ min: 3, max: 12, reservesSpace: true }}
              onChanged={(v) => patch({ systemPrompt: v })}
            />
            <Button
              title="恢复默认设定"
              systemImage="arrow.counterclockwise"
              action={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
            />
          </Section>

          <Section
            header={<Text>对话</Text>}
            footer={
              <Text>
                文本聊天不朗读。想边说边听就走右上角「语音」进入语音通话模式（那边会自动朗读回复）。
              </Text>
            }
          >
            <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
              <Text>{`上下文聊天记录数量：${state.maxHistory.trim() || "50"} 条`}</Text>
              <Spacer />
              <Image
                systemName="info.circle"
                foregroundStyle="secondaryLabel"
                onTapGesture={showHistoryTip}
              />
            </HStack>
            <TextField
              title="条数"
              value={state.maxHistory}
              prompt="50"
              keyboardType="numberPad"
              onChanged={(v) => patch({ maxHistory: v })}
            />
            <Toggle
              title="显示 AI 过程"
              value={state.showSteps}
              onChanged={(v) => patch({ showSteps: v })}
            />
            <Text font="footnote" foregroundStyle="secondaryLabel">
              打开后每条回复上方会带一张可展开的过程卡片：模型的思考内容，以及每次工具调用的名称、参数和返回结果。关掉就只看最终答复。
            </Text>
          </Section>

          {state.tools.map((t, i) => (
            <Section
              key={t.id}
              header={<Text>{`本地快捷指令工具 ${i + 1}${t.name.trim() ? " · " + t.name.trim() : ""}`}</Text>}
            >
              <TextField
                title="名称"
                value={t.name}
                prompt="如 open_dnd"
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => updateTool(i, { name: v })}
              />
              <TextField
                title="说明"
                value={t.description}
                prompt="给模型看的用途说明"
                onChanged={(v) => updateTool(i, { description: v })}
              />
              <TextField
                title="快捷指令名"
                value={t.shortcutName}
                prompt="与「快捷指令」App 里完全一致"
                onChanged={(v) => updateTool(i, { shortcutName: v })}
              />
              <TextField
                title="参数"
                value={t.paramsHint}
                prompt={"每行一个：字段名=说明\n例如 destination=目的地名称\nmode=出行方式 driving/walking"}
                axis="vertical"
                lineLimit={{ min: 1, max: 5 }}
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => updateTool(i, { paramsHint: v })}
              />
              <Button
                title="删除这个工具"
                role="destructive"
                action={() => removeTool(i)}
              />
            </Section>
          ))}

          <Section
            header={<Text>本地快捷指令工具</Text>}
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
              </VStack>
            }
          >
            <Button title="添加快捷指令工具" systemImage="plus.circle.fill" action={addTool} />
            {state.tools.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有本地快捷指令工具</Text>
            ) : null}
          </Section>

          {state.mcpServers.map((m, i) => (
            <Section
              key={m.id}
              header={
                <Text>{`MCP 服务器 ${i + 1}${m.name.trim() ? " · " + m.name.trim() : ""}`}</Text>
              }
            >
              <TextField
                title="名称"
                value={m.name}
                prompt="如 deepwiki"
                onChanged={(v) => updateServer(m.id, { name: v })}
              />
              <TextField
                title="地址"
                value={m.url}
                prompt="https://example.com/mcp"
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => updateServer(m.id, { url: v })}
              />
              <SecureField
                title="令牌"
                value={m.token ?? ""}
                prompt="可选，Bearer Token"
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => updateServer(m.id, { token: v })}
              />
              <TextField
                title="额外请求头"
                value={m.headersHint ?? ""}
                prompt={"可选，每行一个\nHeader: Value"}
                axis="vertical"
                lineLimit={{ min: 1, max: 4 }}
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => updateServer(m.id, { headersHint: v })}
              />
              <Toggle
                title="启用"
                value={m.enabled}
                onChanged={(v) => updateServer(m.id, { enabled: v })}
              />
              <Button
                title={testing === m.id ? "正在测试…" : "测试连接"}
                disabled={testing !== ""}
                action={() => testServer(m)}
              />
              <Button
                title="删除这个服务器"
                role="destructive"
                action={() => removeServer(m.id)}
              />
            </Section>
          ))}

          <Section
            header={<Text>MCP 服务器</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  MCP（模型上下文协议）服务器能提供一批带真返回值的工具，比快捷指令更完整：模型能拿到结果再回答你。
                </Text>
                <Text>
                  只支持远程 HTTP 类型（地址形如 https://example.com/mcp）。需要本地跑命令的 stdio 型服务器连不了：iOS 沙箱里没有常驻子进程管道。
                </Text>
                <Text>
                  不想每次都去连，可以先把「启用」关掉；工具清单会缓存 5 分钟，改完配置点「测试连接」会强制重新拉一次。
                </Text>
              </VStack>
            }
          >
            <Button title="添加服务器" systemImage="plus.circle.fill" action={addServer} />
            {state.mcpServers.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有 MCP 服务器</Text>
            ) : null}
          </Section>

          <Section
            header={<Text>知识库</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  给自己的资料建一个离线检索库：把文件放进「文件」App → Scripting → 知识库，再从下面进去导一次。
                </Text>
                <Text>
                  检索全在本机做（中文双字切词 + BM25），不联网、不需要额外付费能力。开启后模型会多一个 search_knowledge 工具，问到相关资料时先去查。
                </Text>
              </VStack>
            }
          >
            <Toggle
              title="启用知识库检索"
              value={state.kbEnabled}
              onChanged={(v) => patch({ kbEnabled: v })}
            />
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {kbStat.docs > 0
                ? `已导入 ${kbStat.docs} 份资料 · ${kbStat.chunks} 个片段`
                : "还没有资料，进去导一次就行"}
            </Text>
            <Button
              title="管理知识库"
              systemImage="books.vertical"
              action={() => setKbOpen(true)}
            />
          </Section>

          <Section
            header={<Text>知识库语义检索（可选）</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  给知识库加一层「按意思找」的能力：每个片段预先算成向量存在本机，检索时与关键词结果混合排序。现有资料不用改。
                </Text>
                <Text>
                  需要一个 OpenAI 兼容的向量接口（硅基流动 / 智谱 / OpenAI / 自建都行）。不填就保持纯离线关键词检索，功能不受影响。
                </Text>
                <Text>换了向量模型要重新建一次向量（旧向量作废）。</Text>
              </VStack>
            }
          >
            <Toggle
              title="启用语义检索"
              value={state.embedEnabled}
              onChanged={(v) => patch({ embedEnabled: v })}
            />
            <TextField
              title="接口地址"
              prompt="https://api.siliconflow.cn/v1"
              value={state.embedBaseUrl}
              onChanged={(v) => patch({ embedBaseUrl: v })}
            />
            <TextField
              title="路径"
              prompt={DEFAULT_EMBED_PATH}
              value={state.embedPath}
              onChanged={(v) => patch({ embedPath: v })}
            />
            <SecureField
              title="API Key"
              prompt="sk-…"
              value={state.embedApiKey}
              onChanged={(v) => patch({ embedApiKey: v })}
            />
            <TextField
              title="向量模型"
              prompt="BAAI/bge-m3"
              value={state.embedModel}
              onChanged={(v) => patch({ embedModel: v })}
            />
            <Button
              title={embedBusy ? "测试中…" : "测试向量服务"}
              systemImage="bolt.horizontal.circle"
              disabled={embedBusy}
              action={testEmbed}
            />
            {embedMsg ? (
              <Text
                font="footnote"
                foregroundStyle={embedMsg.indexOf("✅") === 0 ? "secondaryLabel" : "systemRed"}
              >
                {embedMsg}
              </Text>
            ) : null}
          </Section>

          <Section
            header={<Text>技能</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  技能就是一份份操作说明（含 SKILL.md 的文件夹或 .zip）。开启后系统提示里只列技能名和描述，模型要用时会自己用 read_skill 读全文。
                </Text>
                <Text>
                  注意：技能里写的脚本能不能跑，取决于脚本类型——纯 JS 的能跑，需要原生代码 / 二进制的不行（沙箱限制）。
                </Text>
              </VStack>
            }
          >
            <Toggle
              title="启用技能"
              value={state.skillsEnabled}
              onChanged={(v) => patch({ skillsEnabled: v })}
            />
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {skillStat.total > 0
                ? `${skillStat.total} 个技能 · 启用 ${skillStat.enabled} 个`
                : "还没有技能，进去导一次就行"}
            </Text>
            <Button
              title="管理技能"
              systemImage="shippingbox"
              action={() => setSkillsOpen(true)}
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default ConfigPage
