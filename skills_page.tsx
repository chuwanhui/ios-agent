import {
  Button, Form, HStack, Image, SecureField, Section, Text, TextField, Toggle, VStack, useEffect, useState,
} from "scripting"
import {
  SKILL_DONE, SKILL_INBOX, SkillMeta, deleteSkill, importSkills, listSkills, readSkill,
  setSkillEnabled, skillDirOf, skillsPrompt, stageSkillFile,
} from "./skills_store"
import { loadConfig } from "./agent_store"
import { importSkillFromRepo } from "./repo_import"
import { saveToolbar } from "./config_save"
import { pushRoute, registerRoute } from "./nav_route"

/** 搜索匹配：技能名 / 描述，大小写不敏感。 */
function matchesSkill(s: SkillMeta, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  return [s.name, s.description].some((x) => ((x ?? "") as string).toLowerCase().indexOf(needle) >= 0)
}

interface Props {
  /** 技能有增减 / 启停变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

/**
 * 技能管理页：设置页里的子页（由设置页用 path 路由推进来，见 nav_route.ts，所以自己不带导航栈）。
 * 上面搜索框 + 技能列表，点一条进详情页看完整说明 / 启停 / 删除；导入方式都收在列表下面。
 */
export function SkillsPage({ onChanged = () => {} }: Props) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [query, setQuery] = useState("")
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

  // 详情页的路由：path 里出现 "skill:<id>" 就造这一条的详情页。
  registerRoute("skill:", (id) => {
    const s = skills.find((x) => x.id === id)
    if (!s) return null
    return (
      <SkillDetail
        meta={s}
        onChanged={onChanged}
        onDeleted={() => {
          refresh()
          onChanged()
        }}
      />
    )
  })

  const promptSize = skillsPrompt()?.length ?? 0
  const enabledCount = skills.filter((s) => s.enabled).length
  const shown = skills.filter((s) => matchesSkill(s, query))

  return (
    <VStack
      navigationTitle="技能"
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "搜技能名 / 描述",
      }}
    >
      <Form>
        <Section
          header={<Text>{skills.length > 0 ? `技能 ${skills.length} 个` : "技能列表"}</Text>}
          footer={
            <Text>
              点一条进去看它的完整说明（SKILL.md）、启停和删除；启用 / 停用、删除都是点一下立刻生效，不用等保存。
            </Text>
          }
        >
          {skills.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">还没有导入任何技能，用下面的方式装一个。</Text>
          ) : shown.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">{`没有名字或描述里带「${query.trim()}」的技能。`}</Text>
          ) : (
            shown.map((s) => (
              <HStack
                key={s.id}
                spacing={8}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
                contentShape="rect"
                onTapGesture={() => pushRoute("skill:" + s.id)}
              >
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <HStack spacing={6}>
                    <Text fontWeight="semibold" foregroundStyle="label">
                      {s.name}
                    </Text>
                    {s.enabled ? null : (
                      <Text font="caption2" foregroundStyle="secondaryLabel">
                        {"已停用"}
                      </Text>
                    )}
                  </HStack>
                  <Text font="footnote" foregroundStyle="secondaryLabel">
                    {s.description || "（没有写描述）"}
                  </Text>
                </VStack>
                <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
              </HStack>
            ))
          )}
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

        {busy || note ? (
          <Section header={<Text>进度</Text>}>
            {busy ? <Text>{busy}</Text> : null}
            {note ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {note}
              </Text>
            ) : null}
          </Section>
        ) : null}

        <Section header={<Text>文件位置</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {"已导入归档：" + SKILL_DONE}
          </Text>
        </Section>
      </Form>
    </VStack>
  )
}

interface DetailProps {
  meta: SkillMeta
  /** 启停 / 删除后通知列表页刷新（启停是直接写盘的）。 */
  onChanged: () => void
  /** 删除成功：列表页刷新自己。 */
  onDeleted: () => void
}

/**
 * 技能详情页：完整说明（SKILL.md 全文，不再截断）、附件清单、启停、删除。
 * 启停和删除都直接写盘，不用回设置页保存。
 */
export function SkillDetail({ meta, onChanged, onDeleted }: DetailProps) {
  const [enabled, setEnabled] = useState(meta.enabled)
  const [content, setContent] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>(meta.files ?? [])
  const [dir, setDir] = useState(skillDirOf(meta))
  const [note, setNote] = useState("")

  useEffect(() => {
    const hit = readSkill(meta.id)
    if (!hit) {
      setContent("")
      setNote("读不到 SKILL.md：可能已经被删掉了。")
      return
    }
    setContent(hit.content)
    setFiles(hit.files)
    setDir(skillDirOf(hit.meta))
  }, [])

  function toggle(v: boolean) {
    setEnabled(v)
    setSkillEnabled(meta.id, v)
    onChanged()
  }

  async function copyContent() {
    if (!content) return
    try {
      await Pasteboard.setString(content)
      setNote("已拷贝 SKILL.md 全文。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  async function remove() {
    const ok = await Dialog.confirm({
      title: "删除技能",
      message: `确定删掉技能「${meta.name}」吗？它的所有文件都会被删。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    deleteSkill(meta.id)
    onDeleted()
  }

  return (
    <VStack
      navigationTitle={meta.name}
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
    >
      <Form>
        <Section
          header={<Text>{meta.enabled ? "已启用" : "已停用"}</Text>}
          footer={<Text>{enabled ? "启用中：技能名和描述会进系统提示。" : "停用中：不会进系统提示，模型用不到它。"}</Text>}
        >
          <Text>{meta.description || "（没有写描述）"}</Text>
          <Toggle title="启用" value={enabled} onChanged={toggle} />
          <Button title="删除这个技能" role="destructive" action={remove} />
        </Section>

        <Section
          header={<Text>说明（SKILL.md）</Text>}
          footer={
            <Text>
              这是模型要用这个技能时读到的完整说明（read_skill 读的就是它）。
            </Text>
          }
        >
          {content === null ? (
            <Text foregroundStyle="secondaryLabel">正在读取…</Text>
          ) : content ? (
            <Text font="footnote">{content}</Text>
          ) : (
            <Text foregroundStyle="secondaryLabel">（没读到 SKILL.md 的内容）</Text>
          )}
          {content ? <Button title="拷贝全文" systemImage="doc.on.doc" action={copyContent} /> : null}
        </Section>

        <Section header={<Text>{`附件 ${files.length} 个`}</Text>}>
          {files.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">没有额外文件。</Text>
          ) : (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {files.join("\n")}
            </Text>
          )}
        </Section>

        <Section header={<Text>文件位置</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {dir}
          </Text>
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

export default SkillsPage
