# 手机智能体 · Scripting

一个跑在 iPhone 上的**真·智能体**：说话 → DeepSeek 大模型 → 调用手机上的真实能力 → 语音回答。
基于 [Scripting](https://scripting.fun)（iOS 上的 TypeScript 脚本运行器），**无第三方 npm 依赖**。

```
听写 → DeepSeek（带上下文 + function calling）→ 工具（快捷指令 / MCP / 知识库 / 技能）→ 回复
```

## 功能

| 模块 | 说明 |
| --- | --- |
| **聊天页** | 参考 DeepSeek / ChatGPT 的布局：角色形象、多会话、左侧隐藏抽屉放历史 |
| **自定义头像** | 设置页从相册选照片或拍一张，自动方形裁剪 + 缩到 512pt；没照片时用 emoji，文件丢了自动回退 |
| **语音通话模式** | 聆听 → 思考 → 朗读 → 再聆听，自动循环，点头像可打断朗读 |
| **快捷指令工具** | 一个真实快捷指令 = 一个工具（`shortcuts://` 单向触发）|
| **MCP 工具** | 远程 MCP 服务器（Streamable HTTP），带**返回值**的 JSON-RPC 工具 |
| **知识库** | 纯本机离线全文检索（中文 bigram + BM25，纯 JS）；支持 txt / md / json / csv / log / pdf |
| **技能（skill）** | 上传含 `SKILL.md` 的文件夹或 zip；渐进式披露 + `read_skill` 按需读取 |
| **灵动岛** | 思考中 / 完成 / 出错的状态指示（Live Activity）|
| **快捷指令 App 集成** | 通过「运行脚本」动作 + Siri 调用，`intent.tsx` 入口自动听写并朗读 |

## 安装

1. 在 iPhone 上安装 **Scripting**，把本仓库放到 `<AppGroup>/Documents/scripts/` 下（目录名 `智能体`）。
2. 打开脚本 → 右上角**设置** → 填 DeepSeek **API Key**（接口地址 / 路径 / 模型名都有默认值）。
3. 可选：
   - 设置 → 角色：改助手名字，点「从相册选择照片」或「拍一张照片」给它换个真头像
   - 设置 → 添加 MCP 服务器（例如 `https://mcp.deepwiki.com/mcp`）
   - 设置 → 知识库：把资料丢进「文件」App 的 `Scripting/知识库`，再点「扫描并导入」
   - 设置 → 技能：把含 `SKILL.md` 的文件夹或 zip 丢进 `Scripting/技能`，再点「扫描并导入」
   - 设置 → 添加工具：填快捷指令名（参数用每行 `字段名=说明` 声明）
4. 在「快捷指令」App 里用「运行脚本」动作选中本脚本，即可接给 Siri 使用。

## 文件结构

```
智能体/
├── script.json          脚本元信息
├── index.tsx            入口：打开聊天页
├── chat_page.tsx        聊天 UI（气泡 / 输入栏 / 工具栏 / 抽屉）
├── voice_page.tsx       语音通话模式
├── sidebar.tsx          左侧抽屉
├── avatar.tsx           角色头像（照片 / emoji，选图落盘）
├── config_page.tsx      设置页
├── kb_page.tsx          知识库管理页
├── skills_page.tsx      技能管理页
├── intent.tsx           快捷指令 / Siri 入口
├── live_activity.tsx    灵动岛 Live Activity
├── agent_core.ts        DeepSeek 请求 + 工具循环
├── mcp_client.ts        MCP 客户端（JSON-RPC over Streamable HTTP）
├── kb_store.ts          知识库（bigram + BM25，纯 JS）
├── skills_store.ts      技能导入 / 注册表 / 渐进式披露
└── agent_store.ts       配置 + 会话存储
```

## 数据与隐私

- **API Key 不在本仓库里**：配置存在 `<AppGroup>/Documents/agent/config.json`，会话在 `sessions.json`，知识库索引在 `kb/index.json`，技能在 `skills.json` + `skills/<id>/`。仓库只含代码。
- 头像照片只存在本机 `<AppGroup>/Documents/agent/avatar.png`（不会上传；选图时的暂存文件 `avatar-pending.png` 在取消或保存后会被清掉）。
- 网络请求只发往你自己配置的接口（DeepSeek / 你填的 MCP 服务器）。
- 知识库检索**完全在本机**完成，不调用任何模型或第三方服务。
- 会话历史默认只保留最近 50 条（可配置），不会无限增长。

## 开发

```
scripting-ts project "智能体" --check     # 类型检查，应为 0 报错
scripting-ts preview_ui chat_page.tsx      # 预览 UI
```

## 已知限制

- **快捷指令工具拿不到返回值**（iOS 不提供该能力），参数只能以 JSON 文本单向传过去；需要真实结果请用 MCP 工具。
- MCP 只支持**远程 HTTP 型**，本地 stdio 型（`npx …`）在 iOS 沙箱里无法运行。
- 知识库 PDF 需为**可选中文字**的电子版，扫描件抽不出文本。
- 文本聊天不朗读；朗读只在语音通话模式与 Siri 入口。
- 工具栏按钮只能是文字（Scripting 会丢弃 `systemImage`）。

## License

私有项目，未获授权请勿分发。
