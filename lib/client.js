/**
 * dsh-auto-sync — client half (static bundle).
 *
 * A plain browser script loaded through the client module system
 * (`window.__ModuleLoader__.load`), not a compiled bundle: it receives
 * `require` (the module table, whose `react` seed supplies React) and runs with
 * browser globals available. No build step is involved; edit and reload.
 *
 * It registers one tab in the Plugins settings section
 * (`settings.plugins.tab`) so backups sit beside the shipped plugin tabs:
 *
 * - the remote repository URL, editable and validated on the Host,
 * - one row per backup line with its branch, last success and last error,
 * - the workspace line's source directory,
 * - a button to snapshot immediately.
 *
 * All reads and writes go through the Host at `/api/dsh-auto-sync/*`; nothing
 * here touches the filesystem or git.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    var API = '/api/dsh-auto-sync';
    var STYLE_TAG = 'dsh-auto-sync/settings.css';

    // CSS — injected once, tagged for the module system's style bookkeeping.
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') === null
    ) {
      var style = document.createElement('style');
      style.dataset.plugin = 'dsh-auto-sync';
      style.dataset.pluginCss = STYLE_TAG;
      style.textContent = [
        '.dsas { display: flex; flex-direction: column; gap: 16px; padding: 12px 4px; max-width: 760px; }',
        '.dsas-section { display: flex; flex-direction: column; gap: 8px; }',
        '.dsas-title { font-size: 13px; font-weight: 600; margin: 0; }',
        '.dsas-desc { font-size: 12px; opacity: 0.72; margin: 0; line-height: 1.6; }',
        '.dsas-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
        '.dsas-input { flex: 1 1 320px; min-width: 200px; padding: 6px 8px; border-radius: 6px;',
        '  border: 1px solid var(--dsh-border, rgba(128,128,128,0.35)); background: transparent;',
        '  color: inherit; font: inherit; font-size: 13px; }',
        '.dsas-input:focus { outline: 2px solid var(--dsh-accent, #4d8dff); outline-offset: -1px; }',
        '.dsas-btn { padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px;',
        '  border: 1px solid var(--dsh-border, rgba(128,128,128,0.35)); background: transparent; color: inherit; }',
        '.dsas-btn:hover:not(:disabled) { background: var(--dsh-hover, rgba(128,128,128,0.12)); }',
        '.dsas-btn:disabled { opacity: 0.5; cursor: default; }',
        '.dsas-btn-primary { border-color: var(--dsh-accent, #4d8dff); color: var(--dsh-accent, #4d8dff); }',
        '.dsas-lines { display: flex; flex-direction: column; gap: 1px; border-radius: 8px; overflow: hidden;',
        '  border: 1px solid var(--dsh-border, rgba(128,128,128,0.25)); }',
        '.dsas-line { display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; align-items: center;',
        '  padding: 10px 12px; font-size: 13px; background: var(--dsh-surface, transparent); }',
        '.dsas-line-name { font-weight: 600; }',
        '.dsas-meta { font-size: 12px; opacity: 0.72; }',
        '.dsas-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;',
        '  border: 1px solid currentColor; }',
        '.dsas-badge-on { color: #2f9e44; }',
        '.dsas-badge-off { color: #868e96; }',
        '.dsas-error { color: #e03131; font-size: 12px; white-space: pre-wrap; word-break: break-word; }',
        '.dsas-notice { font-size: 12px; padding: 8px 10px; border-radius: 6px;',
        '  border: 1px solid var(--dsh-border, rgba(128,128,128,0.35)); }',
        '.dsas-notice-error { border-color: #e03131; color: #e03131; }',
        '.dsas-notice-ok { border-color: #2f9e44; color: #2f9e44; }',
        '.dsas-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;',
        '  word-break: break-all; }',
      ].join('\n');
      document.head.appendChild(style);
    }

    /** Human-readable age of a timestamp. */
    function formatAge(iso, t) {
      if (!iso) return t.never;
      var ms = Date.now() - Date.parse(iso);
      if (isNaN(ms)) return t.unknown;
      if (ms < 60000) return t.justNow;
      if (ms < 3600000) return t.minutes(Math.round(ms / 60000));
      if (ms < 86400000) return t.hours(Math.round(ms / 3600000));
      return t.days(Math.round(ms / 86400000));
    }

    function formatMs(ms) {
      if (ms >= 3600000) return Math.round(ms / 3600000) + 'h';
      return Math.round(ms / 60000) + 'm';
    }

    /** Request helper: resolves to { ok, status, data }. */
    function request(path, options) {
      var init = options || {};
      init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
      init.credentials = 'same-origin';
      return fetch(API + path, init)
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
        })
        .catch(function (error) {
          return { ok: false, status: 0, data: { error: String(error && error.message ? error.message : error) } };
        });
    }

    /** Text for the active locale; the Host reports which one it resolved. */
    function strings(locale) {
      var zh = locale === 'zh';
      return {
        zh: zh,
        title: zh ? '自动备份' : 'Automatic backup',
        intro: zh
          ? '把 DSH 的 home 目录（对话记录、记忆、设置、已安装插件）备份到你自己的私有 git 仓库。'
          : 'Back up the DSH home (conversations, memory, settings, installed plugins) to a git repository you own.',
        remote: zh ? '远端仓库' : 'Remote repository',
        remotePlaceholder: zh ? 'git@github.com:you/dsh-backup.git' : 'git@github.com:you/dsh-backup.git',
        remoteHint: zh
          ? '支持 SSH、HTTPS 或本地路径。留空则备份暂停。'
          : 'SSH, HTTPS or a local path. Leave empty to pause backups.',
        save: zh ? '保存' : 'Save',
        saving: zh ? '保存中…' : 'Saving…',
        saved: zh ? '已保存' : 'Saved',
        lines: zh ? '备份线' : 'Backup lines',
        lineNames: { hot: zh ? '热备份' : 'Hot', snapshot: zh ? '快照' : 'Snapshot', workspace: zh ? '工作区' : 'Workspace' },
        enabled: zh ? '已启用' : 'enabled',
        disabled: zh ? '未启用' : 'disabled',
        lastSuccess: zh ? '上次成功' : 'last success',
        never: zh ? '从未' : 'never',
        unknown: zh ? '未知' : 'unknown',
        justNow: zh ? '刚刚' : 'just now',
        minutes: function (n) { return zh ? n + ' 分钟前' : n + ' min ago'; },
        hours: function (n) { return zh ? n + ' 小时前' : n + ' h ago'; },
        days: function (n) { return zh ? n + ' 天前' : n + ' d ago'; },
        every: zh ? '每' : 'every ',
        workspace: zh ? '项目目录' : 'Project directory',
        workspacePlaceholder: zh ? '要同时备份的项目绝对路径' : 'Absolute path of a project to back up too',
        workspaceHint: zh
          ? '填写后项目线会镜像该目录；清空并保存即关闭。'
          : 'Set a path to mirror that directory; clear it to disable the line.',
        manual: zh ? '手动快照' : 'Backup now',
        snapshotting: zh ? '已安排…' : 'Scheduled…',
        snapshotOk: zh ? '已安排一次快照，几秒后刷新查看结果。' : 'A snapshot is scheduled; refresh in a moment.',
        refresh: zh ? '刷新' : 'Refresh',
        gitMissing: zh ? 'git 不可用，备份无法运行。' : 'git is unavailable, so backups cannot run.',
        repoMissing: zh ? 'home 目录还不是 git 仓库。' : 'The home directory is not a git repository yet.',
        notConfigured: zh ? '尚未配置远端仓库，备份处于暂停状态。' : 'No remote configured; backups are paused.',
        configPath: zh ? '配置文件' : 'Config file',
        loadFailed: zh ? '读取配置失败' : 'Could not load the configuration',
        saveFailed: zh ? '保存失败' : 'Save failed',
        header: { hot: zh ? '热备份' : 'Hot', snapshot: zh ? '快照' : 'Snapshot', workspace: zh ? '工作区' : 'Workspace' },
      };
    }

    function Badge(props) {
      return h(
        'span',
        { className: 'dsas-badge ' + (props.on ? 'dsas-badge-on' : 'dsas-badge-off') },
        props.children,
      );
    }

    function LineRow(props) {
      var line = props.line;
      var t = props.t;
      var enabled = line.enabled;
      var statusText = enabled ? t.enabled : t.disabled;
      var detail = [];
      if (enabled) {
        detail.push(line.branch);
        if (line.intervalMs) detail.push(t.every + formatMs(line.intervalMs));
        detail.push(t.lastSuccess + ' ' + formatAge(line.lastSuccessAt, t));
      }
      return h(
        'div',
        { className: 'dsas-line' },
        h('span', { className: 'dsas-line-name' }, t.lineNames[props.name]),
        h(
          'div',
          { className: 'dsas-meta' },
          enabled ? detail.join(' · ') : t.disabled,
          line.lastError
            ? h('div', { className: 'dsas-error' }, String(line.lastError).split('\n')[0])
            : null,
        ),
        h(Badge, { on: enabled }, statusText),
      );
    }

    /** The settings tab. */
    function BackupTab() {
      var state = React.useState(null);
      var data = state[0];
      var setData = state[1];

      var remoteState = React.useState('');
      var remote = remoteState[0];
      var setRemote = remoteState[1];

      var wsState = React.useState('');
      var workspace = wsState[0];
      var setWorkspace = wsState[1];

      var busyState = React.useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];

      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      var loadedState = React.useState(false);
      var loaded = loadedState[0];
      var setLoaded = loadedState[1];

      var load = React.useCallback(function () {
        return request('/status').then(function (result) {
          if (result.ok) {
            setData(result.data);
            setRemote(result.data.remote || '');
            setWorkspace((result.data.lines && result.data.lines.workspace.source) || '');
          } else {
            setNotice({ kind: 'error', text: result.data.error || 'request failed' });
          }
          setLoaded(true);
        });
      }, []);

      React.useEffect(function () {
        void load();
      }, [load]);

      var t = strings(data && data.locale);

      if (!loaded) {
        return h('div', { className: 'dsas' }, h('p', { className: 'dsas-desc' }, t ? t.title : 'dsh-auto-sync'));
      }

      var problems = [];
      if (data && !data.git.available) problems.push(t.gitMissing);
      else if (data && !data.repository && data.remoteConfigured) problems.push(t.repoMissing);
      if (data && !data.remoteConfigured) problems.push(t.notConfigured);

      function submitRemote() {
        setBusy('remote');
        setNotice(null);
        request('/config', { method: 'POST', body: JSON.stringify({ remote: remote.trim() }) })
          .then(function (result) {
            if (result.ok) {
              setData(result.data);
              setWorkspace((result.data.lines && result.data.lines.workspace.source) || '');
              setNotice({ kind: 'ok', text: t.saved });
            } else {
              setNotice({ kind: 'error', text: (result.data && result.data.error) || t.saveFailed });
            }
          })
          .finally(function () {
            setBusy('');
          });
      }

      function submitWorkspace() {
        setBusy('workspace');
        setNotice(null);
        var trimmed = workspace.trim();
        request('/config', {
          method: 'POST',
          body: JSON.stringify({ workspace: { source: trimmed, enabled: trimmed !== '' } }),
        })
          .then(function (result) {
            if (result.ok) {
              setData(result.data);
              setNotice({ kind: 'ok', text: t.saved });
            } else {
              setNotice({ kind: 'error', text: (result.data && result.data.error) || t.saveFailed });
            }
          })
          .finally(function () {
            setBusy('');
          });
      }

      function snapshotNow() {
        setBusy('snapshot');
        setNotice(null);
        request('/snapshot', { method: 'POST' })
          .then(function (result) {
            setNotice(
              result.ok
                ? { kind: 'ok', text: t.snapshotOk }
                : { kind: 'error', text: (result.data && result.data.error) || 'failed' },
            );
            if (result.ok) setTimeout(function () { void load(); }, 4000);
          })
          .finally(function () {
            setBusy('');
          });
      }

      return h(
        'div',
        { className: 'dsas' },
        h('h3', { className: 'dsas-title' }, t.title),
        h('p', { className: 'dsas-desc' }, t.intro),

        problems.length > 0
          ? h(
              'div',
              { className: 'dsas-notice dsas-notice-error' },
              problems.join(' '),
            )
          : null,

        h(
          'div',
          { className: 'dsas-section' },
          h('label', { className: 'dsas-title', htmlFor: 'dsas-remote' }, t.remote),
          h(
            'div',
            { className: 'dsas-row' },
            h('input', {
              id: 'dsas-remote',
              className: 'dsas-input',
              value: remote,
              placeholder: t.remotePlaceholder,
              spellCheck: false,
              disabled: busy === 'remote',
              onChange: function (event) {
                setRemote(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') submitRemote();
              },
            }),
            h(
              'button',
              {
                className: 'dsas-btn dsas-btn-primary',
                type: 'button',
                disabled: busy === 'remote' || remote.trim() === (data.remote || ''),
                onClick: submitRemote,
              },
              busy === 'remote' ? t.saving : t.save,
            ),
          ),
          h('p', { className: 'dsas-desc' }, t.remoteHint),
        ),

        h(
          'div',
          { className: 'dsas-section' },
          h('h4', { className: 'dsas-title' }, t.lines),
          h(
            'div',
            { className: 'dsas-lines' },
            ['hot', 'snapshot', 'workspace'].map(function (name) {
              return h(LineRow, { key: name, name: name, line: data.lines[name], t: t });
            }),
          ),
        ),

        h(
          'div',
          { className: 'dsas-section' },
          h('label', { className: 'dsas-title', htmlFor: 'dsas-workspace' }, t.workspace),
          h(
            'div',
            { className: 'dsas-row' },
            h('input', {
              id: 'dsas-workspace',
              className: 'dsas-input',
              value: workspace,
              placeholder: t.workspacePlaceholder,
              spellCheck: false,
              disabled: busy === 'workspace',
              onChange: function (event) {
                setWorkspace(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') submitWorkspace();
              },
            }),
            h(
              'button',
              {
                className: 'dsas-btn',
                type: 'button',
                disabled:
                  busy === 'workspace' ||
                  workspace.trim() === ((data.lines.workspace && data.lines.workspace.source) || ''),
                onClick: submitWorkspace,
              },
              busy === 'workspace' ? t.saving : t.save,
            ),
          ),
          h('p', { className: 'dsas-desc' }, t.workspaceHint),
        ),

        h(
          'div',
          { className: 'dsas-row' },
          h(
            'button',
            {
              className: 'dsas-btn',
              type: 'button',
              disabled: busy === 'snapshot' || !data.remoteConfigured,
              onClick: snapshotNow,
            },
            busy === 'snapshot' ? t.snapshotting : t.manual,
          ),
          h(
            'button',
            { className: 'dsas-btn', type: 'button', disabled: busy !== '', onClick: function () { void load(); } },
            t.refresh,
          ),
        ),

        notice
          ? h(
              'div',
              {
                className:
                  'dsas-notice ' + (notice.kind === 'ok' ? 'dsas-notice-ok' : 'dsas-notice-error'),
              },
              notice.text,
            )
          : null,

        h('p', { className: 'dsas-desc' }, t.configPath + ': ', h('span', { className: 'dsas-mono' }, data.configPath)),
      );
    }

    var inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'dsh-auto-sync',
            order: 20,
            label: function () {
              return '自动备份';
            },
          },
          BackupTab,
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
