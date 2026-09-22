import {
  Button, Form, HStack, NavigationLink, Section, SecureField, Text, TextField, Toggle, VStack, useState,
} from "scripting"
import { McpServer, makeMcpServer, mcpServersToJson, parseMcpServersJson } from "./agent_store"
import { listMcpTools } from "./mcp_client"
import { saveToolbar } from "./config_save"

/** 从地址里抠出主机名，列表里当一行摘要用。 */
function hostOf(url: string): string {
  const t = (url ?? "").trim()
  if (!t) return "还没填地址"
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(t)
  return m ? m[1] : t
}

/** 列表行的标题：优先用名字，没填就退回主机名。 */
function serverTitle(m: McpServer): string {
  const name = (m.name ?? "").trim()
  if (name) return name
  const url = (m.url ?? "").trim()
  return url ? hostOf(url) : "（未命名）"
}

/** 列表行的一行摘要：地址 + 状态。 */
function serverSubtitle(m: McpServer): string {
  const url = (m.url ?? "").trim()
  if (!url) return "还没填地址"
  const bits: string[] = [hostOf(url), m.enabled ? "已启用" : "已停用"]
  if ((m.token ?? "").trim()) bits.push("带令牌")
  return bits.join(" · ")
}

/** 搜索匹配：名称 / 地址，大小写不敏感。 */
function matchesServer(m: McpServer, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  return [m.name, m.url].some((s) => ((s ?? "") as string).toLowerCase().indexOf(needle) >= 0)
}

interface Props {
  /** 设置页里当前的服务器草稿。 */
  servers: McpServer[]
  /** 每次改动都推回设置页（设置页的 state 才是保存时的唯一来源）。 */
  onChange: (servers: McpServer[]) => void
}

/**
 * 「MCP 服务器」子页：上面搜索框，中间服务器列表，点一台进详情页配。
 * 由设置页用 NavigationLink 推进来，所以这里**不用**再套 NavigationStack。
 */
export function McpPage({ servers, onChange }: Props) {
  const [draft, setDraft] = useState<McpServer[]>(servers.map((s) => ({ ...s })))
  const [query, setQuery] = useState("")
  const [json, setJson] = useState("")
  const [note, setNote] = useState("")

  function push(next: McpServer[]) {
    setDraft(next)
    onChange(next)
  }

  function update(id: string, p: Partial<McpServer>) {
    push(draft.map((m) => (m.id === id ? { ...m, ...p } : m)))
  }

  function addServer() {
    push([...draft, makeMcpServer()])
  }

  function removeServer(id: string) {
    push(draft.filter((m) => m.id !== id))
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
      res = parseMcpServersJson(json)
    } catch (e: any) {
      setNote(String(e?.message ?? e))
      return
    }
    const exists = new Set(draft.map((s) => (s.url ?? "").trim()))
    const fresh = res.servers.filter((s) => !exists.has(s.url.trim()))
    const dup = res.servers.length - fresh.length
    if (fresh.length > 0) push([...draft, ...fresh])

    const lines: string[] = []
    lines.push(fresh.length > 0 ? `✅ 导入 ${fresh.length} 台服务器` : "没有可导入的服务器")
    if (dup > 0) lines.push(`跳过 ${dup} 台（地址已经在了）`)
    if (res.skipped.length > 0) {
      lines.push("未导入：\n" + res.skipped.map((s) => "· " + s).join("\n"))
    }
    if (fresh.length > 0) lines.push("点右上角「保存」就会生效（也可以回设置页保存）。")
    setNote(lines.join("\n\n"))
  }

  async function copyJson() {
    try {
      await Pasteboard.setString(mcpServersToJson(draft))
      setNote("已复制当前配置的 JSON（含令牌），可以直接粘贴到别的客户端。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  const indexed = draft.map((m, i) => ({ m, i }))
  const shown = indexed.filter((x) => matchesServer(x.m, query))
  const enabledCount = draft.filter((m) => m.enabled && (m.url ?? "").trim()).length

  return (
    <VStack
      navigationTitle="MCP 服务器"
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "搜名称 / 地址",
      }}
    >
      <Form>
        <Section
          header={<Text>{draft.length > 0 ? `服务器 ${draft.length} 台` : "MCP 服务器"}</Text>}
          footer={<Text>点一台进去才是它的详细配置。改完点右上角「保存」就会生效。</Text>}
        >
          {draft.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有 MCP 服务器，用下面的「添加服务器」加一台。</Text>
          ) : shown.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">{`没有名字或地址里带「${query.trim()}」的服务器。`}</Text>
          ) : (
            shown.map(({ m, i }) => (
              <NavigationLink
                key={m.id}
                destination={
                  <McpDetail
                    index={i}
                    initial={m}
                    onChange={(p) => update(m.id, p)}
                    onDelete={() => removeServer(m.id)}
                  />
                }
              >
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <HStack spacing={6}>
                    <Text fontWeight="semibold" foregroundStyle="label">
                      {serverTitle(m)}
                    </Text>
                    {m.enabled ? null : (
                      <Text font="caption2" foregroundStyle="secondaryLabel">
                        {"已停用"}
                      </Text>
                    )}
                  </HStack>
                  <Text font="footnote" foregroundStyle="secondaryLabel">
                    {serverSubtitle(m)}
                  </Text>
                </VStack>
              </NavigationLink>
            ))
          )}
        </Section>

        <Section
          header={<Text>添加 / 说明</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                MCP（模型上下文协议）服务器能提供一批带真返回值的工具，比快捷指令更完整：模型能拿到结果再回答你。
              </Text>
              <Text>
                只支持远程 HTTP 类型（地址形如 https://example.com/mcp）。需要本地跑命令的 stdio 型服务器连不了：iOS 沙箱里没有常驻子进程管道。
              </Text>
              <Text>
                不想每次都去连，可以在详情页先把「启用」关掉；工具清单会缓存 5 分钟，改完配置点「测试连接」会强制重新拉一次。
              </Text>
              <Text>改完点右上角「保存」就会生效（也可以回设置页保存）。</Text>
            </VStack>
          }
        >
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {draft.length > 0
              ? `${draft.length} 台服务器，启用 ${enabledCount} 台`
              : "还没有 MCP 服务器"}
          </Text>
          <Button title="添加服务器" systemImage="plus.circle.fill" action={addServer} />
        </Section>

        <Section
          header={<Text>从 JSON 导入</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                把别处（Claude Desktop、Cherry Studio、Cursor、VS Code…）的 MCP 配置整段粘进来就行，这些写法都认：
                {"\n"}
                {"· {\"mcpServers\":{\"名字\":{\"url\":\"…\"}}}"}
                {"\n"}
                {"· 带 \"headers\":{\"Authorization\":\"Bearer …\"}（会自动填进「令牌」）"}
                {"\n"}
                {"· VS Code 的 {\"mcp\":{\"servers\":{…}}}"}
              </Text>
              <Text>
                `command` / `args` 的本地（stdio）型服务器在 iOS 上跑不了（没有子进程管道），会被单独列出来跳过，不会静默丢掉。
              </Text>
            </VStack>
          }
        >
          <TextField
            title="配置 JSON"
            value={json}
            prompt={'{"mcpServers":{"deepwiki":{"url":"https://mcp.deepwiki.com/mcp"}}}'}
            axis="vertical"
            lineLimit={{ min: 3, max: 10 }}
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setJson}
          />
          <Button title="从剪贴板粘贴" systemImage="doc.on.clipboard" action={pasteFromClipboard} />
          <Button title="导入" systemImage="square.and.arrow.down" disabled={!json.trim()} action={importJson} />
          <Button title="导出当前配置（复制）" systemImage="doc.on.doc" action={copyJson} />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>
      </Form>
    </VStack>
  )
}

