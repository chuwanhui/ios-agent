import {
  Button, Form, HStack, Image, NavigationDestination, NavigationStack, Picker, Section, SecureField,
  Spacer, Text, TextField, Toggle, VStack, useEffect, useObservable, useState,
} from "scripting"
import {
  AgentConfig, DEFAULT_SYSTEM_PROMPT, McpServer, ModelProvider, loadConfig, makeMcpServer, saveConfig,
  validateConfig,
} from "./agent_store"
import { kbStats } from "./kb_store"
import { DEFAULT_EMBED_PATH, embedReady, embedSettingsOf, embedTexts, QUERY_TIMEOUT_MS } from "./embed_client"
import { ModelsPage, providerLabel, providerSubtitle, toProviders } from "./models_page"
import { skillCounts } from "./skills_store"
import { KbPage } from "./kb_page"
import { SkillsPage } from "./skills_page"
import { FieldRow, ToolRow, ToolsPage, toAgentTools, toToolRow } from "./tools_page"
import { McpPage } from "./mcp_page"
import { registerConfigSaver } from "./config_save"
import { buildRoute, popRoute, pushRoute, registerNavPath, registerRoute } from "./nav_route"
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

/** 把配置里的 thinkingEnabled + reasoningEffort 反解成档位。 */
function tierOf(cfg: AgentConfig): ThinkingTier {
  if (!cfg.thinkingEnabled) return "off"
  const effort = (cfg.reasoningEffort || "").toLowerCase()
  return effort === "low" || effort === "medium" ? effort : "high"
}

export interface FormState {
  // 角色
  agentName: string
  /** 头像图片路径；空 = 显示占位图。选择照片时先指向暂存文件，保存时才转正。 */
  avatarPath: string
  // 模型供应商：每家一套地址 / Key / 模型，聊天用 activeProviderId 那一家
  providers: ModelProvider[]
  activeProviderId: string
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
  // 能力（助手自己动手的权限，默认全关）
  fsEnabled: boolean
  cliEnabled: boolean
  skillScriptEnabled: boolean
  skillCreateEnabled: boolean
  toolCreateEnabled: boolean
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
    providers: (cfg.providers ?? []).map((p) => ({ ...p, modelOptions: (p.modelOptions ?? []).slice() })),
    activeProviderId: cfg.activeProviderId ?? "",
    systemPrompt: cfg.systemPrompt,
    maxHistory: String(cfg.maxHistory),
    thinking: tierOf(cfg),
    showSteps: cfg.showSteps !== false,
    tools: (cfg.tools ?? []).map((t) => toToolRow(t)),
    mcpServers: (cfg.mcpServers ?? []).map((m) => ({ ...m })),
    kbEnabled: cfg.kbEnabled,
    skillsEnabled: cfg.skillsEnabled,
    fsEnabled: cfg.fsEnabled === true,
    cliEnabled: cfg.cliEnabled === true,
    skillScriptEnabled: cfg.skillScriptEnabled === true,
    skillCreateEnabled: cfg.skillCreateEnabled === true,
    toolCreateEnabled: cfg.toolCreateEnabled === true,
    embedEnabled: cfg.embedEnabled === true,
    embedBaseUrl: cfg.embedBaseUrl ?? "",
    embedPath: cfg.embedPath ?? DEFAULT_EMBED_PATH,
    embedApiKey: cfg.embedApiKey ?? "",
    embedModel: cfg.embedModel ?? "",
  }
}

/**
 * 设置页里的入口行：图标 + 标题 + 副标题，点一下进子页（右侧箭头自己画）。
 *
 * 这里不用 NavigationLink 了：脚本没有编程式「返回上一级」的 API，只能让整个导航栈走
 * path 导航（见 nav_route.ts），而 path 只能由「点一下 → 往末尾加一条 id」来推进。
 */
