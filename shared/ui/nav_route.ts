/** Shared path-based navigation registry for settings subpages. */

/** path 里存的是字符串 id，id 用「前缀 + 冒号」分成不同子页的地盘。 */
type PathLike = { value: string[]; setValue: (v: string[]) => void }
/** rest 是 id 去掉前缀之后的部分（比如 "provider:abc" → "abc"）。 */
type RouteBuilder = (rest: string) => any

let navPath: PathLike | null = null
const builders: { prefix: string; build: RouteBuilder }[] = []

/** 设置页根组件每次渲染都把它那个 path 登记进来（传 null 表示它卸载了）。 */
export function registerNavPath(p: PathLike | null) {
  navPath = p
}

/** 当前停在几层（根 = 0）。 */
export function navDepth(): number {
  return navPath ? navPath.value.length : 0
}

/** path 末尾那条 id（根上是空串）。 */
export function currentRoute(): string {
  if (!navPath || navPath.value.length === 0) return ""
  return navPath.value[navPath.value.length - 1]
}

/** 进下一层：往 path 末尾加一条 id。 */
export function pushRoute(route: string) {
  if (!navPath) return
  navPath.setValue([...navPath.value, route])
}

/** 返回上一级；已经在根上（或没有 path）返回 false，什么也不做。 */
export function popRoute(): boolean {
  if (!navPath || navPath.value.length === 0) return false
  navPath.setValue(navPath.value.slice(0, -1))
  return true
}

/**
 * 子页登记「id 以 prefix 开头时，这一层页面怎么造」。
 * 每次渲染都登记一遍，保证工厂闭包拿到的是这一页最新的草稿。
 */
export function registerRoute(prefix: string, build: RouteBuilder) {
  const i = builders.findIndex((b) => b.prefix === prefix)
  if (i >= 0) builders[i] = { prefix, build }
  else builders.push({ prefix, build })
}

/** 设置页根组件用：把 path 里的一层 id 变成页面；没人登记过就返回 null。 */
export function buildRoute(route: string): any | null {
  for (const b of builders) {
    if (route.indexOf(b.prefix) === 0) {
      const page = b.build(route.slice(b.prefix.length))
      if (page != null) return page
    }
  }
  return null
}
