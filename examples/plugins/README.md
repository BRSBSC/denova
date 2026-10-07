# 独立插件示例

这两个包用于验证公开边界，不默认安装。把任一完整目录复制到 Denova 仓库之外，在「扩展 → 安装扩展 → 本地目录」选择它，检查并安装；无需构建或 Node。面板代码只使用公开握手和 `/api/platform/v1`，没有宿主源码导入或管理路由调用。

| 示例 | 用途 | 依赖 |
| --- | --- | --- |
| relationship-map | 手动建立人物及关系、从资料库导入最多 100 条摘要、保存关系图 | 原始 HTTP；必需 assets.read/write，可选 library.read |
| asset-board | 上传媒体、生成文字/图片、保存素材板、采用文字到资料库 | 可选 client.mjs SDK；必需 assets.read/write，其余能力可选 |

安装后在详情「打开插件」选择 Project，也可从写作、游戏或工作台的项目入口打开。同一 Project 的内容共享；不同项目隔离。两种语言和明暗主题跟随宿主。可收起面板，修改后关闭会提示未保存状态。

素材工作台默认允许浏览和上传。要生成内容，先在扩展授权中启用 agents.run/images.generate，在项目插件菜单分别选择文本和图像 profile；密钥始终留在宿主。可取消正在生成的任务，模型问题通过面板回答，关闭消费者会取消其工作。文字通过保存或采纳按钮进入素材板或资料库；生成图片与上传媒体自动保存到当前素材板。第三方副作用不自动重试。

两者以 `format: 1` 的 JSON 保存在项目扩展内容目录，更新通过 revision 校验。遇到未知格式或并发冲突明确报错；重新加载会提示丢弃本地编辑。示例不做破坏性格式迁移。已保存媒体使用 `{kind: "shared", path}`，不持久化 blob URL、端口、凭证或绝对路径。

项目插件菜单的「插件内容」支持导出 ZIP、导入同一插件身份的空目标；已有内容或活动运行时拒绝导入。卸载插件保留这些作品数据。包导出只分发代码，内容导出不携带配置、模型凭证和会话历史。

组合型示例由「创建插件」生成：`extensionassets/starters/plugin` 包含用户命令、草稿面板和 Agent 工具。独立复制此骨架时，还需从 `extensionassets/sdk` 复制 runtime.mjs、client.mjs、client.d.mts，Node 后端要求 22+。面板保存的草稿可由另一 Session 的 read-draft 工具读取。

公开契约见[开发手册](../../docs/plugin-developer-guide.md)与 [HTTP API](../../docs/plugin-platform-api.md)。自动验证见 `web/tests/e2e/plugin-contributions.spec.ts`；测试将目录复制到独立 Project，再通过正常安装、项目配置和界面流程使用。
