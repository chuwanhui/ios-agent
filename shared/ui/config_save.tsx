import { Button } from "scripting"
import { popRoute } from "./nav_route"

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
 *
 * 写盘成功后**自动返回上一级**（子页存完就退回上一层，符合 iOS 习惯）；
 * 设置页自己那个「保存」是写盘后关掉整个设置页，在 config_page.tsx 里单独处理。
 * 返回上一级只能靠 path 导航（原因见 nav_route.ts）。
 */

type Saver = () => boolean

let saver: Saver | null = null

/** 设置页每次渲染都把自己那份写盘函数登记进来（传 null 表示它卸载了）。 */
export function registerConfigSaver(fn: Saver | null) {
  saver = fn
}

/** 子页里的「保存」：写盘成功后返回上一级。 */
export function saveConfigHere() {
  if (!saver) return
  // 校验没过：persist() 自己弹过窗了，留在原页让用户改。
  if (!saver()) return
  // 存下了，退回上一层（设置页根上的「保存」不在这里，由设置页自己收起 sheet）。
  if (!popRoute()) {
    // 兜底：这一页不是被设置页推出来的（比如单独预览 / 单独跑），没法返回，只提示一句。
    Dialog.alert({ title: "已保存", message: "设置已经写进配置，聊天和工具立刻按新配置走。" })
  }
}

/** 子页根视图用：右上角一个「保存」（和设置页那个长得一样、判等一样）。 */
export function saveToolbar() {
  return {
    topBarTrailing: <Button title="保存" fontWeight="semibold" action={saveConfigHere} />,
  }
}
