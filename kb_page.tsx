import {
  Button, Form, Section, Text, VStack, useEffect, useState,
} from "scripting"
import {
  KB_DONE, KB_INBOX, KB_VECTORS, KbDoc, KbFolder, addKbFolder, clearKb, deleteKbDoc, importKbFiles,
  importKbFolder, importKbInbox, kbStats, listKbFolders, loadKbIndex, removeKbFolder,
} from "./kb_store"
import {
  autoEmbedAfterImport, buildKbVectors, dropKbVectors, kbSemanticEnabled, kbVectorStatus,
} from "./kb_embed"

interface Props {
  /** 资料或文件夹有变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 知识库管理页：设置页里的子页（由 NavigationLink 推进来，所以自己不带导航栈）。
 * 三种放资料的方式：手动丢进「知识库」文件夹、从「文件」App 上传、挂一个外部文件夹（只读索引）。
 */
export function KbPage({ onChanged = () => {} }: Props) {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [stat, setStat] = useState(kbStats())
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  /** 向量覆盖面（配了向量服务才有意义）。 */
  const [vec, setVec] = useState(kbVectorStatus())
  const [vecNote, setVecNote] = useState("")

  const semanticOn = kbSemanticEnabled()

  const refresh = () => {
    const idx = loadKbIndex(true)
    setDocs(idx.docs.slice().sort((a, b) => b.addedAt - a.addedAt))
    setStat(kbStats())
    setFolders(listKbFolders().slice())
    setVec(kbVectorStatus())
  }

  useEffect(() => {
    refresh()
  }, [])

  /** 导入结果 → 几行能看懂的话。 */
  function linesOf(res: { added: KbDoc[]; skipped: string[]; errors: string[] }): string[] {
    const lines: string[] = []
    if (res.added.length > 0) {
      lines.push(
        `导入成功 ${res.added.length} 份：\n` +
          res.added
            .slice(0, 15)
            .map((d) => `· ${d.title}（${d.chunks} 段）`)
            .join("\n") +
          (res.added.length > 15 ? `\n…另外 ${res.added.length - 15} 份` : ""),
      )
    }
    if (res.skipped.length > 0) {
      const head = res.skipped.slice(0, 12).map((s) => "· " + s).join("\n")
      lines.push(
        "跳过：\n" + head + (res.skipped.length > 12 ? `\n…另外 ${res.skipped.length - 12} 条` : ""),
      )
    }
    if (res.errors.length > 0) {
      const head = res.errors.slice(0, 8).map((s) => "· " + s).join("\n")
      lines.push("出错：\n" + head + (res.errors.length > 8 ? `\n…另外 ${res.errors.length - 8} 条` : ""))
    }
    return lines
  }

  /** 开了语义检索就把新片段的向量补上（失败不打断导入结果）。 */
  async function autoEmbed(lines: string[], addedCount: number) {
    if (addedCount === 0 || !semanticOn) return
    const auto = await autoEmbedAfterImport((done, total) => setBusy(`正在生成向量 ${done}/${total}…`))
    refresh()
    if (auto) lines.push(auto)
  }

  async function runImport() {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importKbInbox(setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push("「知识库」文件夹里没有新文件。")
      await autoEmbed(lines, res.added.length)
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  /** 从「文件」App 挑文件上传：先拷进「知识库」文件夹，再走普通导入。 */
  async function uploadFiles() {
    setNote("")
    let picked: string[] = []
    try {
      picked = await DocumentPicker.pickFiles({ allowsMultipleSelection: true })
    } catch (e: any) {
      setNote("选择文件失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked || picked.length === 0) return
    setBusy("正在导入…")
    try {
      const res = await importKbFiles(picked, setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push("没有可导入的内容。")
      await autoEmbed(lines, res.added.length)
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  /** 挂一个外部文件夹：书签持久化，之后可以随时"更新索引"（只读，不动原文件）。 */
  async function pickFolder() {
    setNote("")
    let picked: DocumentPickerBookmarkResult | null = null
    try {
      picked = await DocumentPicker.pickDirectoryBookmark({
        preferredName: "kb-" + Date.now().toString(36),
      })
    } catch (e: any) {
      setNote("选择文件夹失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked) return
    const folder = addKbFolder(picked.bookmarkName, baseName(picked.path), picked.path)
    refresh()
    await indexFolder(folder, true)
  }

  async function indexFolder(folder: KbFolder, first = false) {
    setBusy(`正在索引「${folder.label}」…`)
    setNote("")
    try {
      const res = await importKbFolder(folder, setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push(`「${folder.label}」还是空的（没有能读的文档）。`)
      await autoEmbed(lines, res.added.length)
      if (first) lines.unshift("已挂上这个文件夹，以后它变了点「更新索引」就行。")
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("索引失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  async function forgetFolder(folder: KbFolder) {
    const ok = await Dialog.confirm({
      title: "取消挂载",
      message: `从知识库里删掉「${folder.label}」索引的资料吗？原文件夹不会被改动。`,
      confirmLabel: "取消挂载",
    })
    if (!ok) return
    removeKbFolder(folder.bookmark)
    refresh()
    setNote(`已取消挂载「${folder.label}」。`)
    onChanged()
  }

  async function removeDoc(d: KbDoc) {
    const ok = await Dialog.confirm({
      title: "删除资料",
      message: `确定把「${d.title}」从知识库里删掉吗？`,
      confirmLabel: "删除",
    })
    if (!ok) return
    deleteKbDoc(d.id)
    refresh()
    onChanged()
  }

  async function clearAll() {
    const ok = await Dialog.confirm({
      title: "清空知识库",
      message: "会删掉全部资料索引（原始文件仍留在「已导入」文件夹里）。",
      confirmLabel: "清空",
    })
    if (!ok) return
    clearKb()
    refresh()
    onChanged()
  }

  /** 给缺向量的片段补向量（已有的不重算）。 */
  async function runBuildVectors() {
    setVecNote("")
    setBusy("准备生成向量…")
    try {
      const r = await buildKbVectors((done, total) => setBusy(`正在生成向量 ${done}/${total}…`))
      refresh()
      const after = kbVectorStatus()
      setVecNote(
        r.embedded > 0
          ? `✅ 新算 ${r.embedded} 段，现有向量 ${after.embedded}/${after.total} 段 · ${after.dim} 维 · 用时 ${r.seconds}s`
          : "所有片段都已有向量，不需要重建。",
      )
    } catch (e: any) {
      setVecNote("❌ " + String(e?.message ?? e))
    } finally {
      setBusy("")
    }
  }

  async function dropVectors() {
    const ok = await Dialog.confirm({
      title: "清空向量",
      message: "只删本机存的向量（资料不受影响），再想用语义检索需要重建一次。",
      confirmLabel: "清空",
    })
    if (!ok) return
    dropKbVectors()
    refresh()
    setVecNote("已清空向量。")
  }

  return (
    <VStack navigationTitle="知识库" navigationBarTitleDisplayMode="inline">
      <Form>
        <Section
          header={<Text>上传文件</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                从「文件」App 里挑要放进知识库的资料。支持 txt / md / json / csv / log / pdf；PDF 必须是能选字的电子版，扫描件（纯图片）读不出文字。
              </Text>
              <Text>选完会拷一份到「知识库」文件夹里再导入，原始文件仍在原处。</Text>
            </VStack>
          }
        >
          <Button
            title={busy && busy.indexOf("正在读取") >= 0 ? busy : "选择文件上传"}
            systemImage="doc.badge.plus"
            disabled={busy !== ""}
            action={uploadFiles}
          />
        </Section>

        <Section
          header={<Text>挂外部文件夹</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                适合「资料一直在更新」的场景：某个文件夹（iCloud 云盘、本地文档都行）挂进来，需要时点「更新索引」重新扫一遍。
              </Text>
              <Text>
                只读，绝不动原文件；删掉的文件在下一次更新索引时会从知识库消失。会跳过 .git、node_modules 这类目录，一次最多索引 300 个文件。
              </Text>
            </VStack>
          }
        >
          {folders.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有挂任何文件夹</Text>
          ) : (
            folders.map((f) => (
              <VStack key={f.bookmark} alignment="leading" spacing={4}>
                <Text fontWeight="semibold">{f.label}</Text>
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  {f.path}
                </Text>
                <Button
                  title={busy && busy.indexOf(f.label) >= 0 ? busy : "更新索引"}
                  systemImage="arrow.clockwise"
                  disabled={busy !== ""}
                  action={() => indexFolder(f)}
                />
                <Button title="取消挂载" role="destructive" action={() => forgetFolder(f)} />
              </VStack>
            ))
          )}
          <Button
            title="挂载一个文件夹"
            systemImage="folder.badge.plus"
            disabled={busy !== ""}
            action={pickFolder}
          />
        </Section>

        <Section
          header={<Text>手动放资料</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                也可以直接把文件拖进「文件」App 的：我的 iPhone → Scripting → 知识库，再回到这里点「扫描并导入」。AirDrop、iCloud 云盘、电脑拷进去都行。
              </Text>
              <Text>导入后原始文件会被移到同目录的「已导入」子文件夹，不会重复导入。</Text>
            </VStack>
          }
        >
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {KB_INBOX}
          </Text>
          <Button
            title={busy && busy.indexOf("正在扫描") >= 0 ? busy : "扫描并导入"}
            systemImage="square.and.arrow.down"
            disabled={busy !== ""}
            action={runImport}
          />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>

        <Section
          header={<Text>状态</Text>}
          footer={
            <Text>
              {semanticOn
                ? "关键词部分（中文双字切词 + BM25）在本机算；语义相似度是用你配置的向量服务把「提问」算成向量，再和关键词结果混合排序。"
                : "用的是纯本机的离线检索（中文按双字切词 + BM25 排序），不联网、不需要额外付费能力。资料越多、问得越具体，命中越准。"}
            </Text>
          }
        >
          <Text>{`已导入 ${stat.docs} 份资料 · ${stat.chunks} 个片段`}</Text>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {stat.chars > 0 ? `约 ${Math.round(stat.chars / 1000)} 千字` : "还没有资料"}
          </Text>
        </Section>

        <Section
          header={<Text>语义索引</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                把每个片段预先算成向量存在本机（{KB_VECTORS}），提问时也把问题算成向量，两边按余弦相似度匹配。
              </Text>
              <Text>
                提问换个说法、用近义词也能找到资料；没配向量服务时这一步自动跳过（仍用关键词检索）。
              </Text>
            </VStack>
          }
        >
          {semanticOn ? (
            <Text>
              {`已有向量 ${vec.embedded}/${vec.total} 段` + (vec.dim ? ` · ${vec.dim} 维` : "")}
            </Text>
          ) : (
            <Text foregroundStyle="secondaryLabel">
              未启用。想用就到「设置 → 知识库语义检索」填好向量服务与模型。
            </Text>
          )}
          {semanticOn && vec.model && vec.stale ? (
            <Text font="footnote" foregroundStyle="systemOrange">
              {`本机存的向量是用「${vec.model}」算的，与当前配置的模型不同，需要重建一次。`}
            </Text>
          ) : null}
          {semanticOn ? (
            <Button
              title={busy && busy.indexOf("向量") >= 0 ? busy : "为知识库建向量"}
              systemImage="wand.and.stars"
              disabled={busy !== "" || stat.chunks === 0}
              action={runBuildVectors}
            />
          ) : null}
          {semanticOn && vec.embedded > 0 ? (
            <Button title="清空向量" role="destructive" action={dropVectors} />
          ) : null}
          {vecNote ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {vecNote}
            </Text>
          ) : null}
        </Section>

        <Section header={<Text>资料列表</Text>}>
          {docs.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有导入任何资料</Text>
          ) : (
            docs.map((d) => (
              <VStack key={d.id} alignment="leading" spacing={2}>
                <Text>{d.title}</Text>
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  {`${d.chunks} 段 · ${d.source}`}
                </Text>
                <Button title="删除" role="destructive" action={() => removeDoc(d)} />
              </VStack>
            ))
          )}
        </Section>

        <Section header={<Text>原始文件</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {"归档目录：" + KB_DONE}
          </Text>
          <Button
            title="清空知识库"
            role="destructive"
            disabled={stat.docs === 0}
            action={clearAll}
          />
        </Section>
      </Form>
    </VStack>
  )
}

export default KbPage
