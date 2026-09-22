import {
  Button,
  fetch,
  Form,
  HStack,
  Image,
  Picker,
  Section,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting"
import { ModelProvider, makeProvider, suggestProviderName } from "./agent_store"
import { queryBalance } from "./balance_client"
import { FieldRow } from "./tools_page"
import { saveToolbar } from "./config_save"
import { pushRoute, registerRoute } from "./nav_route"

// ———————————————————————— 小工具 ————————————————————————

/** 时间戳 → 「09-22 23:07」。 */
function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => (n < 10 ? "0" + n : String(n))
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 把可能多行的正文压成一行（状态行放不下换行）。 */
function oneLine(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim()
}

/** 接口地址里取出主机名（列表摘要用）。 */
export function hostOf(baseUrl: string): string {
  return (baseUrl ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
}

/** 列表 / 标题上显示的名字：没起名字就拿地址猜一个。 */
export function providerLabel(p: ModelProvider): string {
  return (p.name ?? "").trim() || suggestProviderName(p.baseUrl) || "（还没填地址）"
}

/** 列表行的一行摘要：模型 · 主机 · 余额。 */
export function providerSubtitle(p: ModelProvider): string {
  const bits: string[] = []
  const model = (p.model ?? "").trim()
  if (model) bits.push(model)
  else if ((p.modelOptions ?? []).length > 0) bits.push("还没选模型")
  else bits.push("还没拉取模型")
  const host = hostOf(p.baseUrl)
  if (host) bits.push(host)
  const bal = (p.balanceText ?? "").trim()
  if (bal) bits.push(bal)
  return bits.join(" · ")
}

/** 草稿行 → 存盘用的供应商：全空的丢掉，字段统一 trim。 */
export function toProviders(rows: ModelProvider[]): ModelProvider[] {
  const out: ModelProvider[] = []
  for (const r of rows) {
    const baseUrl = (r.baseUrl ?? "").trim()
    const apiKey = (r.apiKey ?? "").trim()
    const name = (r.name ?? "").trim()
    if (!baseUrl && !apiKey && !name) continue
    const opts = (r.modelOptions ?? []).filter((m) => !!m)
    out.push({
      id: r.id || makeProvider().id,
      name: name || suggestProviderName(baseUrl),
      baseUrl,
      apiPath: (r.apiPath ?? "").trim() || "/chat/completions",
      apiKey,
      model: (r.model ?? "").trim(),
      modelOptions: opts.length > 0 ? opts : undefined,
      modelOptionsAt: r.modelOptionsAt && r.modelOptionsAt > 0 ? r.modelOptionsAt : undefined,
      balanceText: (r.balanceText ?? "").trim() || undefined,
      balanceDetail: (r.balanceDetail ?? "").trim() || undefined,
      balanceSource: (r.balanceSource ?? "").trim() || undefined,
      balanceAt: r.balanceAt && r.balanceAt > 0 ? r.balanceAt : undefined,
    })
  }
  return out
}

/** 配置里的供应商 → 可编辑的草稿行（数组 / 模型列表都拷一份，免得改到配置上去）。 */
export function toProviderRows(list: ModelProvider[] | undefined): ModelProvider[] {
  return (list ?? []).map((p) => ({ ...p, modelOptions: (p.modelOptions ?? []).slice() }))
}

/**
 * 「打开就自动拉一次」的防重护栏：一个供应商在一次运行里只自动拉一遍。
 * （列表每改一次都会重渲，被推进去的子页可能跟着重新挂载，不挡一下会反复打接口。）
 */
const autoPulled = new Set<string>()
function claimAutoPull(key: string): boolean {
  if (autoPulled.has(key)) return false
  autoPulled.add(key)
  return true
}

/**
 * 拉一次 `<接口地址>/models`（OpenAI 兼容：GET + Bearer）。
 * 失败不抛，返回一行文案；弹不弹窗由调用方决定。
 */
export async function fetchModelList(
  baseUrl: string,
  apiKey: string,
): Promise<{ list: string[]; error: string }> {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!base) return { list: [], error: "先填接口地址，比如 https://api.deepseek.com" }
  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    const key = (apiKey ?? "").trim()
    if (key) headers.Authorization = "Bearer " + key
    const resp = await fetch(base + "/models", { headers })
    if (!resp.ok) {
      const text = await resp.text()
      return {
        list: [],
        error: `拉取失败（${resp.status}）：${oneLine(text).slice(0, 200) || "服务端没返回可用模型列表"}`,
      }
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
      if (typeof id === "string" && id.trim() && list.indexOf(id.trim()) < 0) list.push(id.trim())
    }
    list.sort()
    if (list.length === 0) {
      return {
        list: [],
        error: "接口返回里没有模型列表。这条路要求接口是 OpenAI 兼容的（支持 GET /models + Bearer Key）。",
      }
    }
    return { list, error: "" }
  } catch (e: any) {
    return { list: [], error: "拉取失败：" + oneLine(String(e?.message ?? e)) }
  }
}