export function NavRow(props: { icon: string; title: string; detail: string; route: string }) {
  return (
    <HStack
      spacing={12}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      contentShape="rect"
      onTapGesture={() => pushRoute(props.route)}
    >
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
      <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

/** path 里出现了一个没人登记的 id（正常不会发生）：给个能退回上一级的提示。 */
function RouteMissing({ route }: { route: string }) {
  return (
    <VStack spacing={12} navigationTitle="打不开这一页">
      <Text foregroundStyle="secondaryLabel">{`没有登记的路由「${route}」。`}</Text>
      <Button title="返回上一级" action={() => popRoute()} />
    </VStack>
  )
}

interface Props {
  /** 关闭设置页（保存 / 取消都走这里，由聊天页控制 sheet 状态）。 */
  onClose?: () => void
}

/** 设置页：角色 / 模型 / 对话 / 工具。以 sheet 形式从聊天页打开。 */
/**
 * 「能力」开关组：助手自己动手的权限（默认全关，打开哪项才能做哪件事）。
 * 单独抽出来是为了能单独预览 / 复用。
 */
export function AbilitySection({
  state, patch,
}: {
  state: FormState
  patch: (p: Partial<FormState>) => void
}) {
  return (
    <>
      <Toggle
        title="读写文件"
        value={state.fsEnabled}
        onChanged={(v) => patch({ fsEnabled: v })}
      />
      <Toggle
        title="执行命令行"
        value={state.cliEnabled}
        onChanged={(v) => patch({ cliEnabled: v })}
      />
      <Toggle
        title="运行技能脚本"
        value={state.skillScriptEnabled}
        onChanged={(v) => patch({ skillScriptEnabled: v })}
      />
      <Toggle
        title="创建技能"
        value={state.skillCreateEnabled}
        onChanged={(v) => patch({ skillCreateEnabled: v })}
      />
      <Toggle
        title="配置快捷指令工具"
        value={state.toolCreateEnabled}
        onChanged={(v) => patch({ toolCreateEnabled: v })}
      />
    </>
  )
}

export function ConfigPage({ onClose = () => {} }: Props) {
  const [state, setState] = useState<FormState>(() => toFormState(loadConfig()))
  /** 知识库 / 技能子页改完数据回来后，用它强制本页重算统计数字。 */
  const [, setTick] = useState(0)
  /** 向量服务测试状态 / 结果行。 */
  const [embedBusy, setEmbedBusy] = useState(false)
  const [embedMsg, setEmbedMsg] = useState("")
  const patch = (p: Partial<FormState>) => setState((s) => ({ ...s, ...p }))

  /** 当前使用的那家供应商（列表空 / 指针失效时退回到第一家）。 */
  const activeRow =
    state.providers.find((p) => p.id === state.activeProviderId) ??
    state.providers.find((p) => (p.baseUrl ?? "").trim()) ??
    state.providers[0]

  /**
   * 自动拉取（模型 + 余额）挪到了「供应商与模型」子页：那一页打开时会给
   * 「当前使用」那家静默拉一次，失败只留一行提示、不弹窗。
   */

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

  // —— 导航 ——

  /**
   * 设置页里的所有跳转都走这一个 path：进下一层 = 末尾加一条 id，返回上一级 = 去掉末尾那条
   * （脚本没有别的编程式返回手段，原因见 nav_route.ts）。
   *
   * path 里的 id 由两处登记：本页登记 5 个一级入口，各子页登记自己下一层的详情页。
   * navigationDestination 的处理器只在导航栈根视图生效（真机验证过），所以只能集中在这里查表。
   */
  const navPath = useObservable<string[]>([])
  registerNavPath(navPath)
  useEffect(() => () => registerNavPath(null), [])

  // 一级入口的路由工厂：写在渲染里，保证闭包拿到的是本页最新的 state。
  registerRoute("models", () => (
    <ModelsPage
      rows={state.providers}
      activeId={state.activeProviderId}
      onChange={(rows) => patch({ providers: rows })}
      onActiveChange={(id) => patch({ activeProviderId: id })}
    />
  ))
  registerRoute("tools", () => (
    <ToolsPage rows={state.tools} onChange={(rows) => patch({ tools: rows })} />
  ))
  registerRoute("mcp", () => (
    <McpPage servers={state.mcpServers} onChange={(servers) => patch({ mcpServers: servers })} />
  ))
  registerRoute("kb", () => <KbPage onChanged={() => setTick(Date.now())} />)
  registerRoute("skills", () => <SkillsPage onChanged={() => setTick(Date.now())} />)

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

  /**
   * 写盘：校验 → saveConfig。返回是否真的写成功（校验没过会弹窗并返回 false）。
   * 设置页自己的「保存」和子页右上角的「保存」都走这里，判等逻辑只有一份。
   */
  function persist(): boolean {
    // 供应商草稿 → 存盘的供应商（全空的丢掉）；聊天只用「当前使用」那家
    const providers = toProviders(state.providers)
    if (providers.length === 0) {
      Dialog.alert({
        title: "还没有模型供应商",
        message:
          "进「供应商与模型」加一家：填个名字、接口地址和 API Key，拉一次模型再从列表里选一个。",
      })
      return false
    }
    const activeId = providers.some((p) => p.id === state.activeProviderId)
      ? state.activeProviderId
      : providers[0].id
    const active =
      providers.find((p) => p.id === activeId) ?? providers.find((p) => p.baseUrl) ?? providers[0]
    const label = providerLabel(active)
    if (!active.baseUrl) {
      Dialog.alert({ message: `「${label}」还没填接口地址，进去补上。` })
      return false
    }
    if (!active.apiKey) {
      Dialog.alert({ message: `「${label}」还没填 API Key，进去补上。` })
      return false
    }
    // 模型只能从拉回来的列表里选：没拉过 / 存的模型已不在列表，都不让保存
    const opts = active.modelOptions ?? []
    if (opts.length === 0) {
      Dialog.alert({
        title: "还没拉取模型",
        message: `「${label}」还没拉过模型列表：进「供应商与模型」→ 点这一家 → 点「拉取可用模型」（脚本会请求一次 /models，把服务端真正支持的模型列出来），再从列表里选一个。`,
      })
      return false
    }
    if (opts.indexOf(active.model) < 0) {
      Dialog.alert({
        title: "模型要重新选",
        message: `「${label}」存的模型「${active.model || "（空）"}」不在拉回来的列表里（可能换过服务商或接口变了）。重新拉一次，再从列表里选一个。`,
      })
      return false
    }
    // 工具：草稿行 → AgentTool（顺带补回以前会被丢掉的「参数」）
    const built = toAgentTools(state.tools)
    if (built.error) {
      Dialog.alert({ message: built.error })
      return false
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
      providers,
      activeProviderId: activeId,
      systemPrompt: state.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      maxHistory: Math.max(1, parseInt(state.maxHistory, 10) || 50),
      thinkingEnabled: state.thinking !== "off",
      reasoningEffort: state.thinking === "off" ? "" : state.thinking,
      showSteps: state.showSteps,
      tools,
      mcpServers,
      kbEnabled: state.kbEnabled,
      skillsEnabled: state.skillsEnabled,
      fsEnabled: state.fsEnabled,
      cliEnabled: state.cliEnabled,
      skillScriptEnabled: state.skillScriptEnabled,
      skillCreateEnabled: state.skillCreateEnabled,
      toolCreateEnabled: state.toolCreateEnabled,
      embedEnabled: state.embedEnabled,
      embedBaseUrl: state.embedBaseUrl.trim(),
      embedPath: state.embedPath.trim() || DEFAULT_EMBED_PATH,
      embedApiKey: state.embedApiKey.trim(),
      embedModel: state.embedModel.trim(),
    }

    const err = validateConfig(cfg)
    if (err) {
      Dialog.alert({ message: err })
      return false
    }
    saveConfig(cfg)
    return true
  }

  /** 设置页右上角那个「保存」：存完顺手关掉设置页。 */
  function save() {
    if (persist()) onClose()
  }

  // 子页右上角的「保存」按钮也走这份逻辑（见 config_save.tsx）。写在渲染里，
  // 保证登记进总线的永远是最新那份 state；本页卸载时清掉。
  registerConfigSaver(persist)
  useEffect(() => () => registerConfigSaver(null), [])

  return (
    <NavigationStack path={navPath}>
      <VStack
        navigationTitle="设置"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarLeading: <Button title="取消" action={cancel} />,
          topBarTrailing: <Button title="保存" action={save} fontWeight="semibold" />,
        }}
        navigationDestination={
          <NavigationDestination>
            {(page) => buildRoute(page) ?? <RouteMissing route={page} />}
          </NavigationDestination>
        }
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

          <Section
            header={<Text>模型</Text>}
            footer={
              <Text>
                支持多家供应商：每家一套接口地址、API Key 和模型，聊天用「当前使用」那一家。进子页会自动给当前那家拉一次模型和余额。
              </Text>
            }
          >
            <NavRow
              icon="cpu"
              title="供应商与模型"
              detail={
                activeRow
                  ? `${providerLabel(activeRow)} · ${providerSubtitle(activeRow)}`
                  : "还没有，进去加一家"
              }
              route="models"
            />
            {state.providers.length > 0 ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {`一共 ${state.providers.length} 家${activeRow ? "，正在用 " + providerLabel(activeRow) : ""}`}
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
            footer={<Text>两个子页右上角都有「保存」，在那里存完会自动退回这一层。</Text>}
          >
            <NavRow
              icon="bolt.fill"
              title="本地快捷指令工具"
              detail={toolDetail}
              route="tools"
            />
            <NavRow
              icon="server.rack"
              title="MCP 服务器"
              detail={mcpDetail}
              route="mcp"
            />
          </Section>

          <Section
            header={<Text>能力</Text>}
            footer={
              <Text>
                助手自己动手的权限，默认全关；打开哪一项，它才能做哪件事，随时可以关掉。
                文件类能力只在本 App 自己的目录里活动（工作区：文件 App → Scripting → 工作区）。
              </Text>
            }
          >
            <AbilitySection state={state} patch={patch} />
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
              route="kb"
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
              route="skills"
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default ConfigPage
