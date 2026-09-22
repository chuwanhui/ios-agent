import { Button } from "scripting"

/**
 * 子页右上角的「保存」。
 *
 * 设置页（config_page.tsx）是**唯一**会写 config.json 的地方：模型供应商 / 工具 /
 * MCP / 知识库 / 技能这些子页都只把草稿推回设置页的 state，最后统一由设置页的
 * persist() 校验 + 落盘。所以子页想要「右上角也能保存」，不能再写一遍落盘逻辑，
 * 而是把设置页的 persist() 登记到这条总线上，点按钮时调 saveConfigHere()。
 *
 * 登记进来的是设置页**每次渲染都会更新**的那份闭包 ⇒ 子页存下的永远是最新草稿，
 * 不会出现「刚敲完一个字就点保存，结果少了这个字」。
 */

type Saver = () => boolean

let saver: Saver | null = null

/** 设置页每次渲染都把自己那份写盘函数登记进来（传 null 表示它卸载了）。 */
export function registerConfigSaver(fn: Saver | null) {
  saver = fn
}

/**
 * 子页里的「保存」：写盘成功后**留在原页**接着改，只弹一句确认。
 * （设置页自己那个「保存」是写盘后关掉设置页；两者共用同一份校验逻辑。）
 */
export function saveConfigHere() {
  if (!saver) return
  if (saver()) {
    Dialog.alert({
      title: "已保存",
      message: "设置已经写进配置，聊天和工具立刻按新配置走。\n\n可以接着改，也可以下拉收起设置页。",
    })
  }
}

/** 子页根视图用：右上角一个「保存」（和设置页那个长得一样、判等一样）。 */
export function saveToolbar() {
  return {
    topBarTrailing: <Button title="保存" fontWeight="semibold" action={saveConfigHere} />,
  }
}