/** 搜索匹配：名字 / 地址 / 选中的模型 / 拉回来的模型名，大小写不敏感。 */
function matchesProvider(p: ModelProvider, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  const hay = [p.name, p.baseUrl, p.model].concat(p.modelOptions ?? [])
  return hay.some((s) => ((s ?? "") as string).toLowerCase().indexOf(needle) >= 0)
}

/** 列表行的「名字 + 摘要」，点进去才是详情；当前在用的那家带个 ✓。 */
function ProviderListRow(props: { row: ModelProvider; active: boolean; route: string }) {
  return (
    <HStack
      spacing={8}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      contentShape="rect"
      onTapGesture={() => pushRoute(props.route)}
    >
      <VStack
        alignment="leading"
        spacing={3}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        <Text fontWeight="semibold" foregroundStyle="label">
          {providerLabel(props.row)}
        </Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">
          {providerSubtitle(props.row)}
        </Text>
      </VStack>
      {props.active ? <Image systemName="checkmark" foregroundStyle="secondaryLabel" /> : null}
      <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

// ———————————————————————— 列表页 ————————————————————————

interface Props {
  /** 设置页里当前的草稿行。 */
  rows: ModelProvider[]
  /** 当前聊天在用的供应商 id。 */
  activeId: string
  /** 每次改动都推回设置页（设置页的 state 才是保存时的唯一来源）。 */
  onChange: (rows: ModelProvider[]) => void
  /** 换了「当前使用」的那家。 */
  onActiveChange: (id: string) => void
}

/**
 * 「模型供应商」子页：上面搜索框，中间供应商列表，点一条进详情页配。
 * 由设置页用 path 路由推进来（见 nav_route.ts），所以这里**不用**再套 NavigationStack。
 */
export function ModelsPage({ rows, activeId, onChange, onActiveChange }: Props) {
  const [draft, setDraft] = useState<ModelProvider[]>(() => toProviderRows(rows))
  /** 搜索关键词。 */
  const [query, setQuery] = useState("")
  /** 打开这一页时自动拉取的状态行。 */
  const [note, setNote] = useState("")

  function push(next: ModelProvider[]) {
    setDraft(next)
    onChange(next)
  }

  function update(i: number, p: Partial<ModelProvider>) {
    push(draft.map((r, idx) => (idx === i ? { ...r, ...p } : r)))
  }

  function add() {
    push([...draft, makeProvider()])
  }

  function remove(i: number) {
    push(draft.filter((_, idx) => idx !== i))
  }

  // 打开这一页 → 给「当前使用」那家静默拉一次模型 + 余额（失败只在下面写一行，不弹窗）
  useEffect(() => {
    const i = draft.findIndex((r) => r.id === activeId)
    const r = draft[i >= 0 ? i : 0]
    if (!r) return
    if (!(r.baseUrl ?? "").trim() || !(r.apiKey ?? "").trim()) return
    if (!claimAutoPull("provider:" + r.id)) return
    setNote("正在自动拉取当前供应商的模型和余额…")
    void (async () => {
      const got = await fetchModelList(r.baseUrl, r.apiKey)
      if (got.error) {
        setNote("⚠️ " + got.error)
        return
      }
      const cur = (r.model ?? "").trim()
      const patches: Partial<ModelProvider> = {
        modelOptions: got.list,
        modelOptionsAt: Date.now(),
        model: got.list.indexOf(cur) < 0 ? got.list[0] : cur,
      }
      const bal = await queryBalance(r.baseUrl, r.apiKey).catch(() => undefined)
      if (bal && bal.ok) {
        patches.balanceText = bal.text
        patches.balanceDetail = bal.detail
        patches.balanceSource = bal.source
        patches.balanceAt = Date.now()
      }
      push(draft.map((x, idx) => (idx === i ? { ...x, ...patches } : x)))
      setNote("")
    })()
  }, [])

  // 详情页的路由：path 里出现 "provider:<id>" 就造这一家的详情页。写在渲染里，
  // 保证 update / remove 用的下标和当前草稿一致。
  registerRoute("provider:", (id) => {
    const i = draft.findIndex((r) => r.id === id)
    const r = draft[i]
    if (!r) return null
    return (
      <ProviderDetail
        index={i}
        initial={r}
        active={r.id === activeId}
        onActivate={() => onActiveChange(r.id)}
        onChange={(q) => update(i, q)}
        onDelete={() => remove(i)}
      />
    )
  })

  const indexed = draft.map((p, i) => ({ p, i }))
  const shown = indexed.filter((x) => matchesProvider(x.p, query))

  return (
    <VStack
      navigationTitle="模型供应商"
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "搜名字 / 地址 / 模型",
      }}
    >
      <Form>
        <Section
          header={<Text>{draft.length > 0 ? `供应商 ${draft.length} 家` : "模型供应商"}</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                每家一套自己的接口地址、API Key 和模型，互不影响；带 ✓ 的是聊天正在用的那家（进详情页可以换）。
              </Text>
              <Text>改完点右上角「保存」就写进配置，并退回设置页（回设置页保存也一样）。</Text>
              {note ? <Text>{note}</Text> : null}
            </VStack>
          }
        >
          {draft.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">
              还没有供应商。点下面的「＋ 添加供应商」加一家：填个名字、接口地址和 API Key，拉一次模型再选一个。
            </Text>
          ) : shown.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">{`没有名字里带「${query.trim()}」的供应商。`}</Text>
          ) : (
            shown.map(({ p }) => (
              <ProviderListRow
                key={p.id}
                row={p}
                active={p.id === activeId}
                route={"provider:" + p.id}
              />
            ))
          )}
        </Section>

        <Section
          header={<Text>添加</Text>}
          footer={<Text>同一家供应商配多个 Key、或者同一个 Key 换不同的中转地址，都当成两家分开加。</Text>}
        >
          <Button title="＋ 添加供应商" systemImage="plus.circle" action={add} />
        </Section>
      </Form>
    </VStack>
  )
}

