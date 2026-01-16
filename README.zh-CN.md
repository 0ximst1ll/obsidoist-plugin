# Obsidoist

[English](README.md)

Obsidoist 是一个在 Obsidian 里用纯文本管理 Todoist 任务的插件。

你可以直接用 Markdown 任务清单来写任务、完成任务，并与 Todoist 双向同步。

当前项目采用 **本地优先（local-first）** 的同步模式：任务先缓存在本地、修改先落本地并进入待同步队列，然后再由后台同步到 Todoist。

## 功能

- Markdown 任务行与 Todoist 双向同步。
- 通过 Markdown 行创建/更新/完成/重新打开任务（用同步标签标记）。
- 通过简单标记设置日期与项目。
- 在 Obsidian 代码块中渲染任务列表（支持 Todoist filter）。
- 本地缓存 + 持久化待同步队列（离线也能继续编辑，联网后再同步）。

## 快速开始

1）安装插件并填写 Todoist API Token。
2）在 Markdown 任务行里添加 `#todoist`。
3）等待自动同步（或点击“Sync now”）。
4）插件会自动追加 `[todoist_id:...]` 来把该行绑定到 Todoist。

## 使用方法

### Markdown 任务行（创建/更新/完成）

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
- 如果任务在 Todoist 端被删除，插件会移除笔记中的 `[todoist_id:...]`，让该行回归普通 Markdown 文本任务。

### 设置日期

日期格式为 `YYYY-MM-DD`：

```md
- [ ] 交报告 🗓 2026-01-16 #todoist
```

可用日历符号：`🗓`、`🗓️`、`📅`。

### 设置项目

用项目名（去掉空格）作为标签（大小写不敏感）：

```md
- [ ] 修复 bug #todoist #Work
- [ ] 买菜 #todoist #Personal
```

如果设置了 `Default Project`，新任务默认创建到该项目；否则创建到 Inbox。

### 渲染任务列表（代码块）

在笔记中插入以下代码块：

```obsidoist
filter: #ObsidianTest
limit: 10
name: 我的任务
```

- `filter:` 为 Todoist 的过滤表达式。
- `limit:`（可选）用于限制最多显示的任务数量。
- 对于 `filter:` 代码块，刷新时会从 Todoist 拉取最新结果并缓存。

## 设置

Obsidian → 设置 → 第三方插件 → Obsidoist。

### Basic
- `Todoist API Token`：在 Todoist 设置 → Integrations 中获取。
- `Default Project`：新任务默认创建到该项目，留空表示 Inbox。
- `Sync Tag`：用于识别需要同步的 markdown 行的标签。

### Sync
- `Codeblock auto refresh (seconds)`：代码块刷新间隔（秒），设置为 `0` 表示关闭。
- `Auto sync interval (seconds)`：后台自动同步间隔（秒），设置为 `0` 表示关闭。
- `Sync now`：立即把本地待同步队列同步到 Todoist，并刷新本地缓存。
- `Sync status`：队列/缓存/最近同步状态。
- `Todoist Sync API`：连通性测试。
- `Use Sync API`：使用 Todoist Sync API 做增量同步。

### Cache
- `Filter cache retention (days)`：filter 结果缓存保留天数（仅影响 filter 缓存，不删除任务本身）。
- `Max cached filters`：最多缓存多少个 filter 结果（LRU）。
- `Maintenance (advanced)`：缓存/队列维护工具。

### Developer
- `Debug logging`：输出更详细的调试日志（默认关闭）。

## 安装

### 推荐方式（Release 包）

1）下载最新 Release。
2）将 `main.js`、`manifest.json`、`styles.css` 复制到：

`<你的 vault>/.obsidian/plugins/obsidoist-plugin/`

3）重启 Obsidian，然后在第三方插件中启用。

### 从源码安装

把仓库 clone 到 `<你的 vault>/.obsidian/plugins/obsidoist-plugin/`，然后执行：

```bash
npm install
npm run build
```

## 开源协议

MIT
