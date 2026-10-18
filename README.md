# dsh-auto-sync

[English](README.en.md) | 中文

DeepSeek Harness 插件，将 DSH home 目录自动纳入版本控制并推送到用户自有的 git 远端。

插件把 DSH 写入 home 的内容作为工作树管理：会话记录、记忆文件、设置、profile 插件及其依赖树，另可镜像指定的项目目录。目标远端由用户指定；插件不连接本项目运营的任何服务器，也不携带任何凭据。

---

## 目录

- [备份范围](#备份范围)
- [设计约束](#设计约束)
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

## 备份范围

| 状态 | 典型位置 |
| --- | --- |
| 会话记录 | `<home>/sessions/**` |
| 记忆文件 | `<home>/memories/**`、`<home>/memory/**` |
| 配置 | `<home>/settings.yaml` |
| Profile 插件 | `<home>/profiles/<name>/` |
| 项目工作 | 用户指定的目录（可选） |

凭据文件 `<home>/.credentials.yaml` 默认被排除，见[安全模型](#安全模型)。

## 设计约束

1. **存储位置由用户控制。** 远端为普通 git 仓库：私有 GitHub 或 GitLab 仓库、内网服务器、NAS 上的裸仓库。
2. **失败必须可见。** 停止工作却没有提示的备份工具比没有备份更糟。每次运行的结果都会记录；备份线超过 48 小时未成功会在 DSH 日志中报告。

---

## 工作原理

插件经 profile 的 bundle 层注册，运行在宿主进程中。它只负责调度：热备份线在进程内完成小规模提交，完整快照以分离进程运行，避免应用退出截断快照。

```text
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

每条备份线独占一个分支和一份独立的 git 工作区副本，因此任意两条线不会争用同一个 index——这是并发备份产生 `index.lock: File exists` 的原因。退出时的快照不会与热备份提交冲突。

配置按以下优先级读取：

1. profile 补丁中 Cordis 条目的 `config`；
2. `<home>/sync-plugin/config.json`；
3. 内置默认值。

配置文件已声明的键优先于补丁层：插件管理器会重写 profile 补丁，而配置文件由用户维护。

---

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | `>= 0.2.0-rc.2` | 声明为可选 peer，不阻止更高版本 |
| Node.js | `^22.19 \|\| >= 24` | 随 DSH 安装提供 |
| git | 2.30+ | 须在 `PATH` 中，启动时探测 |

目录镜像、加锁与进程管理均由 Node 内置模块实现，不调用平台特化工具。

---

## 安装

### 从桌面应用安装

1. 在侧栏打开**插件**页。
2. 选择**添加插件**，填入本目录的绝对路径。
3. 启用 `dsh-auto-sync` 组合包。
4. 重启 DeepSeek Harness。

### 从命令行安装

```sh
dsh plugin --profile desktop add link:/path/to/dsh-auto-sync
```

---

## 首次运行

首次启动且无配置时，插件写入一份带说明的模板到 `<home>/sync-plugin/config.json`，并记录一条警告：在设置 `remote` 之前备份处于暂停状态。

设置远端有两种方式。

命令方式（无需重启）：

```text
/dsh-sync setup git@github.com:you/dsh-backup.git
```

编辑配置文件后重启：

```json
{
  "remote": "git@github.com:you/dsh-backup.git"
}
```

下次启动时，插件初始化仓库、为每条启用的备份线创建分支与工作区副本，并开始备份。

---

## `/dsh-sync` 命令

需要 profile 提供 `commands` 服务（Web 与桌面 profile 提供，headless 与 ACP profile 不提供）。

| 命令 | 行为 |
| --- | --- |
| `/dsh-sync` | 报告远端、各备份线及上次成功时间 |
| `/dsh-sync setup [地址]` | 设置远端并执行首次初始化 |
| `/dsh-sync remote <地址>` | 仅修改远端，不改动分支 |
| `/dsh-sync lines` | 列出备份线及其分支 |
| `/dsh-sync workspace <路径>` | 启用项目线并指定目录 |
| `/dsh-sync workspace off` | 关闭项目线 |
| `/dsh-sync run` | 立即安排一次快照 |
| `/dsh-sync doctor` | 诊断 git、仓库、分支与工作区副本 |

命令产生的修改均写回配置文件，结果可 diff。

### 界面语言

命令输出与首次引导支持中文与英文，取值顺序为：配置中的 `locale` → 环境变量 `DSH_AUTO_SYNC_LOCALE` → DSH 界面语言（宿主提供时）→ 默认 `en`。日志信息固定为英文，便于在 issue 中引用。

---

## 设置页

桌面版与 Web 版的「设置 → 插件」提供**自动备份**页签，与斜杠命令读写同一份配置文件：

- 填写或修改远端地址；首次配置保存后立即执行初始化，无需重启；
- 查看各备份线的分支、启用状态、上次成功时间与最后一次错误；
- 指定同时备份的项目目录，清空即关闭项目线；
- 手动触发一次快照。

实现分为两部分：

| 部分 | 文件 | 职责 |
| --- | --- | --- |
| Host | `lib/api.mjs` | 在 `webServer` 上注册路由并校验、持久化 |
| Client | `lib/client.js` | 浏览器脚本，注册 `settings.plugins.tab` 页签 |

客户端为无构建步骤的原生浏览器脚本，经 `window.__ModuleLoader__.load` 加载并复用宿主提供的 React。

### 接口

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/dsh-auto-sync/status` | GET | 配置、各线状态、git 可用性 |
| `/api/dsh-auto-sync/config` | POST | 校验并保存远端、语言、间隔、项目目录 |
| `/api/dsh-auto-sync/snapshot` | POST | 立即安排快照（未配置远端时返回 409） |

接口只处理页面使用的字段，其余键原样保留。写操作要求 `Origin` 与 `Host` 同源，不一致返回 403。

不提供 `webServer` 的 profile 不注册这些路由，插件其余功能不受影响。

---

## 配置

配置文件位于 `<home>/sync-plugin/config.json`。

### 顶层键

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `remote` | `string` | `""` | 备份远端地址，必填。支持 SSH 与 HTTPS。 |
| `remoteName` | `string` | `"origin"` | `origin` 已指向其他仓库时使用的远端名。 |
| `worktree` | `string` | `<home>-backup` | 各备份线工作区副本的父目录，须位于 home 之外。 |
| `locale` | `string` | `"zh"` | 命令与引导语言：`zh` 或 `en`。 |
| `exclude` | `string[]` | 见下文 | 追加到 home `.gitignore` 的忽略规则。 |
| `userName` | `string` | `"dsh-auto-sync"` | git 未配置身份时使用的提交者名称。 |
| `userEmail` | `string` | `"dsh-auto-sync@localhost"` | 同上，邮箱。 |
| `home` | `string` | `$DSH_HOME` 或 `~/.dsh` | 覆盖 home 目录；显式 `--home` 优先于环境变量。 |

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

每条线均接受 `enabled` 与 `branch`。

**`lines.hot`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `paths` | `[".sync-status.json"]` | 每轮对话后提交的文件，相对 home；解析到 home 之外的路径会被拒绝。 |
| `debounceMs` | `30000` | 最后一轮对话结束后的静默期。 |
| `intervalMs` | `900000` | 无条件刷新间隔，保证长时间工具调用期间状态仍能落盘。 |

**`lines.snapshot`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `intervalMs` | `86400000` | 完整快照间隔。 |
| `profile` | `"desktop"` | 纳入依赖树的 profile。 |
| `includeNodeModules` | `true` | 在快照中重新纳入该 profile 的 `node_modules`。 |
| `files` | 清单文件列表 | 与依赖树一同镜像的 profile 文件。 |

**`lines.workspace`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 未设置 `source` 时该线保持空闲。 |
| `source` | `""` | 要镜像的项目目录绝对路径。 |
| `exclude` | `[".git", "node_modules", "dist", "build", "target", ".cache"]` | 递归时跳过的目录或文件；设置后完全取代默认值。 |

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

频繁变化的小文件。文件复制进该线的工作区副本后提交并推送。默认在对话轮结束后 30 秒触发，并有 15 分钟下限，保证长时间工具调用期间状态仍能落盘。

### `snapshot` → `dsh-snapshot`

home 的完整镜像，附带所配置 profile 的依赖清单与依赖树。`link:` 依赖按清单条目记录，克隆后由包管理器恢复；已发布依赖固化进分支。

运行时机：每日一次、退出时一次，以及启动时发现上次快照早于间隔的补跑。重复重启会重置倒计时，补跑避免了该问题。

### `workspace` → `dsh-workspace`

镜像指定的项目目录，使代码与其描述状态一同版本化。默认关闭。构建产物与依赖缓存被排除，排除列表可配置。

### `release` → GitHub Release 资产

完整备份的另一种形态：将 home 打包为 `tar.gz` 并作为 release 资产发布。

两种完整备份并存的原因：

| | `snapshot`（分支） | `release`（资产） |
| --- | --- | --- |
| 存储 | 每个版本进入 git 历史 | 每个版本一个压缩包 |
| 成本 | 每次提交涉及数万文件 | 单个压缩文件 |
| 恢复 | `git checkout` | 下载解压，无需插件 |
| 长期保留 | 历史持续增长 | 保留最近 N 份 |

日常增量使用 `snapshot`，长期归档与灾难恢复使用 `release`。

以 3.4 GB 的 home 实测（排除依赖），归档体积约 369 MiB。

```json
"release": {
  "enabled": true,
  "repo": "",
  "tagPrefix": "dsh-backup-",
  "keep": 5,
  "intervalMs": 604800000,
  "includeNodeModules": false,
  "includeSecrets": false,
  "partSizeBytes": 1500000000
}
```

- `repo` 为空时由 git 远端推导为 `owner/name`。
- 超过 `partSizeBytes` 时分割为 `.part000`、`.part001` 等，并生成记录各部分 sha256 的 `manifest.json`。
- `keep` 限制保留数量；超出时优先删除较早的 tag，且仅考虑带本线 `tagPrefix` 的 tag。
- `.credentials.yaml` 默认排除；`includeSecrets: true` 会将其打入归档，在公开仓库上等同于泄露密钥。

上传前可先预演：

```sh
node release-backup.mjs --dry-run
```

输出归档体积、分片数与目标仓库。

传输在 GitHub CLI 存在时使用 `gh`，否则使用 REST API 加 token。该顺序是必要的：在 TLS 中间人代理环境下，Node 的 `fetch` 会因 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 失败，而 `gh` 使用独立的信任链。REST 路径的 token 依次取自 `DSH_AUTO_SYNC_GITHUB_TOKEN`、`GITHUB_TOKEN`、`gh auth token`。

---

## 恢复

恢复整个 home：

```sh
git clone <远端地址> ~/.dsh
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
git clone --branch dsh-workspace <远端地址> project
```

`git log dsh-snapshot -- <路径>` 给出单个文件的修订历史。

---

## 安全模型

**默认排除凭据。** 首次运行时插件把 `.credentials.yaml` 及以上规则写入 home 的 `.gitignore`。该文件保存服务商 API Key，不应推送。

**接管而非覆盖已有仓库。** home 已是带远端的 git 仓库时，其历史与远端配置原样保留；插件只新增分支与工作区副本，不重写、变基或强推历史，也不修改已指向其他位置的远端。

**从不强推。** 推送被拒绝时合并远端顶端并重试一次，冲突以本地快照为准。历史只增不改。

**配置无法导出 home 之外的文件。** `lines.hot.paths` 相对 home 解析，越界即拒绝。

**对会话失败开放。** 备份错误不会进入会话事件链；失败通过状态文件与日志上报，对话照常进行。

---

## 运行行为

### 并发

每条线独占工作区副本与 index。快照脚本获取锁文件，重叠触发（定时器、启动补跑、退出钩子）串行执行。超过一小时的锁视为废弃。

### 失败处理

| 情况 | 行为 |
| --- | --- |
| `git` 缺失 | 启动检查报告；备份暂停 |
| `remote` 未设置 | 写入模板；备份暂停并告警 |
| 推送被拒绝 | 合并远端顶端后重试一次；不强推 |
| 工作区副本缺失 | 报告；重启 DSH 后重建 |
| 工作区副本检出了其他分支 | 拒绝接管，避免两个分支共用一份快照 |
| 提交身份缺失 | 回退到配置的 `userName` / `userEmail` |

### 可观测性

`<home>/sync-plugin/status.json` 按线记录上次成功时间与最后一次错误：

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

超过 48 小时未成功的备份线在启动时报告到 DSH 日志。

---

## 排错

**备份暂停，`remote` 为空。**
在 `<home>/sync-plugin/config.json` 中设置 `remote` 后重启 DSH，或执行 `/dsh-sync setup <地址>`。

**推送报 `could not read Username`。**
插件运行环境没有终端，git 无法交互输入。配置免口令 SSH key，或预先保存凭据到 credential helper。

**出现 `index.lock: File exists`。**
本插件按设计避免同一 index 上的并发。出现该错误说明上一个 DSH 进程未正常退出，删除对应工作区副本 `.git` 目录下的陈旧锁文件。

**快照线未运行。**
确认 `lines.snapshot.enabled`，检查 `status.json`。常见原因为 `PATH` 中缺少 `git`，启动时会报告。

**工作区副本因检出其他分支被拒绝。**
插件不会接管检出了其他分支的目录。将 `worktree` 指向其他位置，或删除该陈旧目录。

**中文命令输出未生效。**
确认 `locale` 为 `"zh"`，或设置 `DSH_AUTO_SYNC_LOCALE=zh`。

---

## 开发

仓库无运行时依赖。测试在系统临时目录中创建一次性仓库，并对推送到远端的内容断言，包含反向用例：密钥、日志与构建产物不得出现在任何分支。

```sh
node tests/e2e.mjs           # 初始化、热提交、快照、推送
node tests/verify-remote.mjs # 对远端实际内容断言
node tests/edge.mjs          # 项目线、接管已有仓库、未配置启动、路径逃逸
node tests/onboard.mjs       # 远端校验、引导消息、命令、中英文一致性
node tests/api.mjs           # 设置页接口：校验、持久化、跨站拦截
node tests/client.mjs        # 客户端脚本：模块工厂、页签注册
```

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口：调度、热备份线、生命周期 |
| `cold-sync.mjs` | 分离进程中的快照线 |
| `workspace-sync.mjs` | 项目镜像线 |
| `release-backup.mjs` | Release 归档线 |
| `lib/config.mjs` | 默认值、分层、首次运行模板 |
| `lib/setup.mjs` | 仓库初始化、接管、忽略规则、工作区副本 |
| `lib/onboard.mjs` | 首次引导与 `/dsh-sync` 命令 |
| `lib/i18n.mjs` | 中英文案 |
| `lib/api.mjs` | 设置页 Host 端路由 |
| `lib/client.js` | 设置页浏览器端 |
| `lib/git.mjs` | git 封装 |
| `lib/copy.mjs` | 跨平台目录镜像 |
| `lib/status.mjs` | 状态上报 |
| `lib/exec.mjs` | 进程辅助 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
