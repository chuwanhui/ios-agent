import {
  Button, Form, NavigationStack, Section, Text, VStack, useEffect, useState,
} from "scripting"
import {
  KB_DONE, KB_INBOX, KB_VECTORS, KbDoc, clearKb, deleteKbDoc, importKbInbox, kbStats, loadKbIndex,
} from "./kb_store"
import {
  autoEmbedAfterImport, buildKbVectors, dropKbVectors, kbSemanticEnabled, kbVectorStatus,
} from "./kb_embed"

interface Props {
  /** 关闭本页（由设置页控制 sheet 状态）。 */
  onClose?: () => void
}

/**
 * 知识库管理页：把「文件」App 里的资料导进来做离线全文检索。
 * 以 sheet 形式从设置页打开。
 */
export function KbPage({ onClose = () => {} }: Props) {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [stat, setStat] = useState(kbStats())
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
    setVec(kbVectorStatus())
  }

  useEffect(() => {
    refresh()
  }, [])

  async function runImport() {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importKbInbox(setBusy)
      refresh()
      const lines: string[] = []
      if (res.added.length > 0) {
        lines.push(
          `导入成功 ${res.added.length} 份：\n` +
            res.added.map((d) => `· ${d.title}（${d.chunks} 段）`).join("\n"),
        )
      }
      if (res.skipped.length > 0) {
        lines.push("跳过：\n" + res.skipped.map((s) => "· " + s).join("\n"))
      }
      if (res.errors.length > 0) {
        lines.push("出错：\n" + res.errors.map((s) => "· " + s).join("\n"))
      }
      if (lines.length === 0) lines.push("「知识库」文件夹里没有新文件。")
      // 开了语义检索就顺手把新片段的向量补上（失败不打断导入结果）
      if (res.added.length > 0 && semanticOn) {
        const auto = await autoEmbedAfterImport((done, total) =>
          setBusy(`正在生成向量 ${done}/${total}…`),
        )
        refresh()
        if (auto) lines.push(auto)
      }
      setNote(lines.join("\n\n"))
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
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
    <NavigationStack>
      <VStack
        navigationTitle="知识库"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarTrailing: <Button title="完成" action={onClose} fontWeight="semibold" />,
        }}
      >
        <Form>
          <Section
            header={<Text>怎么放资料</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  把文件拖进「文件」App 的：我的 iPhone → Scripting → 知识库，再回到这里点「扫描并导入」。AirDrop、iCloud 云盘、电脑拷进去都行。
                </Text>
                <Text>
                  导入后原始文件会被移到同目录的「已导入」子文件夹，不会重复导入。支持 txt / md / json / csv / log / pdf；PDF 必须是能选字的电子版，扫描件（纯图片）读不出文字。
                </Text>
              </VStack>
            }
          >
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {KB_INBOX}
            </Text>
            <Button
              title={busy ? busy : "扫描并导入"}
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
    </NavigationStack>
  )
}

export default KbPage
