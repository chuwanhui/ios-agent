import { Form, HStack, Section, Text, TextField, VStack } from "scripting"
import { saveToolbar } from "../../shared/ui/config_save"

/** Consistent label / field row used across settings pages. */
export function FieldRow(props: { label: string; children: any }) {
  return (
    <HStack spacing={8}>
      <Text frame={{ width: 84, alignment: "leading" }} foregroundStyle="secondaryLabel">
        {props.label}
      </Text>
      {props.children}
    </HStack>
  )
}

/** Configure the single Shortcuts entrypoint used by the agent. */
export function ExecutorPage(props: { shortcutName: string; onChange: (name: string) => void }) {
  const name = props.shortcutName.trim()
  return (
    <VStack
      navigationTitle="统一执行器"
      navigationBarTitleDisplayMode="inline"
      toolbar={saveToolbar()}
    >
      <Form>
        <Section
          header={<Text>快捷指令入口</Text>}
          footer={<Text>智能体只调用这一条快捷指令。动作由执行器读取自身注册表后分发，不需要在智能体逐条登记。</Text>}
        >
          <FieldRow label="快捷指令名">
            <TextField
              title="智能体执行器"
              value={props.shortcutName}
              onChanged={(value: string) => props.onChange(value)}
            />
          </FieldRow>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {name ? `当前入口：${name}。每次调用都会等待回传。` : "留空会关闭系统快捷指令执行能力。"}
          </Text>
        </Section>

        <Section
          header={<Text>执行器协议</Text>}
          footer={<Text>执行器应先支持 list_tools，返回动作 id、说明和参数；其他 action 根据本地注册表执行。</Text>}
        >
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {'输入：{"action":"list_tools","params":{},"callId":"…"}'}
          </Text>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {'回传：scripting://run/智能体?callId=<编码后的callId>&result=<编码后的结果>'}
          </Text>
        </Section>
      </Form>
    </VStack>
  )
}