interface DetailProps {
  index: number
  initial: McpServer
  /** 改动推回列表页（列表页再推给设置页）。 */
  onChange: (p: Partial<McpServer>) => void
  onDelete: () => void
}

/** 一台服务器的详情页：名称 / 地址 / 令牌 / 请求头 / 启用 / 测试连接。 */
export function McpDetail({ index, initial, onChange, onDelete }: DetailProps) {
  const [m, setM] = useState<McpServer>({ ...initial })
  const [testing, setTesting] = useState(false)

  function patch(p: Partial<McpServer>) {
    setM({ ...m, ...p })
    onChange(p)
  }

  /** 测试连接：真发一次 initialize + tools/list，把工具名列出来。 */
  async function testServer() {
    const url = (m.url ?? "").trim()
    if (!url) {
      Dialog.alert({ message: "先填服务器地址，比如 https://example.com/mcp" })
      return
    }
    setTesting(true)
    try {
      const list = await listMcpTools(
        { ...m, url, name: (m.name ?? "").trim() || m.id, enabled: true },
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
      setTesting(false)
    }
  }

  return (
    <VStack
      navigationTitle={serverTitle(m)}
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
    >
      <Form>
        <Section header={<Text>{`MCP 服务器 ${index + 1}`}</Text>} footer={<Text>名称只是给你自己看的，模型看到的是服务器提供的工具清单。</Text>}>
          <TextField
            title="名称"
            value={m.name}
            prompt="如 deepwiki"
            onChanged={(v) => patch({ name: v })}
          />
          <TextField
            title="地址"
            value={m.url}
            prompt="https://example.com/mcp"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={(v) => patch({ url: v })}
          />
          <SecureField
            title="令牌"
            value={m.token ?? ""}
            prompt="可选，Bearer Token"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={(v) => patch({ token: v })}
          />
          <TextField
            title="额外请求头"
            value={m.headersHint ?? ""}
            prompt={"可选，每行一个\nHeader: Value"}
            axis="vertical"
            lineLimit={{ min: 1, max: 4 }}
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={(v) => patch({ headersHint: v })}
          />
        </Section>

        <Section
          header={<Text>连接</Text>}
          footer={
            <Text>
              工具清单会缓存 5 分钟；「测试连接」会强制重新拉一次。改完点右上角「保存」就会生效。
            </Text>
          }
        >
          <Toggle title="启用" value={m.enabled} onChanged={(v) => patch({ enabled: v })} />
          <Button
            title={testing ? "正在测试…" : "测试连接"}
            disabled={testing}
            action={testServer}
          />
          <Button title="删除这个服务器" role="destructive" action={onDelete} />
        </Section>
      </Form>
    </VStack>
  )
}

export default McpPage
