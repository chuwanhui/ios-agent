import {
  Button, Form, NavigationStack, Section, Text, Toggle, VStack, useState,
} from "scripting"
import { AgentConfig, SessionMounts, mountsFromConfig } from "./agent_store"
import { listSkills } from "./skills_store"

interface Props {
  /** 当前设置（决定「跟随设置」时能挂哪些东西）。 */
  cfg: AgentConfig
  /** 当前会话的挂载；undefined = 跟随设置页里的默认。 */
  mounts?: SessionMounts
  onChange: (mounts?: SessionMounts) => void
  /** 关闭本页（由聊天页控制 sheet 状态）。 */
  onClose?: () => void
}

/**
 * 会话级挂载面板：这一轮对话要用哪些能力。
 * 跟「设置页里的默认」是两码事——这里只影响当前会话，会跟历史一起存下来。
 */
export function MountPage({ cfg, mounts, onChange, onClose = () => {} }: Props) {
  const skills = listSkills().filter((s) => s.enabled)
  const usingDefault = mounts == null
  const eff = mounts ?? mountsFromConfig(cfg, skills.map((s) => s.id))

  function set(p: Partial<SessionMounts>) {
    onChange({ ...eff, ...p })
  }

  function flip(list: string[], id: string): string[] {
    return list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : [...list, id]
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle="本轮挂载"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarTrailing: <Button title="完成" action={onClose} fontWeight="semibold" />,
        }}
      >
        <Form>
          <Section
            footer={
              <VStack alignment="leading" spacing={4}>
                <Text>
                  挂载只对「当前这个对话」生效，会跟着历史一起存下来：下一个对话默认还是按设置页的来。
                </Text>
                <Text>
                  想让某个能力不参与，就把对应的开关关掉；不确定就点下面的「恢复跟随设置」。
                </Text>
              </VStack>
            }
          >
            <Text>
              {usingDefault ? "当前：跟随设置页的默认" : "当前：已按本会话单独挂载"}
            </Text>
            <Button
              title="恢复跟随设置"
              systemImage="arrow.uturn.backward"
              disabled={usingDefault}
              action={() => onChange(undefined)}
            />
          </Section>

          <Section
            header={<Text>知识库</Text>}
            footer={
              <Text>
                {cfg.kbEnabled
                  ? "开了才会在回答前检索你导入的资料。资料本身在「设置 → 知识库」里管理。"
                  : "设置页里没有开启知识库检索，这里挂着也不会生效。想用先去设置页打开。"}
              </Text>
            }
          >
            <Toggle
              title="挂载知识库"
              value={eff.kb}
              onChanged={(v) => set({ kb: v })}
            />
          </Section>

          <Section
            header={<Text>技能</Text>}
            footer={
              <Text>
                勾上的技能才会进这一轮的系统提示（模型需要时用 read_skill 读全文）。想全部关掉就都把勾去掉。
              </Text>
            }
          >
            {skills.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有启用中的技能</Text>
            ) : (
              skills.map((s) => (
                <Toggle
                  key={s.id}
                  title={s.name}
                  value={eff.skills.indexOf(s.id) >= 0}
                  onChanged={() => set({ skills: flip(eff.skills, s.id) })}
                />
              ))
            )}
          </Section>

          <Section
            header={<Text>本地快捷指令工具</Text>}
            footer={
              <Text>
                只影响模型这一轮「看得见」哪些工具；工具本身在「设置 → 本地快捷指令工具」里增删。
              </Text>
            }
          >
            {cfg.tools.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有配置本地快捷指令工具</Text>
            ) : (
              cfg.tools.map((t) => (
                <Toggle
                  key={t.name}
                  title={t.name}
                  value={eff.tools.indexOf(t.name) >= 0}
                  onChanged={() => set({ tools: flip(eff.tools, t.name) })}
                />
              ))
            )}
          </Section>

          <Section
            header={<Text>MCP 服务器</Text>}
            footer={
              <Text>
                只挂这一轮要用的服务器，能少给模型几个工具、少花点 token。服务器本身在「设置 → MCP 服务器」里管理。
              </Text>
            }
          >
            {cfg.mcpServers.length === 0 ? (
              <Text foregroundStyle="secondaryLabel">还没有配置 MCP 服务器</Text>
            ) : (
              cfg.mcpServers.map((m) => (
                <Toggle
                  key={m.id}
                  title={m.name.trim() || m.id}
                  value={eff.mcp.indexOf(m.id) >= 0}
                  onChanged={() => set({ mcp: flip(eff.mcp, m.id) })}
                />
              ))
            )}
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

/** 聊天页 composer 上方的小标签：一眼看出这个会话挂载了什么。 */
export function mountChips(mounts?: SessionMounts): Array<{ key: string; label: string }> {
  if (!mounts) return []
  return [
    { key: "kb", label: mounts.kb ? "📚 知识库" : "🚫 知识库" },
    {
      key: "skills",
      label: mounts.skills.length > 0 ? `🧩 技能 ${mounts.skills.length}` : "🚫 技能",
    },
    {
      key: "tools",
      label: mounts.tools.length > 0 ? `⚡ 快捷指令 ${mounts.tools.length}` : "🚫 快捷指令",
    },
    { key: "mcp", label: mounts.mcp.length > 0 ? `🔌 MCP ${mounts.mcp.length}` : "🚫 MCP" },
  ]
}

export default MountPage
