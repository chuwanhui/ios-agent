import {
  Button, Form, NavigationStack, Section, Text, VStack, useEffect, useState,
} from "scripting"
import {
  KB_DONE, KB_INBOX, KbDoc, clearKb, deleteKbDoc, importKbInbox, kbStats, loadKbIndex,
} from "./kb_store"

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

  const refresh = () => {
    const idx = loadKbIndex(true)
    setDocs(idx.docs.slice().sort((a, b) => b.addedAt - a.addedAt))
    setStat(kbStats())
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
                用的是纯本机的离线检索（中文按双字切词 + BM25 排序），不联网、不需要额外付费能力。资料越多、问得越具体，命中越准。
              </Text>
            }
          >
            <Text>{`已导入 ${stat.docs} 份资料 · ${stat.chunks} 个片段`}</Text>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {stat.chars > 0 ? `约 ${Math.round(stat.chars / 1000)} 千字` : "还没有资料"}
            </Text>
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
