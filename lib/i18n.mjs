/**
 * User-facing text for the command surface and first-run guidance.
 *
 * Two dictionaries exist because the plugin is published to a bilingual
 * audience: the repository documentation is Chinese-first while the code is
 * English-first, and a person who installed the plugin may speak either. The
 * active language follows, in order:
 *
 *   1. `locale` in the config file / profile patch (`zh` or `en`),
 *   2. `DSH_AUTO_SYNC_LOCALE`,
 *   3. the DSH UI locale when the host provides one,
 *   4. `en` (the language the source is written in).
 *
 * Only text that a person reads is translated. Log messages stay in English so
 * that a bug report pasted into an issue is readable by anyone.
 *
 * @module dsh-auto-sync/lib/i18n
 */

/** Supported locales. */
export const LOCALES = /** @type {const} */ (['zh', 'en']);

/**
 * @typedef {typeof DICTIONARIES.en} Dict
 */

/** @type {Record<'zh' | 'en', Record<string, any>>} */
export const DICTIONARIES = {
  en: {
    onboarding: {
      title: '**dsh-auto-sync is installed but not finished setting up.**',
      body: [
        'It backs up your DeepSeek Harness home (conversations, memory, settings,',
        'installed plugins) to a git repository you own. Nothing is uploaded until',
        'you name that repository.',
      ],
      nextStep: (step) => `Next step: ${step}`,
      configFile: (path) => `Config file: \`${path}\``,
      runAnyTime: (command) => `Run \`/${command}\` at any time to see what is configured.`,
      missingGit: (reason) => `install git and make sure it is on PATH (${reason})`,
      missingRemote: (command) => `run \`/${command} setup <your-private-repo-url>\``,
      missingRepo: () => 'restart DSH so the first-run setup creates the repository',
    },
    remote: {
      required: 'a remote URL is required',
      whitespace: 'a remote URL cannot contain whitespace',
      shape: 'expected an ssh URL, an https URL, or a local path',
    },
    status: {
      title: '**dsh-auto-sync status**',
      remote: 'Remote',
      home: 'Home',
      worktree: 'Worktree',
      config: 'Config',
      notConfigured: '_(not configured)_',
      line: 'Line',
      enabled: 'Enabled',
      branch: 'Branch',
      lastSuccess: 'Last success',
      yes: 'yes',
      no: 'no',
      never: 'never',
      justNow: 'just now',
      minutesAgo: (n) => `${n} min ago`,
      hoursAgo: (n) => `${n} h ago`,
      unknown: 'unknown',
      lastErrors: '**Last errors**',
      hint: (command) =>
        `Run \`/${command} setup\` again to re-run the first-run setup, or \`/${command} run\` to snapshot now.`,
    },
    setup: {
      noRemote: (command) =>
        `No remote is configured. Run \`/${command} setup <your-private-repo-url>\`.`,
      failed: (message) => `Setup failed: ${message}`,
      title: '**dsh-auto-sync is set up.**',
      backingUp: (home, remote) => `Backing up \`${home}\` to \`${remote}\`.`,
      hotLine: (branch) => `Hot line: ${branch} (after each turn)`,
      snapshotLine: (branch) => `Snapshot line: ${branch} (daily and on shutdown)`,
      workspaceLine: (branch) => `Workspace line: ${branch}`,
      workspaceDisabled: 'Workspace line: disabled',
      workspaceHint: (command) =>
        `Run \`/${command} workspace <path>\` to also back up a project directory.`,
    },
    remoteUpdate: {
      current: (remote) => `The current remote is \`${remote}\`.`,
      none: 'No remote is configured.',
      updated: (remote) => `Remote updated to \`${remote}\`. Restart DSH to apply it.`,
    },
    lines: {
      title: '**Backup lines**',
      row: (name, branch, enabled) =>
        `- **${name}** -> branch \`${branch}\`, ${enabled ? 'enabled' : 'disabled'}`,
      hint: 'Edit the intervals and paths in the config file.',
      names: { hot: 'hot', snapshot: 'snapshot', workspace: 'workspace', release: 'release' },
    },
    workspace: {
      enabled: (source) => `The workspace line mirrors \`${source}\`.`,
      disabled: (command) =>
        `The workspace line is disabled. Run \`/${command} workspace <absolute-path>\` to enable it.`,
      nowDisabled: 'The workspace line is now disabled.',
      missing: (path) => `\`${path}\` does not exist.`,
      nowEnabled: (path, branch) =>
        `The workspace line now mirrors \`${path}\` to branch \`${branch}\` on the next snapshot.`,
    },
    run: {
      needRemote: (command) => `Configure a remote first: \`/${command} setup <url>\`.`,
      scheduled: 'A snapshot has been scheduled; it runs in the background.',
    },
    release: {
      usage: (command) =>
        [
          `Usage: \`/${command} release on\`, \`/${command} release off\`, or \`/${command} release now\`.`,
          '',
          'The release line packs the home into an archive and publishes it as a downloadable release asset.',
        ].join('\n'),
      notConfigured: (command) =>
        `Set \`lines.release.repo\` to "owner/name" (or a git remote) and enable the line with \`/${command} release on\`.`,
      nowEnabled: (prefix) =>
        `The release line is enabled: tags start with \`${prefix}\` and it runs on its weekly interval. Run \`/dsh-sync release now\` to publish one immediately.`,
      nowDisabled: 'The release line is now disabled. Existing releases are kept.',
      scheduled: 'A release archive is being built and uploaded in the background.',
    },
    doctor: {
      title: '**dsh-auto-sync doctor**',
      gitOk: (version) => `git: \`${version}\``,
      gitMissing: (reason) => `git: **missing** (${reason})`,
      repository: (ok) => `home repository: ${ok ? 'yes' : '**no**'}`,
      configured: (ok) => `remote configured: ${ok ? 'yes' : '**no**'}`,
      topLevel: (path) => `repository toplevel: \`${path}\``,
      branchPresent: (branch) => `branch \`${branch}\`: present`,
      branchMissing: (branch) => `branch \`${branch}\`: **missing**`,
      worktrees: (count) => `worktrees: ${count}`,
      nextStep: (step) => `Next step: ${step}`,
    },
    help: {
      unknown: (verb) => `Unknown subcommand \`${verb}\`.`,
      usage: [
        (c) => `- \`/${c}\` — status`,
        (c) => `- \`/${c} setup <remote-url>\` — configure and run the first-run setup`,
        (c) => `- \`/${c} remote <remote-url>\` — change the remote only`,
        (c) => `- \`/${c} lines\` — list the backup lines`,
        (c) => `- \`/${c} workspace <path>|off\` — enable or disable the project line`,
        (c) => `- \`/${c} run\` — snapshot now`,
        (c) => `- \`/${c} doctor\` — diagnose the chain`,
      ],
    },
  },

  zh: {
    onboarding: {
      title: '**dsh-auto-sync 已安装，但还没有配置完成。**',
      body: [
        '它会把 DeepSeek Harness 的 home 目录（对话记录、记忆、设置、已安装插件）',
        '备份到你自己的 git 仓库。在你填上仓库地址之前，不会有任何内容被上传。',
      ],
      nextStep: (step) => `下一步：${step}`,
      configFile: (path) => `配置文件：\`${path}\``,
      runAnyTime: (command) => `随时运行 \`/${command}\` 查看当前配置。`,
      missingGit: (reason) => `安装 git 并确保它在 PATH 中（${reason}）`,
      missingRemote: (command) => `运行 \`/${command} setup <你的私有仓库地址>\``,
      missingRepo: () => '重启 DSH，首次初始化会创建仓库',
    },
    remote: {
      required: '必须提供远端仓库地址',
      whitespace: '远端地址中不能包含空白字符',
      shape: '需要 ssh 地址、https 地址，或本地路径',
    },
    status: {
      title: '**dsh-auto-sync 状态**',
      remote: '远端仓库',
      home: 'Home 目录',
      worktree: '工作区副本',
      config: '配置文件',
      notConfigured: '_(未配置)_',
      line: '备份线',
      enabled: '已启用',
      branch: '分支',
      lastSuccess: '上次成功',
      yes: '是',
      no: '否',
      never: '从未',
      justNow: '刚刚',
      minutesAgo: (n) => `${n} 分钟前`,
      hoursAgo: (n) => `${n} 小时前`,
      unknown: '未知',
      lastErrors: '**最近的错误**',
      hint: (command) =>
        `运行 \`/${command} setup\` 可重新执行初始化，或 \`/${command} run\` 立刻做一次快照。`,
    },
    setup: {
      noRemote: (command) => `还没有配置远端仓库。运行 \`/${command} setup <你的私有仓库地址>\`。`,
      failed: (message) => `初始化失败：${message}`,
      title: '**dsh-auto-sync 已配置完成。**',
      backingUp: (home, remote) => `正在把 \`${home}\` 备份到 \`${remote}\`。`,
      hotLine: (branch) => `热备份线：${branch}（每轮对话后）`,
      snapshotLine: (branch) => `快照线：${branch}（每日及关闭时）`,
      workspaceLine: (branch) => `项目线：${branch}`,
      workspaceDisabled: '项目线：未启用',
      workspaceHint: (command) => `运行 \`/${command} workspace <路径>\` 可以同时备份某个项目目录。`,
    },
    remoteUpdate: {
      current: (remote) => `当前远端仓库是 \`${remote}\`。`,
      none: '还没有配置远端仓库。',
      updated: (remote) => `远端仓库已更新为 \`${remote}\`，重启 DSH 后生效。`,
    },
    lines: {
      title: '**备份线**',
      row: (name, branch, enabled) =>
        `- **${name}** -> 分支 \`${branch}\`，${enabled ? '已启用' : '未启用'}`,
      hint: '间隔与路径请在配置文件中修改。',
      names: { hot: '热备份', snapshot: '快照', workspace: '工作区', release: '发布包' },
    },
    workspace: {
      enabled: (source) => `项目线当前镜像 \`${source}\`。`,
      disabled: (command) =>
        `项目线未启用。运行 \`/${command} workspace <绝对路径>\` 可以启用。`,
      nowDisabled: '项目线已关闭。',
      missing: (path) => `\`${path}\` 不存在。`,
      nowEnabled: (path, branch) => `项目线现在会把 \`${path}\` 镜像到分支 \`${branch}\`，下次快照生效。`,
    },
    run: {
      needRemote: (command) => `请先配置远端仓库：\`/${command} setup <地址>\`。`,
      scheduled: '已安排一次快照，正在后台执行。',
    },
    release: {
      usage: (command) =>
        [
          `用法：\`/${command} release on\`、\`/${command} release off\`，或 \`/${command} release now\`。`,
          '',
          '发布包线会把整个 home 打包成一个归档文件，作为可下载的 release 附件备份。',
        ].join('\n'),
      notConfigured: (command) =>
        `请把 \`lines.release.repo\` 设为 "所有者/仓库名"（或配置 git 远端），再用 \`/${command} release on\` 启用。`,
      nowEnabled: (prefix) =>
        `发布包线已启用：标签以 \`${prefix}\` 开头，按每周间隔运行。用 \`/dsh-sync release now\` 可立刻发布一个。`,
      nowDisabled: '发布包线已关闭，已有的 release 会保留。',
      scheduled: '正在后台打包并上传 release 归档。',
    },
    doctor: {
      title: '**dsh-auto-sync 诊断**',
      gitOk: (version) => `git：\`${version}\``,
      gitMissing: (reason) => `git：**不可用**（${reason}）`,
      repository: (ok) => `home 仓库：${ok ? '已存在' : '**不存在**'}`,
      configured: (ok) => `远端配置：${ok ? '已配置' : '**未配置**'}`,
      topLevel: (path) => `仓库根目录：\`${path}\``,
      branchPresent: (branch) => `分支 \`${branch}\`：存在`,
      branchMissing: (branch) => `分支 \`${branch}\`：**缺失**`,
      worktrees: (count) => `工作区副本：${count} 个`,
      nextStep: (step) => `下一步：${step}`,
    },
    help: {
      unknown: (verb) => `未知子命令 \`${verb}\`。`,
      usage: [
        (c) => `- \`/${c}\` — 查看状态`,
        (c) => `- \`/${c} setup <远端地址>\` — 配置并执行初始化`,
        (c) => `- \`/${c} remote <远端地址>\` — 只修改远端地址`,
        (c) => `- \`/${c} lines\` — 列出备份线`,
        (c) => `- \`/${c} workspace <路径>|off\` — 启用或关闭项目线`,
        (c) => `- \`/${c} run\` — 立刻做一次快照`,
        (c) => `- \`/${c} doctor\` — 诊断备份链路`,
      ],
    },
  },
};

/**
 * Resolve the active locale from the explicit setting and the host.
 *
 * @param {{locale?: unknown}} [config]
 * @param {string | undefined} [hostLocale] - the DSH UI locale, when available.
 * @returns {'zh' | 'en'}
 */
export function resolveLocale(config = {}, hostLocale = undefined) {
  /** @param {unknown} value */
  const normalize = (value) => {
    if (typeof value !== 'string') return undefined;
    const tag = value.trim().toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
    return undefined;
  };
  return (
    normalize(config.locale) ??
    normalize(process.env.DSH_AUTO_SYNC_LOCALE) ??
    normalize(hostLocale) ??
    'en'
  );
}

/**
 * @param {'zh' | 'en'} locale
 * @returns {Dict}
 */
export function dictionary(locale) {
  return DICTIONARIES[locale] ?? DICTIONARIES.en;
}
