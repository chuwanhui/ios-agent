import {
  Button, Form, Section, SecureField, Text, TextField, Toggle, VStack, useState,
} from "scripting"
import { McpServer, makeMcpServer, mcpServersToJson, parseMcpServersJson } from "./agent_store"
import { listMcpTools } from "./mcp_client"

interface Props {
  /** 设置页里当前的服务器草稿。 */
  servers: McpServer[]
  /** 每次改动都推回设置页（设置页的 state 才是保存时的唯一来源）。 */
  onChange: (servers: McpServer[]) => void
}

/**
 * 「MCP 服务器」子页：粘贴 JSON 导入、逐台编辑、测试连接。
 * 由设置页用 NavigationLink 推进来，所以这里**不用**再套 NavigationStack。
 */
export function McpPage({ servers, onChange }: Props) {
  const [draft, setDraft] = useState<McpServer[]>(servers.map((s) => ({ ...s })))
  const [testing, setTesting] = useState("")
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
    if (fresh.length > 0) lines.push("回设置页点「保存」才会生效。")
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

  const enabledCount = draft.filter((m) => m.enabled && (m.url ?? "").trim()).length

  return (
    <VStack navigationTitle="MCP 服务器" navigationBarTitleDisplayMode="inline">
      <Form>
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

        {draft.map((m, i) => (
          <Section
            key={m.id}
            header={<Text>{`MCP 服务器 ${i + 1}${m.name.trim() ? " · " + m.name.trim() : ""}`}</Text>}
          >
            <TextField
              title="名称"
              value={m.name}
              prompt="如 deepwiki"
              onChanged={(v) => update(m.id, { name: v })}
            />
            <TextField
              title="地址"
              value={m.url}
              prompt="https://example.com/mcp"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => update(m.id, { url: v })}
            />
            <SecureField
              title="令牌"
              value={m.token ?? ""}
              prompt="可选，Bearer Token"
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => update(m.id, { token: v })}
            />
            <TextField
              title="额外请求头"
              value={m.headersHint ?? ""}
              prompt={"可选，每行一个\nHeader: Value"}
              axis="vertical"
              lineLimit={{ min: 1, max: 4 }}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => update(m.id, { headersHint: v })}
            />
            <Toggle
              title="启用"
              value={m.enabled}
              onChanged={(v) => update(m.id, { enabled: v })}
            />
            <Button
              title={testing === m.id ? "正在测试…" : "测试连接"}
              disabled={testing !== ""}
              action={() => testServer(m)}
            />
            <Button title="删除这个服务器" role="destructive" action={() => removeServer(m.id)} />
          </Section>
        ))}

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
                不想每次都去连，可以先把「启用」关掉；工具清单会缓存 5 分钟，改完配置点「测试连接」会强制重新拉一次。
              </Text>
              <Text>改完回设置页点「保存」才会生效。</Text>
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
      </Form>
    </VStack>
  )
}

export default McpPage
