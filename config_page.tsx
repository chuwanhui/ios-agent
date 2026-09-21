import {
  Button, fetch, Form, HStack, Image, NavigationLink, NavigationStack, Picker, Section, SecureField,
  Spacer, Text, TextField, Toggle, VStack, useState,
} from "scripting"
import {
  AgentConfig, DEFAULT_SYSTEM_PROMPT, McpServer, loadConfig, makeMcpServer, saveConfig,
  validateConfig,
} from "./agent_store"
import { kbStats } from "./kb_store"
import { DEFAULT_EMBED_PATH, embedReady, embedSettingsOf, embedTexts, QUERY_TIMEOUT_MS } from "./embed_client"
import { skillCounts } from "./skills_store"
import { KbPage } from "./kb_page"
import { SkillsPage } from "./skills_page"
import { FieldRow, ToolRow, ToolsPage, toAgentTools, toToolRow } from "./tools_page"
import { McpPage } from "./mcp_page"
import {
  AVATAR_PATH, Avatar, PENDING_AVATAR_PATH, chooseAvatarFromPhotos, commitAvatar, discardAvatar,
} from "./avatar"

// ———————————————————————— 思考深度 ————————————————————————

type ThinkingTier = "off" | "low" | "medium" | "high"

const TIERS: { key: ThinkingTier; label: string; desc: string; cost: string }[] = [
  { key: "off", label: "关闭", desc: "不做额外推理，直接给答案", cost: "最快、最省 token" },
  { key: "low", label: "浅层", desc: "想一点点，适合简单问答", cost: "较快、消耗少" },
  { key: "medium", label: "标准", desc: "先理一遍再回答，日常够用", cost: "适中" },
  { key: "high", label: "深度", desc: "反复斟酌，多步任务更稳", cost: "最慢、最费 token" },
]

/** 时间戳 → 「09-22 23:07」（显示模型列表上次拉取时间用）。 */
function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => (n < 10 ? "0" + n : String(n))
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 把配置里的 thinkingEnabled + reasoningEffort 反解成档位。 */
function tierOf(cfg: AgentConfig): ThinkingTier {
  if (!cfg.thinkingEnabled) return "off"
  const effort = (cfg.reasoningEffort || "").toLowerCase()
  return effort === "low" || effort === "medium" ? effort : "high"
}

interface FormState {
  // 角色
  agentName: string
  /** 头像图片路径；空 = 显示占位图。选择照片时先指向暂存文件，保存时才转正。 */
  avatarPath: string
  // 模型
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  /** 上次从 /models 拉回来的可用模型；界面只能从这里选（不给手输）。 */
  modelOptions: string[]
  /** 上次拉取的时间（毫秒，0 = 从没拉过）。 */
  modelOptionsAt: number
  // 对话
  /** 智能体设定：发给模型的系统提示词。 */
  systemPrompt: string
  /** 上下文聊天记录数量（以文本保存，空值在保存时兜底 50）。 */
  maxHistory: string
  /** 思考深度档位，保存时映射回 thinkingEnabled + reasoningEffort。 */
  thinking: ThinkingTier
  /** 聊天页是否展示 AI 思考 / 工具调用过程。 */
  showSteps: boolean
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
    avatarPath: cfg.avatarPath ?? "",
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    apiPath: cfg.apiPath,
    model: cfg.model,
    modelOptions: cfg.modelOptions ?? [],
    modelOptionsAt: cfg.modelOptionsAt ?? 0,
    systemPrompt: cfg.systemPrompt,
    maxHistory: String(cfg.maxHistory),
    thinking: tierOf(cfg),
    showSteps: cfg.showSteps !== false,
    tools: (cfg.tools ?? []).map((t) => toToolRow(t)),
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

/** 设置页里的入口行：图标 + 标题 + 副标题，点进去是子页（右侧箭头由 NavigationLink 自带）。 */
export function NavRow(props: { icon: string; title: string; detail: string; destination: any }) {
  return (
    <NavigationLink destination={props.destination}>
      <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Image
          systemName={props.icon}
          foregroundStyle="secondaryLabel"
          frame={{ width: 26, alignment: "center" }}
        />
        <VStack
          alignment="leading"
          spacing={2}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          <Text foregroundStyle="label">{props.title}</Text>
          {props.detail ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {props.detail}
            </Text>
          ) : null}
        </VStack>
      </HStack>
    </NavigationLink>
  )
}

interface Props {
  /** 关闭设置页（保存 / 取消都走这里，由聊天页控制 sheet 状态）。 */
  onClose?: () => void
}

