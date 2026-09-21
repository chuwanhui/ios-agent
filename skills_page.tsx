import {
  Button, Form, SecureField, Section, Text, TextField, Toggle, VStack, useEffect, useState,
} from "scripting"
import {
  SKILL_DONE, SKILL_INBOX, SkillMeta, deleteSkill, importSkills, listSkills, readSkill,
  setSkillEnabled, skillsPrompt, stageSkillFile,
} from "./skills_store"
import { loadConfig } from "./agent_store"
import { importSkillFromRepo } from "./repo_import"

interface Props {
  /** 技能有增减 / 启停变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

/**
 * 技能管理页：设置页里的子页（由 NavigationLink 推进来，所以自己不带导航栈）。
 * 三种导入方式：上传 zip / md 文件、从 git 仓库导入、手动丢进「技能」文件夹再扫描。
 */
export function SkillsPage({ onChanged = () => {} }: Props) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  /** 上次用的是哪个仓库 / 令牌（令牌存在配置里，下次进来还有）。 */
  const [repoUrl, setRepoUrl] = useState("")
  const [token, setToken] = useState(loadConfig().gitToken ?? "")

  const refresh = () => {
    setSkills(listSkills().slice().sort((a, b) => b.addedAt - a.addedAt))
  }

  useEffect(() => {
    refresh()
  }, [])

  function linesOf(res: { added: SkillMeta[]; skipped: string[]; errors: string[] }): string[] {
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
    return lines
  }

  /** 扫描「技能」文件夹（上传和手动丢文件都走这里）。 */
  async function runImport(extra: string[] = []) {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importSkills(setBusy)
      refresh()
      const lines = linesOf(res).concat(extra)
      if (lines.length === 0) lines.push("「技能」文件夹里没有新文件。")
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  /** 从「文件」App 挑 zip / md 上传：拷进「技能」文件夹后走普通扫描。 */
  async function uploadPackages() {
    setNote("")
    let picked: string[] = []
    try {
      picked = await DocumentPicker.pickFiles({ allowsMultipleSelection: true })
    } catch (e: any) {
      setNote("选择文件失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked || picked.length === 0) return
    const extra: string[] = []
    let staged = 0
    for (const p of picked) {
      if (stageSkillFile(p)) staged += 1
    }
    if (staged < picked.length) extra.push(`有 ${picked.length - staged} 个文件没能拷进来。`)
    if (staged === 0) {
      setNote("没能把文件拷进来。")
      return
    }
    await runImport(extra)
  }

  /** 从 git 仓库（GitHub / GitLab）下载 zip 装一个技能。 */
  async function importFromRepo() {
    const url = (repoUrl ?? "").trim()
    if (!url) {
      Dialog.alert({ message: "先填仓库地址，比如 https://github.com/owner/repo" })
      return
    }
    setBusy("正在下载…")
    setNote("")
    try {
      const res = await importSkillFromRepo(url, token, setBusy)
      refresh()
      if (res.added) {
        setNote(
          `✅ 从 ${res.refLabel || "仓库"} 装好了技能「${res.added.name}」（${res.added.files.length} 个文件）。`,
        )
        onChanged()
      } else {
        setNote("导入失败：" + (res.error ?? "未知错误"))
      }
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
    onChanged()
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
    <VStack navigationTitle="技能" navigationBarTitleDisplayMode="inline">
      <Form>
        <Section
          header={<Text>上传技能包</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                一个技能就是一个含 SKILL.md 的文件夹，可以带脚本、模板等附件。打包成 .zip 最省事；单个 .md（头部 YAML 里写 name / description）也能直接导入。
              </Text>
              <Text>从「文件」App 挑，选完会拷一份到「技能」文件夹再导入。</Text>
            </VStack>
          }
        >
          <Button
            title={busy && busy.indexOf("扫描") >= 0 ? busy : "选择 zip / md 上传"}
            systemImage="doc.badge.plus"
            disabled={busy !== ""}
            action={uploadPackages}
          />
        </Section>

        <Section
          header={<Text>从 git 仓库导入</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              <Text>
                GitHub / GitLab 都行，公开仓库不用填令牌。可以只导入仓库里的某个子目录：
                https://github.com/owner/repo/tree/main/skills/foo
              </Text>
              <Text>
                私有仓库填访问令牌（GitHub 用 personal access token，GitLab 用 personal access token）。令牌会存在本机配置里，只用来下载这个仓库。
              </Text>
            </VStack>
          }
        >
          <TextField
            title="仓库地址"
            value={repoUrl}
            prompt="https://github.com/owner/repo"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setRepoUrl}
          />
          <SecureField
            title="访问令牌"
            value={token}
            prompt="可选，私有仓库才要"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setToken}
          />
          <Button
            title={busy && busy.indexOf("下载") >= 0 ? busy : "下载并导入"}
            systemImage="arrow.down.circle"
            disabled={busy !== ""}
            action={importFromRepo}
          />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>

        <Section
          header={<Text>手动放技能</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
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
            title={busy && busy.indexOf("扫描") >= 0 ? busy : "扫描并导入"}
            systemImage="square.and.arrow.down"
            disabled={busy !== ""}
            action={() => runImport()}
          />
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
                    onChanged()
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
  )
}

export default SkillsPage
