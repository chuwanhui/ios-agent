import {
  Button, Form, NavigationStack, Section, Text, Toggle, VStack, useEffect, useState,
} from "scripting"
import {
  SKILL_DONE, SKILL_INBOX, SkillMeta, deleteSkill, importSkills, listSkills, readSkill,
  setSkillEnabled, skillsPrompt,
} from "./skills_store"

interface Props {
  /** 关闭本页（由设置页控制 sheet 状态）。 */
  onClose?: () => void
}

/**
 * 技能管理页：导入 zip / 文件夹 / 单个 .md（含 SKILL.md），
 * 列出、启用/停用、查看说明、删除。以 sheet 形式从设置页打开。
 */
export function SkillsPage({ onClose = () => {} }: Props) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")

  const refresh = () => {
    setSkills(listSkills().slice().sort((a, b) => b.addedAt - a.addedAt))
  }

  useEffect(() => {
    refresh()
  }, [])

  async function runImport() {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importSkills(setBusy)
      refresh()
      const lines: string[] = []
      if (res.added.length > 0) {
        lines.push(
          `导入成功 ${res.added.length} 个：\n` +
            res.added.map((s) => `· ${s.name}（${s.files.length} 个文件）`).join("\n"),
        )
      }
      if (res.skipped.length > 0) {
        lines.push("跳过：\n" + res.skipped.map((s) => "· " + s).join("\n"))
      }
      if (res.errors.length > 0) {
        lines.push("出错：\n" + res.errors.map((s) => "· " + s).join("\n"))
      }
      if (lines.length === 0) lines.push("「技能」文件夹里没有新文件。")
      setNote(lines.join("\n\n"))
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  async function removeSkill(s: SkillMeta) {
    const ok = await Dialog.confirm({
      title: "删除技能",
      message: `确定删掉技能「${s.name}」吗？它的所有文件都会被删。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    deleteSkill(s.id)
    refresh()
  }

  function viewSkill(s: SkillMeta) {
    const hit = readSkill(s.id)
    if (!hit) {
      Dialog.alert({ title: "读不到", message: "SKILL.md 可能已被删掉。" })
      return
    }
    const head = hit.content.length > 6000 ? hit.content.slice(0, 6000) + "\n…（已截断）" : hit.content
    Dialog.alert({ title: s.name, message: head || "（SKILL.md 是空的）" })
  }

  const promptSize = skillsPrompt()?.length ?? 0
  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <NavigationStack>
      <VStack
        navigationTitle="技能"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarTrailing: <Button title="完成" action={onClose} fontWeight="semibold" />,
        }}
      >
        <Form>
          <Section
            header={<Text>怎么放技能</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  一个技能就是一个含 SKILL.md 的文件夹，可以带脚本、模板等附件。打包成 .zip 最省事；单个 .md（头部 YAML 里写 name / description）也能直接导入。
                </Text>
                <Text>
                  把 zip / 文件夹放进「文件」App → 我的 iPhone → Scripting → 技能，再回来点「扫描并导入」。处理完的来源会移到「已导入」。
                </Text>
              </VStack>
            }
          >
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {SKILL_INBOX}
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
            header={<Text>怎么用</Text>}
            footer={
              <Text>
                只有技能名和一句话描述会进系统提示（省 token）；真正要执行时才让模型用 read_skill 读出完整步骤，这就是渐进式披露。
              </Text>
            }
          >
            <Text>{`${skills.length} 个技能，启用 ${enabledCount} 个`}</Text>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {promptSize > 0 ? `系统提示里占约 ${promptSize} 字` : "关闭状态或没有可用技能"}
            </Text>
          </Section>

          <Section header={<Text>技能列表</Text>}>
            {skills.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有导入任何技能</Text>
            ) : (
              skills.map((s) => (
                <VStack key={s.id} alignment="leading" spacing={4}>
                  <Text fontWeight="semibold">{s.name}</Text>
                  <Text font="footnote" foregroundStyle="secondaryLabel">
                    {s.description || "（没有写描述）"}
                  </Text>
                  <Toggle
                    title="启用"
                    value={s.enabled}
                    onChanged={(v) => {
                      setSkillEnabled(s.id, v)
                      refresh()
                    }}
                  />
                  <Button title="查看说明" action={() => viewSkill(s)} />
                  <Button title="删除" role="destructive" action={() => removeSkill(s)} />
                </VStack>
              ))
            )}
          </Section>

          <Section header={<Text>文件位置</Text>}>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {"已导入归档：" + SKILL_DONE}
            </Text>
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default SkillsPage
