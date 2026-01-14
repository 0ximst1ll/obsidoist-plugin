# Obsidoist

[English](README.md)

一个在 Obsidian 中管理 Todoist 任务的插件。

当前项目采用 **本地优先（local-first）** 的同步模式：任务先缓存在本地、修改先落本地并进入待同步队列，然后再由后台同步到 Todoist。

## 功能

- 在 Obsidian 代码块中渲染 Todoist 任务列表。
- 通过 markdown 任务行（配合同步标签）创建/更新/完成任务。
- 本地缓存 + 持久化待同步队列（离线可用）。
- 可配置自动同步间隔，并支持设置页手动同步。

## 使用方法

### 1）渲染任务列表（代码块）

在笔记中插入以下代码块：

```obsidoist
filter: #ObsidianTest
limit: 10
name: 我的任务
```

- `filter:` 为 Todoist 的过滤表达式。
- `limit:`（可选）用于限制最多显示的任务数量。
- 列表默认从本地缓存渲染；点击右上角刷新按钮会执行同步并拉取该 filter 的远端结果，然后缓存并重新渲染。

### 2）通过 markdown 任务行参与同步

用同步标签（默认：`#todoist`）标记需要同步的任务行：

```md
- [ ] 买牛奶 #todoist
- [x] 交房租 #todoist
```

同步后插件会在行尾追加一个 ID 标记，用于把该行绑定到 Todoist 任务：

```md
- [ ] 买牛奶 #todoist [todoist_id:123456789]
```

说明：

- 新建任务在还没成功创建到 Todoist 前，可能会先写入本地临时 ID，例如 `[todoist_id:local-...]`。
- 后续同步成功后会自动替换为真实的远端 ID。

## 设置

Obsidian → 设置 → 第三方插件 → Obsidoist。

- `Todoist API Token`：在 Todoist 设置 → Integrations 中获取。
- `Sync Tag`：用于识别需要同步的 markdown 行的标签。
- `Default Project`：新任务默认创建到该项目，留空表示 Inbox。
- `Auto sync interval (seconds)`：自动同步间隔（秒），设置为 `0` 表示关闭后台自动同步。
- `Sync now`：立即把本地待同步队列 push 到 Todoist，并刷新本地缓存。

## 当前同步策略（简述）

- 插件在本地持久化保存任务与项目缓存。
- 创建/编辑/完成等操作会先更新本地缓存并写入待同步队列。
- 后台按设置的间隔将队列同步到 Todoist，并拉取远端更新回本地。
- codeblock 从本地缓存渲染；对于 `filter:` 代码块，刷新按钮会拉取远端 filter 结果并缓存。
- 在 codeblock 中勾选完成/取消完成会立即同步到 Todoist。

## 开发

```bash
npm install
npm run build
```

## 限制

- 目前还没有把 Todoist 的“历史已完成/归档”完整镜像到本地（取决于可用 API）。
- `filter:` 代码块会在刷新后缓存远端过滤结果；离线时会展示最近一次缓存的结果。