/** 设置页：角色 / 模型 / 对话 / 工具。以 sheet 形式从聊天页打开。 */
export function ConfigPage({ onClose = () => {} }: Props) {
  const [state, setState] = useState<FormState>(() => toFormState(loadConfig()))
  /** 可用模型 = 上次从接口拉回来的那份（只能从这里选，不给手输）。空 = 还没拉过。 */
  const models = state.modelOptions
  /** 配置里存的模型是否在拉回来的列表里。 */
  const modelInList = models.indexOf(state.model.trim()) >= 0
  const [fetchingModels, setFetchingModels] = useState(false)
  /** 知识库 / 技能子页改完数据回来后，用它强制本页重算统计数字。 */
  const [, setTick] = useState(0)
  /** 向量服务测试状态 / 结果行。 */
  const [embedBusy, setEmbedBusy] = useState(false)
  const [embedMsg, setEmbedMsg] = useState("")

  const patch = (p: Partial<FormState>) => setState({ ...state, ...p })

  // 统计数字：管理页关闭时本页会重渲染，直接重算即可
  const kbStat = kbStats()
  const skillStat = skillCounts()

  // 入口行的副标题
  const toolDetail =
    state.tools.length > 0 ? `已配置 ${state.tools.length} 个` : "还没有，进去加一个"
  const mcpDetail =
    state.mcpServers.length > 0
      ? `${state.mcpServers.length} 台服务器 · 启用 ${state.mcpServers.filter((m) => m.enabled && (m.url ?? "").trim()).length} 台`
      : "还没有，可以粘贴 JSON 导入"

  // —— 头像 ——

  async function pickAvatar() {
    try {
      const path = await chooseAvatarFromPhotos()
      if (path) patch({ avatarPath: path })
    } catch (e: any) {
      Dialog.alert({ message: "选择照片失败：" + (e?.message ?? String(e)) })
    }
  }

  /** 取消：丢掉选了但没保存的照片。 */
  function cancel() {
    discardAvatar()
    onClose()
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
          message:
            text.slice(0, 400) ||
            "服务端没返回可用模型列表。核一下接口地址、Key 和网络，再点一次「拉取可用模型」。",
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
          message:
            "接口返回里没有模型列表。这条路要求接口是 OpenAI 兼容的（支持 GET /models + Bearer Key），换一个能列出模型的接口地址再拉。",
        })
        return
      }
      patch({
        modelOptions: list,
        modelOptionsAt: Date.now(),
        model: list.indexOf(state.model.trim()) < 0 ? list[0] : state.model,
      })
    } catch (e: any) {
      Dialog.alert({ title: "拉取失败", message: e?.message ?? String(e) })
    } finally {
      setFetchingModels(false)
    }
  }

  function save() {
    // 模型只能从拉回来的列表里选：没拉过 / 存的模型已不在列表，都不让保存
    if (models.length === 0) {
      Dialog.alert({
        title: "还没拉取模型",
        message:
          "填好上面的「接口地址」和「API Key」，到「模型」那一点「拉取可用模型」——脚本会请求一次 /models，把服务端真正支持的模型列出来，再从列表里选一个。",
      })
      return
    }
    if (!modelInList) {
      Dialog.alert({
        title: "模型要重新选",
        message: `配置里存的「${state.model.trim() || "（空）"}」不在拉回来的列表里（可能换过服务商或接口变了）。重新拉一次，再从列表里选一个。`,
      })
      return
    }
    // 工具：草稿行 → AgentTool（顺带补回以前会被丢掉的「参数」）
    const built = toAgentTools(state.tools)
    if (built.error) {
      Dialog.alert({ message: built.error })
      return
    }
    const tools = built.tools

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

    // 头像：选了照片就把暂存文件转正，没选就留空（显示占位图）
    let avatarPath = state.avatarPath.trim()
    if (avatarPath === PENDING_AVATAR_PATH) {
      avatarPath = commitAvatar() ? AVATAR_PATH : ""
    } else if (avatarPath !== AVATAR_PATH) {
      avatarPath = ""
    }

    const cfg: AgentConfig = {
      ...loadConfig(),
      agentName: state.agentName.trim() || "小助",
      avatarPath: avatarPath || undefined,
      apiKey: state.apiKey.trim(),
      baseUrl: state.baseUrl.trim(),
      apiPath: state.apiPath.trim(),
      model: state.model.trim(),
      modelOptions: models.length > 0 ? models : undefined,
      modelOptionsAt: state.modelOptionsAt || undefined,
      systemPrompt: state.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      maxHistory: Math.max(1, parseInt(state.maxHistory, 10) || 50),
      thinkingEnabled: state.thinking !== "off",
      reasoningEffort: state.thinking === "off" ? "" : state.thinking,
      showSteps: state.showSteps,
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
      >
        <Form>
          <Section title="角色">
            <FieldRow label="助手名字">
              <TextField
                title="小助"
                value={state.agentName}
                onChanged={(v) => patch({ agentName: v })}
              />
            </FieldRow>
            <HStack spacing={14} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity" }}>
              <Avatar spec={{ path: state.avatarPath }} size={56} />
              <VStack alignment="leading" spacing={2}>
                <Text>助手头像</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {state.avatarPath ? "使用自定义照片" : "还没有照片"}
                </Text>
              </VStack>
              <Spacer />
            </HStack>
            <Button
              title={state.avatarPath ? "从相册换一张" : "从相册选择照片"}
              systemImage="photo.on.rectangle"
              action={pickAvatar}
            />
          </Section>

          <Section title="模型接口">
            <FieldRow label="API Key">
              <SecureField
                title="sk-xxxxxxxx"
                value={state.apiKey}
                onChanged={(v) => patch({ apiKey: v })}
              />
            </FieldRow>
            <FieldRow label="接口地址">
              <TextField
                title="https://api.deepseek.com"
                value={state.baseUrl}
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => patch({ baseUrl: v })}
              />
            </FieldRow>
            <FieldRow label="请求路径">
              <TextField
                title="/chat/completions"
                value={state.apiPath}
                autocorrectionDisabled
                textInputAutocapitalization="never"
                onChanged={(v) => patch({ apiPath: v })}
              />
            </FieldRow>
          </Section>

          <Section title="模型">
            {models.length > 0 ? (
              <Picker
                title="模型"
                pickerStyle="menu"
                value={modelInList ? state.model : ""}
                onChanged={(v: string) => patch({ model: v })}
              >
                {models.map((m) => (
                  <Text key={m} tag={m}>
                    {m}
                  </Text>
                ))}
              </Picker>
            ) : (
              <Text foregroundStyle="secondaryLabel">还没拉到模型，先点下面的按钮拉一次。</Text>
            )}
            <Button
              title={fetchingModels ? "正在拉取…" : models.length > 0 ? "重新拉取" : "拉取可用模型"}
              systemImage="arrow.down.circle"
              disabled={fetchingModels}
              action={fetchModels}
            />
            {models.length > 0 ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`已拿到 ${models.length} 个模型${state.modelOptionsAt > 0 ? " · " + stamp(state.modelOptionsAt) : ""}`}
              </Text>
            ) : null}
            {models.length > 0 && !modelInList ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`⚠️ 配置里存的「${state.model.trim() || "（空）"}」不在这个列表里（可能换过服务商）：重新选一个再保存。`}
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

          <Section title="智能体设定">
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

          <Section title="对话">
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
              打开后每条回复上方会有一张可展开的过程卡片。
            </Text>
          </Section>

          <Section
            header={<Text>工具</Text>}
            footer={<Text>两个子页改完，记得回这一页点「保存」。</Text>}
          >
            <NavRow
              icon="bolt.fill"
              title="本地快捷指令工具"
              detail={toolDetail}
              destination={
                <ToolsPage
                  rows={state.tools}
                  onChange={(rows) => patch({ tools: rows })}
                />
              }
            />
            <NavRow
              icon="server.rack"
              title="MCP 服务器"
              detail={mcpDetail}
              destination={
                <McpPage
                  servers={state.mcpServers}
                  onChange={(servers) => patch({ mcpServers: servers })}
                />
              }
            />
          </Section>


          <Section title="知识库">
            <Toggle
              title="启用知识库检索"
              value={state.kbEnabled}
              onChanged={(v) => patch({ kbEnabled: v })}
            />
            <NavRow
              icon="books.vertical"
              title="管理知识库"
              detail={
                kbStat.docs > 0
                  ? `已导入 ${kbStat.docs} 份资料 · ${kbStat.chunks} 个片段`
                  : "还没有资料，可以上传文件或指定文件夹"
              }
              destination={<KbPage onChanged={() => setTick(Date.now())} />}
            />
          </Section>

          <Section title="知识库语义检索（可选）">
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

          <Section title="技能">
            <Toggle
              title="启用技能"
              value={state.skillsEnabled}
              onChanged={(v) => patch({ skillsEnabled: v })}
            />
            <NavRow
              icon="shippingbox"
              title="管理技能"
              detail={
                skillStat.total > 0
                  ? `${skillStat.total} 个技能 · 启用 ${skillStat.enabled} 个`
                  : "还没有技能，可以上传 zip 或从 git 仓库导入"
              }
              destination={<SkillsPage onChanged={() => setTick(Date.now())} />}
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default ConfigPage
