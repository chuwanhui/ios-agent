import {
  Button, Form, NavigationStack, Section, SecureField, Text, TextField, Toggle, VStack, useState,
} from "scripting"
import {
  AgentConfig, AgentTool, McpServer, loadConfig, makeMcpServer, saveConfig, validateConfig,
} from "./agent_store"
import { listMcpTools } from "./mcp_client"
import { kbStats } from "./kb_store"
import { skillCounts } from "./skills_store"
import { KbPage } from "./kb_page"
import { SkillsPage } from "./skills_page"

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
  // 模型
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  // 对话
  systemPrompt: string
  maxHistory: string
  speakReply: boolean
  // 工具
  tools: ToolRow[]
  // MCP
  mcpServers: McpServer[]
  // 知识库 / 技能
  kbEnabled: boolean
  skillsEnabled: boolean
}

function toFormState(cfg: AgentConfig): FormState {
  return {
    agentName: cfg.agentName,
    agentEmoji: cfg.agentEmoji,
    greetText: cfg.greetText,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    apiPath: cfg.apiPath,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    maxHistory: String(cfg.maxHistory),
    speakReply: cfg.speakReply,
    tools: (cfg.tools ?? []).map((t) => toRow(t)),
    mcpServers: (cfg.mcpServers ?? []).map((m) => ({ ...m })),
    kbEnabled: cfg.kbEnabled,
    skillsEnabled: cfg.skillsEnabled,
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
  /** 知识库 / 技能管理页的呈现状态。 */
  const [kbOpen, setKbOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)

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

    const cfg: AgentConfig = {
      ...loadConfig(),
      agentName: state.agentName.trim() || "小助",
      agentEmoji: state.agentEmoji.trim() || "✨",
      greetText: state.greetText.trim(),
      apiKey: state.apiKey.trim(),
      baseUrl: state.baseUrl.trim(),
      apiPath: state.apiPath.trim(),
      model: state.model.trim(),
      systemPrompt: state.systemPrompt,
      maxHistory: parseInt(state.maxHistory, 10) || 50,
      speakReply: state.speakReply,
      tools,
      mcpServers,
      kbEnabled: state.kbEnabled,
      skillsEnabled: state.skillsEnabled,
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
          topBarLeading: <Button title="取消" action={onClose} />,
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
                助手名字会显示在聊天页顶部和左侧侧边栏；头像填一个 emoji 就行，例如 ✨ 🐱 🤖 🧠。改完点「保存」生效。
              </Text>
            }
          >
            <TextField
              title="助手名字"
              value={state.agentName}
              prompt="小助"
              onChanged={(v) => patch({ agentName: v })}
            />
            <TextField
              title="助手头像"
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
            header={<Text>模型</Text>}
            footer={<Text>API Key 只保存在本机 App 共享目录，不会上传到别处。</Text>}
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
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ baseUrl: v })}
            />
            <TextField
              title="路径"
              value={state.apiPath}
              autocorrectionDisabled
              onChanged={(v) => patch({ apiPath: v })}
            />
            <TextField
              title="模型"
              value={state.model}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ model: v })}
            />
          </Section>

          <Section header={<Text>对话</Text>}>
            <TextField
              title="系统提示词"
              value={state.systemPrompt}
              axis="vertical"
              lineLimit={{ max: 8, reservesSpace: true }}
              onChanged={(v) => patch({ systemPrompt: v })}
            />
            <TextField
              title="历史条数上限"
              value={state.maxHistory}
              keyboardType="numberPad"
              onChanged={(v) => patch({ maxHistory: v })}
            />
            <Text font="footnote" foregroundStyle="secondaryLabel">
              文本聊天不朗读。想边说边听就走右上角「语音」进入语音通话模式（那边会自动朗读回复）。
            </Text>
          </Section>

          {state.tools.map((t, i) => (
            <Section
              key={t.id}
              header={<Text>{`工具 ${i + 1}${t.name.trim() ? " · " + t.name.trim() : ""}`}</Text>}
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
            header={<Text>工具</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  一个真实快捷指令 = 一个工具。需要参数就在「参数」里一行写一个「字段名=说明」，模型就会按这些字段名生成参数。
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
            <Button title="添加工具" systemImage="plus.circle.fill" action={addTool} />
            {state.tools.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有工具</Text>
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
