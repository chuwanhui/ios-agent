import { HStack, Text } from "scripting"

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
