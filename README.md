# dsh-auto-sync

[English](README.en.md) | 中文

> 把 DeepSeek Harness 的 home 目录自动、带版本地备份到**你自己的**私有 git 仓库。

`dsh-auto-sync` 是一个 DeepSeek Harness 插件。它把 DSH 写在 home 目录下的所有内容纳入版本控制：对话记录、记忆文件、设置、已安装插件及其依赖树，全部提交并推送到你掌控的远端。换电脑、配置损坏、升级翻车，都能在几分钟内恢复。

插件不携带任何凭据，也没有默认目标。它不会连接本项目运营的任何服务器；它唯一认识的远端，就是你配置的那个。

---

## 目录

- [为什么需要它](#为什么需要它)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [首次运行](#首次运行)
- [`/dsh-sync` 命令](#dsh-sync-命令)
- [设置页](#设置页)
- [配置](#配置)
- [备份线](#备份线)
- [恢复](#恢复)
- [安全模型](#安全模型)
- [运行行为](#运行行为)
- [排错](#排错)
- [开发](#开发)
- [许可](#许可)

---

## 为什么需要它

DeepSeek Harness 的状态散落在好几处，丢了很难重建：

| 状态 | 典型位置 | 为什么重要 |
| --- | --- | --- |
| 会话记录 | `<home>/sessions/**` | 每一次对话的完整历史 |
| 记忆文件 | `<home>/memories/**`、`<home>/memory/**` | 长期积累的上下文与项目知识 |
| 凭据与设置 | `<home>/settings.yaml`、`<home>/.credentials.yaml` | 服务商、模型、偏好 |
| Profile 插件 | `<home>/profiles/<name>/` | 已安装的组合包、lockfile、本地补丁 |
| 项目工作 | 你指定的任意目录 | 当时正在写的代码 |

这些内容大多只存在于本机、没有文档，而插件树手工重建代价很高。`dsh-auto-sync` 把 home 当作一个工作树，把它变成可持久化、可恢复的产物。

有两个特性是刻意设计的：

1. **存储始终由你掌控。** 目标是一个普通 git 远端：私有 GitHub / GitLab 仓库、内网服务器，或 NAS 上的裸仓库。
2. **失败一定可见。** 悄悄停止工作的备份工具比没有备份更糟。每次运行都会记录结果，备份线过期会在 DSH 日志里报告。

---

## 工作原理

插件通过 profile 的 bundle 层注册，运行在宿主进程中。它只负责调度，不在内联路径上执行 git 操作：小而频繁的状态在进程内提交，完整快照则以分离进程运行，这样关闭应用不会把快照截断。

```
                    ┌──────────────────────────────┐
   turn/end ───────▶│  热备份线（进程内）           │──▶ 分支  dsh-hot
   定时 ───────────▶│  复制 → 提交 → 推送           │
                    └──────────────────────────────┘

                    ┌──────────────────────────────┐
   定时 ───────────▶│  cold-sync.mjs（分离进程）    │──▶ 分支  dsh-snapshot
   关闭 ───────────▶│  镜像 → 提交 → 推送           │
                    └──────────────────────────────┘
                                  │
                                  └───────────────▶ workspace-sync.mjs
                                                    分支  dsh-workspace
```

每条线独占一个分支和一份**独立的 git 工作区副本**，因此任意两条线都不会争用同一个 index——那正是并发备份时产生 `index.lock: File exists` 的根本原因。也正因如此，关闭时触发的快照不可能和热备份提交撞车。

配置分两层读取，优先级明确：

1. profile 补丁里 Cordis 条目的 `config`——适合按 profile 固定某些值；
2. `<home>/sync-plugin/config.json`——人手动编辑的长期副本；
3. 内置默认值。

对于文件层声明了的所有键，文件层优先于补丁层。原因是插件管理器会重写 profile 补丁，而配置文件由人手写。

---

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | `>= 0.2.0-rc.2` | 声明为可选 peer，不会拦住更新的版本 |
| Node.js | `^22.19 \|\| >= 24` | DSH 安装中已自带 |
| git | 2.30+ | 必须在 `PATH` 中，启动时会探测 |

插件跨平台。它不依赖任何平台特有工具：目录镜像、加锁、进程管理都用 Node 自带模块实现，而不是调用 shell 工具。

---

## 安装

### 从桌面应用安装

1. 在侧栏打开**插件**。
2. 选择**添加插件**，填入本目录的绝对路径。
3. 启用 `dsh-auto-sync` 组合包。
4. 重启 DeepSeek Harness。

### 从命令行安装

```sh
dsh plugin --profile desktop add link:/本目录的绝对路径/dsh-auto-sync
```

---

## 首次运行

首次启动且没有任何配置时，插件会把一份带说明的模板写到
`<home>/sync-plugin/config.json`，并记录一条警告，说明在你设置 `remote`
之前备份处于暂停状态。

完成配置有两种方式：

**用命令**——无需重启：

```text
/dsh-sync setup git@github.com:you/dsh-backup.git
```

**手动编辑**——填写远端后重启：

```json
{
  "remote": "git@github.com:you/dsh-backup.git"
}
```

下次启动时，插件会初始化仓库、为每条启用的备份线创建分支和工作区副本，然后开始备份。

---

## `/dsh-sync` 命令

只要 profile 提供 `commands` 服务就有这个命令（Web 与桌面 profile 有，headless 与 ACP profile 没有）。

| 命令 | 效果 |
| --- | --- |
| `/dsh-sync` | 报告远端、各备份线，以及各自上次成功时间 |
| `/dsh-sync setup [地址]` | 设置远端并执行首次初始化 |
| `/dsh-sync remote <地址>` | 只修改远端，不动分支 |
| `/dsh-sync lines` | 列出备份线及其分支 |
| `/dsh-sync workspace <路径>` | 启用项目线，指定要备份的项目目录 |
| `/dsh-sync workspace off` | 关闭项目线 |
| `/dsh-sync run` | 立刻安排一次快照 |
| `/dsh-sync doctor` | 诊断 git、仓库、分支与工作区副本 |

通过命令做的每一次修改都会写回配置文件，因此结果是可见、可 diff 的，而不是只存在于界面状态里。

### 界面语言

命令输出与首次引导支持中文和英文，按以下顺序决定：

1. 配置里的 `locale`（`zh` 或 `en`）；
2. 环境变量 `DSH_AUTO_SYNC_LOCALE`；
3. DSH 自身的界面语言（宿主提供时）；
4. 默认 `en`。

日志信息始终是英文，这样贴到 issue 里的报错谁都能读。

---

## 设置页

在桌面版或 Web 版里，`设置 → 插件` 会多出一个**自动备份**页签，和斜杠命令读写同一份配置文件：

- 填写或修改远端仓库地址（保存后，首次配置会立刻执行初始化，不用重启）
- 查看三条备份线的分支、启用状态、上次成功时间与最后一次错误
- 指定要同时备份的项目目录，清空即关闭项目线
- 一键手动快照

实现上分两半：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `lib/api.mjs` | 在 `webServer` 上注册三个同名路由，校验并落盘 |
| Client | `lib/client.js` | 浏览器脚本，注册 `settings.plugins.tab` 页签 |

客户端是**手写的普通浏览器脚本**，通过 `window.__ModuleLoader__.load` 加载，直接使用宿主提供的 React——**不需要任何构建步骤**，改完刷新即可看到效果。

### 接口

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/dsh-auto-sync/status` | GET | 返回配置、三条线状态、git 可用性 |
| `/api/dsh-auto-sync/config` | POST | 校验并保存远端、语言、备份线间隔、项目目录 |
| `/api/dsh-auto-sync/snapshot` | POST | 立刻安排一次快照（未配置远端时返回 409） |

接口只接受页面会用到的字段，其余键原样保留，因此手写在配置文件里的自定义内容不会被界面弄丢。

**跨站防护**：写操作要求 `Origin` 头与 `Host` 同源，不一致直接 403。这样别的网站无法借用户浏览器触发备份写入。

没有 `webServer` 的 profile（headless、CLI）不会注册这些路由，页面自然也不存在——插件本身照常工作。

---

## 配置

配置文件位于 `<home>/sync-plugin/config.json`。

### 顶层键

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `remote` | `string` | `""` | 备份远端地址。**必填。** SSH 与 HTTPS 均可。 |
| `remoteName` | `string` | `"origin"` | 当 `origin` 已指向其他仓库时使用的远端名。 |
| `worktree` | `string` | `<home>-backup` | 各备份线工作区副本的父目录。必须**位于 home 之外**。 |
| `locale` | `string` | `"zh"` | 命令与引导文案语言：`zh` 或 `en`。 |
| `exclude` | `string[]` | 见下文 | 追加到 home `.gitignore` 的额外忽略规则。 |
| `userName` | `string` | `"dsh-auto-sync"` | 提交者名称，仅在 git 没有配置身份时使用。 |
| `userEmail` | `string` | `"dsh-auto-sync@localhost"` | 提交者邮箱，同上。 |
| `home` | `string` | `$DSH_HOME` 或 `~/.dsh` | 覆盖 home 目录。显式 `--home` 优先于环境变量。 |

默认忽略规则：

```text
.credentials.yaml
**/node_modules/
*.log
.DS_Store
Thumbs.db
sync-plugin/.sync-status.json
memory/memory.db-shm
memory/memory.db-wal
```

### 备份线键

每条线都接受 `enabled` 和 `branch`，此外还有：

**`lines.hot`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `paths` | `[".sync-status.json"]` | 每轮对话后提交的文件，相对 home。解析到 home 之外的路径会被拒绝。 |
| `debounceMs` | `30000` | 最后一个对话轮结束后的静默期。 |
| `intervalMs` | `900000` | 无条件刷新间隔，让长时间运行的工具调用也能落盘。 |

**`lines.snapshot`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `intervalMs` | `86400000` | 完整快照间隔。 |
| `profile` | `"desktop"` | 纳入哪份 profile 的依赖树。 |
| `includeNodeModules` | `true` | 尽管 home 层排除了 `node_modules`，仍在快照中重新纳入该 profile 的依赖。 |
| `files` | 清单文件列表 | 与依赖树一同镜像的 profile 文件。 |

**`lines.workspace`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 在指定 `source` 之前，这条线保持空闲。 |
| `source` | `""` | 要镜像的项目目录的绝对路径。 |
| `exclude` | `[".git", "node_modules", "dist", "build", "target", ".cache"]` | 递归时按名称跳过的目录/文件。一旦设置便完全取代默认值。 |

### 示例

```json
{
  "remote": "git@github.com:you/dsh-backup.git",
  "worktree": "/home/you/.dsh-backup",
  "locale": "zh",
  "lines": {
    "hot": {
      "intervalMs": 900000,
      "paths": [".sync-status.json"]
    },
    "snapshot": {
      "intervalMs": 43200000,
      "profile": "desktop",
      "includeNodeModules": true
    },
    "workspace": {
      "enabled": true,
      "source": "/home/you/projects/app",
      "exclude": [".git", "node_modules", "dist"]
    }
  }
}
```

---

## 备份线

### `hot` → `dsh-hot`

小而频繁变化的状态。文件被复制进该线的工作区副本，提交并推送。默认节奏是对话轮结束后 30 秒，并有 15 分钟下限，保证长时间的工具序列期间状态也能落盘。

### `snapshot` → `dsh-snapshot`

home 的完整镜像，外加所配置 profile 的依赖清单与已安装依赖树。这条线才是让一台机器可恢复的关键。`link:` 依赖按清单条目记录，克隆后用包管理器恢复；已发布的依赖则直接固化进分支。

每日运行一次、关闭时运行一次，并在启动后发现上次快照早于间隔时补跑一次——否则反复重启会把倒计时一直重置，永远到不了这条线。

### `workspace` → `dsh-workspace`

镜像一个项目目录，让正在写的代码和描述它的状态一起被版本化。默认关闭。构建产物与依赖缓存会被排除；排除列表可配置。

---

## 恢复

恢复整个 home：

```sh
git clone <你的远端> ~/.dsh
cd ~/.dsh
git checkout dsh-snapshot
dsh plugin --profile desktop install
```

恢复单个文件：

```sh
git show dsh-snapshot:sessions/2026-01-01/....jsonl > restored.jsonl
```

恢复项目：

```sh
git clone --branch dsh-workspace <你的远端> project
```

`git log dsh-snapshot -- <路径>` 能给出任意单个文件的修订历史，这让备份不仅能当灾备，也能当恢复工具用。

---

## 安全模型

**默认排除密钥。** 首次运行时，插件会把 `.credentials.yaml` 及上文列出的其他规则写进 home 的 `.gitignore`。`.credentials.yaml` 保存服务商 API Key，绝不能推送上去。

**已有仓库是接管，不是覆盖。** 如果 home 已经是带远端的 git 仓库，它的历史和远端配置都会原样保留。插件只添加分支和工作区副本。它从不重写、变基或强推已有历史，也从不改动已指向别处的远端。

**从不强推。** 推送被拒绝时会先合并远端顶端再重试一次，冲突以本地快照为准。从插件视角看，历史只增不改。

**配置无法外泄文件。** `lines.hot.paths` 会相对 home 解析，超出 home 即拒绝，所以一份写错的配置无法把备份线变成任意文件复制器。

**插件对会话是失败开放。** 任何错误都不会抛进会话事件链。备份失败会被记录并上报，对话照常进行；失败通过状态文件和日志暴露，而不是通过中断聊天。

---

## 运行行为

### 并发

每条线独占工作区副本与 index。快照脚本会获取锁文件，因此重叠触发（定时器、启动补跑、关闭钩子）会串行执行，而不是破坏进行中的提交。超过一小时的锁视为已废弃。

### 失败处理

| 情况 | 行为 |
| --- | --- |
| `git` 缺失 | 启动检查报告；备份暂停 |
| `remote` 未设置 | 写入模板；备份暂停并明确告警 |
| 推送被拒绝 | 合并远端顶端后重试一次；从不强推 |
| 工作区副本缺失 | 报告；重启 DSH 即可重建 |
| 工作区副本检出的是别的分支 | 拒绝接管，避免两个分支共用一份快照 |
| 提交身份缺失 | 回退到配置的 `userName` / `userEmail` |

### 可观测性

`<home>/sync-plugin/status.json` 按线记录上次成功时间与最后一次错误信息：

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "lines": {
    "hot": { "lastSuccessAt": "2026-01-01T00:00:00.000Z" },
    "snapshot": { "lastSuccessAt": "2026-01-01T00:00:00.000Z" },
    "workspace": { "lastError": "push failed", "lastErrorAt": "2026-01-01T00:00:00.000Z" }
  }
}
```

超过 48 小时未成功的备份线会在启动时报告到 DSH 日志。

---

## 排错

**备份暂停：`remote` 为空。**
在 `<home>/sync-plugin/config.json` 里设置 `remote`，或运行 `/dsh-sync setup <地址>`。

**推送失败并提示 `could not read Username`。**
插件在没有终端的环境下运行，git 无法弹出提示。请配置无口令的 SSH key，或让 credential helper 已保存 token。

**出现 `index.lock: File exists`。**
这是同一 index 上并发运行的结果，本插件在设计上已经避免。如果出现，说明上一个 DSH 进程没有正常退出：删除对应工作区副本 `.git` 目录下的陈旧锁文件即可。

**快照线从不运行。**
确认 `lines.snapshot.enabled`，并查看 `status.json`。最常见的原因是 `PATH` 里没有 `git`，启动时会报告。

**工作区副本因检出其他分支被拒绝。**
插件不会接管检出了别的分支的目录。把 `worktree` 指向别处，或删除该陈旧目录。

**中文命令输出没有生效。**
检查配置里的 `locale` 是否为 `"zh"`，或设置环境变量 `DSH_AUTO_SYNC_LOCALE=zh`。

---

## 开发

仓库本身没有任何运行时依赖。测试会在系统临时目录下建立一次性仓库，并对最终推送到远端的内容做断言，包括反向用例：密钥、日志、构建产物绝不能出现在任何分支上。

```sh
node tests/e2e.mjs           # 完整流程：初始化、热提交、快照、推送
node tests/verify-remote.mjs # 对远端实际内容做断言
node tests/edge.mjs          # 项目线、接管已有仓库、未配置启动、路径逃逸
node tests/onboard.mjs       # 远端校验、引导消息、/dsh-sync 命令、中英文一致性
node tests/api.mjs           # 设置页接口：校验、写盘、跨站拦截、幂等注册
node tests/client.mjs        # 客户端脚本：模块工厂、slot 注册、样式注入
```

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口：调度、热备份线、生命周期 |
| `cold-sync.mjs` | 分离进程中的快照线 |
| `workspace-sync.mjs` | 项目镜像线 |
| `lib/config.mjs` | 默认值、分层、首次运行模板 |
| `lib/setup.mjs` | 仓库初始化、接管、忽略规则、工作区副本 |
| `lib/onboard.mjs` | 首次引导与 `/dsh-sync` 命令 |
| `lib/i18n.mjs` | 中英双语文案 |
| `lib/api.mjs` | 设置页的 Host 端路由 |
| `lib/client.js` | 设置页的浏览器端 |
| `lib/git.mjs` | git 封装 |
| `lib/copy.mjs` | 跨平台目录镜像 |
| `lib/status.mjs` | 状态上报 |
| `lib/exec.mjs` | 进程辅助 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