// ———————————————————————— 详情页 ————————————————————————

interface DetailProps {
  index: number
  initial: ModelProvider
  /** 这是聊天正在用的那家吗。 */
  active: boolean
  onActivate: () => void
  onChange: (p: Partial<ModelProvider>) => void
  onDelete: () => void
}

/**
 * 一家供应商的详情页：地址 / Key / 请求路径 / 拉模型 / 余额 / 设为当前使用 / 删除。
 * 现在由「供应商列表」页用 path 路由推进来（见 nav_route.ts），所以不用再套 NavigationStack。
 */
export function ProviderDetail({ index, initial, active, onActivate, onChange, onDelete }: DetailProps) {
  const [p, setP] = useState<ModelProvider>(() => ({
    ...initial,
    modelOptions: (initial.modelOptions ?? []).slice(),
  }))
  const [fetching, setFetching] = useState(false)
  const [balanceBusy, setBalanceBusy] = useState(false)
  /** 即时反馈。 */
  const [modelMsg, setModelMsg] = useState("")
  const [balanceMsg, setBalanceMsg] = useState("")

  function patch(q: Partial<ModelProvider>) {
    setP((s) => ({ ...s, ...q }))
    onChange(q)
  }

  const models = p.modelOptions ?? []
  const inList = models.indexOf((p.model ?? "").trim()) >= 0

  // 进这一家的详情就自动拉一次（同一个供应商在一次运行里只自动拉一遍，重进不重复打接口）
  useEffect(() => {
    if (!(p.baseUrl ?? "").trim() || !(p.apiKey ?? "").trim()) return
    if (!claimAutoPull("provider:" + p.id)) return
    void pull(true)
    void checkBalance(true)
  }, [])

  /** 拉模型列表：auto = 进页面自动拉（失败不弹窗）。 */
  async function pull(auto: boolean) {
    const base = (p.baseUrl ?? "").trim()
    if (!base) {
      if (!auto) Dialog.alert({ message: "先填接口地址，比如 https://api.deepseek.com" })
      return
    }
    setFetching(true)
    if (auto) setModelMsg("正在自动拉取模型…")
    const got = await fetchModelList(base, p.apiKey)
    setFetching(false)
    if (got.error) {
      setModelMsg("⚠️ " + got.error)
      if (!auto) Dialog.alert({ title: "没拿到模型", message: got.error })
      return
    }
    const cur = (p.model ?? "").trim()
    patch({
      modelOptions: got.list,
      modelOptionsAt: Date.now(),
      model: got.list.indexOf(cur) < 0 ? got.list[0] : cur,
    })
    setModelMsg(auto ? "" : `✅ 拉到 ${got.list.length} 个模型`)
  }

  /** 查余额：余额不在 OpenAI 协议里，按地址试几个常见端点（见 balance_client.ts）。 */
  async function checkBalance(auto: boolean) {
    const base = (p.baseUrl ?? "").trim()
    if (!base) {
      if (!auto) Dialog.alert({ message: "先填接口地址，比如 https://api.deepseek.com" })
      return
    }
    setBalanceBusy(true)
    setBalanceMsg("正在查询…")
    try {
      const r = await queryBalance(base, p.apiKey)
      if (!r.ok) {
        setBalanceMsg("❌ 这个接口查不到余额（点按钮看试过哪些端点）")
        if (!auto) Dialog.alert({ title: "查不到余额", message: r.error ?? "" })
        return
      }
      patch({
        balanceText: r.text,
        balanceDetail: r.detail,
        balanceSource: r.source,
        balanceAt: Date.now(),
      })
      setBalanceMsg("")
    } catch (e: any) {
      setBalanceMsg("❌ " + String(e?.message ?? e))
    } finally {
      setBalanceBusy(false)
    }
  }

  /** 删除前问一句（地址和 Key 会一起没），用系统动作表确认。 */
  async function removeWithConfirm() {
    const picked = await Dialog.actionSheet({
      title: "删除这家供应商？",
      message: `「${providerLabel(p)}」的接口地址和 Key 会一起删掉，删完点「保存」才真正生效。`,
      cancelButton: true,
      actions: [{ label: "删除", destructive: true }],
    })
    if (picked === 0) onDelete()
  }

  return (
    <VStack
      navigationTitle={providerLabel(p)}
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
    >
      <Form>
        <Section
          header={<Text>{`供应商 ${index + 1}`}</Text>}
          footer={<Text>名字只给你自己看（比如「DeepSeek 官方」「公司中转」），列表里好分辨。</Text>}
        >
          <FieldRow label="名字">
            <TextField
              title={suggestProviderName(p.baseUrl) || "如 DeepSeek"}
              value={p.name}
              onChanged={(v) => patch({ name: v })}
            />
          </FieldRow>
          <FieldRow label="接口地址">
            <TextField
              title="https://api.deepseek.com"
              value={p.baseUrl}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ baseUrl: v })}
            />
          </FieldRow>
          <FieldRow label="请求路径">
            <TextField
              title="/chat/completions"
              value={p.apiPath}
              autocorrectionDisabled
              textInputAutocapitalization="never"
              onChanged={(v) => patch({ apiPath: v })}
            />
          </FieldRow>
        </Section>

        <Section
          header={<Text>API Key</Text>}
          footer={<Text>这里是这家供应商自己的 Key（每家一把，互相独立）。</Text>}
        >
          <FieldRow label="API Key">
            <SecureField
              title="sk-xxxxxxxx"
              value={p.apiKey}
              onChanged={(v) => patch({ apiKey: v })}
            />
          </FieldRow>
        </Section>

        <Section
          header={<Text>模型</Text>}
          footer={
            <Text>
              {`打开这一页会自动拉一次模型和余额${(p.apiKey ?? "").trim() ? "" : "（先把 API Key 填上）"}；拉取失败不弹窗，点按钮重试。模型只能从拉回来的列表里选。`}
            </Text>
          }
        >
          {models.length > 0 ? (
            <Picker
              title="模型"
              pickerStyle="menu"
              value={inList ? p.model : ""}
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
            title={fetching ? "正在拉取…" : models.length > 0 ? "重新拉取" : "拉取可用模型"}
            systemImage="arrow.down.circle"
            disabled={fetching}
            action={() => pull(false)}
          />
          {modelMsg ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {modelMsg}
            </Text>
          ) : null}
          {models.length > 0 ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {`已拿到 ${models.length} 个模型${(p.modelOptionsAt ?? 0) > 0 ? " · " + stamp(p.modelOptionsAt as number) : ""}`}
            </Text>
          ) : null}
          {models.length > 0 && !inList ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {`⚠️ 之前存的「${(p.model ?? "").trim() || "（空）"}」不在这个列表里（可能换过服务商）：重新选一个，点「保存」生效。`}
            </Text>
          ) : null}
          <HStack spacing={12} padding={{ vertical: 2 }} frame={{ maxWidth: "infinity" }}>
            <Text>余额</Text>
            <Spacer />
            <Text>{(p.balanceText ?? "").trim() || "未查询"}</Text>
          </HStack>
          {p.balanceDetail ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {p.balanceDetail}
            </Text>
          ) : null}
          <Button
            title={balanceBusy ? "正在查询…" : (p.balanceText ?? "").trim() ? "重新查询余额" : "查询余额"}
            systemImage="creditcard"
            disabled={balanceBusy}
            action={() => checkBalance(false)}
          />
          {balanceMsg ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {balanceMsg}
            </Text>
          ) : null}
          {(p.balanceText ?? "").trim() && (p.balanceAt ?? 0) > 0 ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {`${stamp(p.balanceAt as number)}${p.balanceSource ? " · " + p.balanceSource : ""}`}
            </Text>
          ) : null}
        </Section>

        <Section
          footer={
            <Text>
              切换后点右上角「保存」，聊天页就改用这一家的地址 / Key / 模型。
            </Text>
          }
        >
          <Button
            title={active ? "当前正在使用" : "设为当前使用"}
            systemImage={active ? "checkmark.circle.fill" : "checkmark.circle"}
            disabled={active}
            action={onActivate}
          />
        </Section>

        <Section>
          <Button title="删除这家供应商" role="destructive" action={removeWithConfirm} />
        </Section>
      </Form>
    </VStack>
  )
}

export default ModelsPage
