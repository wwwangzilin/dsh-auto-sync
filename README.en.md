# dsh-auto-sync

English | [中文](README.md)

DeepSeek Harness plugin that keeps the DSH home directory under version control and pushes it to a git remote you own.

The plugin manages everything DSH writes under its home as a working tree: session logs, memory files, settings, profile plugins and their dependency trees, plus an optional mirror of a project directory. The destination is a remote you configure; the plugin contacts no server operated by this project and ships no credentials.

---

## Contents

- [Scope](#scope)
- [Design constraints](#design-constraints)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [First run](#first-run)
- [The `/dsh-sync` command](#the-dsh-sync-command)
- [Settings page](#settings-page)
- [Configuration](#configuration)
- [Backup lines](#backup-lines)
- [Restoring](#restoring)
- [Security model](#security-model)
- [Operational behaviour](#operational-behaviour)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Scope

| State | Typical location |
| --- | --- |
| Session logs | `<home>/sessions/**` |
| Memory files | `<home>/memories/**`, `<home>/memory/**` |
| Settings | `<home>/settings.yaml` |
| Profile plugins | `<home>/profiles/<name>/` |
| Project work | a directory you specify (optional) |

The credentials file `<home>/.credentials.yaml` is excluded by default; see [Security model](#security-model).

## Design constraints

1. **Storage stays under your control.** The destination is an ordinary git remote: a private GitHub or GitLab repository, an internal server, or a bare repository on a NAS.
2. **Failures are visible.** A backup tool that stops working without a report is worse than none. Every run records its outcome, and a line that has not succeeded for more than 48 hours is reported in the DSH log.

---

## How it works

The plugin registers with the profile's bundle layer and runs inside the host process. It schedules work only: the hot line commits small changes in-process, while full snapshots run detached so an application shutdown cannot truncate them.

```text
                    ┌──────────────────────────────┐
   turn/end ───────▶│  hot line  (in-process)      │──▶ branch  dsh-hot
   interval ───────▶│  copy → commit → push        │
                    └──────────────────────────────┘

                    ┌──────────────────────────────┐
   interval ───────▶│  cold-sync.mjs  (detached)   │──▶ branch  dsh-snapshot
   shutdown ───────▶│  mirror → commit → push      │
                    └──────────────────────────────┘
                                  │
                                  └───────────────▶ workspace-sync.mjs
                                                     branch  dsh-workspace
```

Each line owns a branch and a separate git worktree, so no two lines contend for one index — the condition that produces `index.lock: File exists` under concurrent backups. A snapshot taken on shutdown therefore cannot collide with a hot commit.

Configuration is resolved in this order:

1. the Cordis entry's `config` in the profile patch;
2. `<home>/sync-plugin/config.json`;
3. built-in defaults.

A key stated in the config file takes precedence over the patch layer, because the plugin manager rewrites profile patches while the config file is maintained by hand.

---

## Requirements

| Component | Version | Notes |
| --- | --- | --- |
| DeepSeek Harness | `>= 0.2.0-rc.2` | Declared as an optional peer; newer releases are not blocked |
| Node.js | `^22.19 \|\| >= 24` | Included with a DSH installation |
| git | 2.30+ | Must be on `PATH`; probed at startup |

Directory mirroring, locking and process handling are implemented with Node built-in modules rather than platform utilities.

---

## Installation

### From the desktop application

1. Open **Plugins** in the sidebar.
2. Choose **Add plugin** and enter the absolute path of this directory.
3. Enable the `dsh-auto-sync` bundle.
4. Restart DeepSeek Harness.

### From the CLI

```sh
dsh plugin --profile desktop add link:/path/to/dsh-auto-sync
```

### First run

On the first start without configuration, the plugin writes a documented template to `<home>/sync-plugin/config.json` and logs a warning stating that backups are paused until `remote` is set.

The remote can be set in two ways.

Through the command, without a restart:

```text
/dsh-sync setup git@github.com:you/dsh-backup.git
```

By editing the file and restarting:

```json
{
  "remote": "git@github.com:you/dsh-backup.git"
}
```

On the next start the plugin initialises the repository, creates one branch and worktree per enabled line, and begins backing up.

### The `/dsh-sync` command

Available when the profile provides the `commands` service (the Web and desktop profiles do; headless and ACP profiles do not).

| Command | Effect |
| --- | --- |
| `/dsh-sync` | Report the remote, the lines, and the last success per line |
| `/dsh-sync setup [url]` | Set the remote and run the first-run setup |
| `/dsh-sync remote <url>` | Change the remote only, leaving branches untouched |
| `/dsh-sync lines` | List the backup lines and their branches |
| `/dsh-sync workspace <path>` | Enable the workspace line for a project directory |
| `/dsh-sync workspace off` | Disable the workspace line |
| `/dsh-sync run` | Schedule a snapshot immediately |
| `/dsh-sync doctor` | Diagnose git, the repository, the branches and the worktrees |

Every change made through the command is written to the config file, so the result is visible and diffable.

### Interface language

Command output and first-run guidance are available in Chinese and English, resolved in this order: `locale` in the config (`zh` or `en`), then the `DSH_AUTO_SYNC_LOCALE` environment variable, then the DSH UI locale when the host exposes one, then `en`. Log messages remain in English so a report pasted into an issue is readable by anyone.

---

## Settings page

In the desktop and Web profiles, **Settings → Plugins** gains an **Automatic backup** tab that reads and writes the same config file as the slash command:

- edit the remote repository URL; saving it during first-time setup runs the setup immediately, with no restart
- see each backup line's branch, enabled state, last success and last error
- name a project directory to back up as well; clearing it disables the line
- run a snapshot on demand

The feature has two halves:

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `lib/api.mjs` | Registers the routes on `webServer` and validates and persists input |
| Client | `lib/client.js` | Browser script registering a `settings.plugins.tab` tab |

The client half is a plain browser script loaded through `window.__ModuleLoader__.load`, reusing the React instance the host provides. There is no build step.

### Routes

| Route | Method | Effect |
| --- | --- | --- |
| `/api/dsh-auto-sync/status` | GET | Configuration, per-line status, git availability |
| `/api/dsh-auto-sync/config` | POST | Validate and persist the remote, locale, intervals and workspace |
| `/api/dsh-auto-sync/snapshot` | POST | Schedule a snapshot now (409 when no remote is set) |

Only the fields the page owns are accepted; every other key in the file is preserved. Mutating requests must carry an `Origin` matching `Host` and are otherwise refused with 403.

A profile without a `webServer` registers no routes; the rest of the plugin is unaffected.

---

## Configuration

The configuration file is `<home>/sync-plugin/config.json`.

### Top-level keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `remote` | `string` | `""` | URL of the backup remote. Required. SSH and HTTPS are both accepted. |
| `remoteName` | `string` | `"origin"` | Remote name used when `origin` already points at a different repository. |
| `worktree` | `string` | `<home>-backup` | Parent directory for the per-line checkouts. Must be outside the home. |
| `locale` | `string` | `"zh"` | Language of command output and onboarding text: `zh` or `en`. |
| `exclude` | `string[]` | see below | Additional ignore patterns appended to the home's `.gitignore`. |
| `userName` | `string` | `"dsh-auto-sync"` | Commit author used when git has no identity configured. |
| `userEmail` | `string` | `"dsh-auto-sync@localhost"` | Commit email, same condition. |
| `home` | `string` | `$DSH_HOME` or `~/.dsh` | Overrides the home directory. An explicit `--home` wins over the environment variable. |

Default exclusions:

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

### Backup line keys

Each line accepts `enabled` and `branch`.

**`lines.hot`**

| Key | Default | Description |
| --- | --- | --- |
| `paths` | `[".sync-status.json"]` | Files, relative to the home, committed after each turn. Paths resolving outside the home are refused. |
| `debounceMs` | `30000` | Quiet period after the last completed turn. |
| `intervalMs` | `900000` | Unconditional refresh, so a long tool run still commits. |

**`lines.snapshot`**

| Key | Default | Description |
| --- | --- | --- |
| `intervalMs` | `86400000` | Full snapshot interval. |
| `profile` | `"desktop"` | Profile whose dependency tree is included. |
| `includeNodeModules` | `true` | Re-include the profile's `node_modules` despite the home-level exclusion. |
| `files` | manifest list | Profile files mirrored alongside the dependency tree. |

**`lines.workspace`**

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | The line stays idle until a `source` is named. |
| `source` | `""` | Absolute path of the project directory to mirror. |
| `exclude` | `[".git", "node_modules", "dist", "build", "target", ".cache"]` | Names skipped anywhere in the tree. Replaces the defaults entirely when set. |

### Example

```json
{
  "remote": "git@github.com:you/dsh-backup.git",
  "worktree": "/home/you/.dsh-backup",
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

## Backup lines

### `hot` → `dsh-hot`

Small, frequently changing state. Files are copied into the line's worktree, committed and pushed. The default cadence is 30 seconds after a turn ends, with a 15-minute floor so state still lands during a long-running tool sequence.

### `snapshot` → `dsh-snapshot`

A full mirror of the home plus the configured profile's dependency manifest and dependency tree. `link:` dependencies are recorded by manifest entry and restored by a package manager after a clone; published dependencies are vendored into the branch.

Runs daily, on shutdown, and once shortly after startup when the previous snapshot is older than the interval, so repeated restarts do not reset the countdown indefinitely.

### `workspace` → `dsh-workspace`

Mirrors one project directory so that the code being worked on is versioned alongside the state describing it. Disabled by default. Build output and dependency caches are excluded, and the exclusion list is configurable.

### `release` → GitHub Release asset

The second form of full backup: the whole home packed into a `tar.gz` and published as a release asset.

Both full-backup forms exist for different reasons:

| | `snapshot` (branch) | `release` (asset) |
| --- | --- | --- |
| Storage | every version enters git history | one archive per version |
| Cost | tens of thousands of files per commit | one compressed file |
| Restore | `git checkout` | download and extract, no plugin needed |
| Retention | history grows without bound | keep N, prune the rest |

Use `snapshot` for routine increments and `release` for long-term archives and disaster recovery. On a 3.4 GB home with dependencies excluded, the archive measured approximately 369 MiB.

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

- An empty `repo` is derived from the git remote as `owner/name`.
- An archive larger than `partSizeBytes` is split into `.part000`, `.part001`, … with a `manifest.json` recording each part's sha256.
- `keep` bounds retention; older tags are deleted first, and only tags with this line's `tagPrefix` are considered.
- `.credentials.yaml` is excluded by default. `includeSecrets: true` packs it into the archive, which on a public repository amounts to a key leak.

The archive can be built without uploading:

```sh
node release-backup.mjs --dry-run
```

It reports the archive size, the part count and the destination repository.

Transport uses the GitHub CLI when present and the REST API with a token otherwise. That order is deliberate: behind a TLS-intercepting proxy, Node's `fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while `gh` uses its own trust chain. The REST path reads the token from `DSH_AUTO_SYNC_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`.

---

## Restoring

Restore an entire home:

```sh
git clone <remote-url> ~/.dsh
cd ~/.dsh
git checkout dsh-snapshot
dsh plugin --profile desktop install
```

Restore a single file:

```sh
git show dsh-snapshot:sessions/2026-01-01/....jsonl > restored.jsonl
```

Restore a project:

```sh
git clone --branch dsh-workspace <remote-url> project
```

`git log dsh-snapshot -- <path>` yields the revision history of any individual file.

---

## Security model

**Secrets are excluded by default.** On first run the plugin adds `.credentials.yaml` and the patterns listed above to the home's `.gitignore`. That file holds provider API keys and must not be pushed.

**Existing repositories are adopted, not taken over.** If the home is already a git repository with a remote, its history and remote configuration are left untouched. The plugin adds branches and worktrees only; it never rewrites, rebases or force-pushes existing history, and never changes a remote that already points elsewhere.

**Nothing is force-pushed.** A rejected push is retried once after integrating the remote tip, with the local snapshot winning conflicts.

**Configuration cannot exfiltrate files.** `lines.hot.paths` are resolved against the home and refused when they escape it.

**The plugin fails open for the session.** No error is thrown into the session event chain; a failing backup is logged and recorded while the conversation continues.

---

## Operational behaviour

### Concurrency

Every line owns an independent worktree and index. The snapshot script takes a lock file, so overlapping triggers (timer, startup catch-up, shutdown) serialise instead of corrupting an in-flight commit. A lock older than one hour is treated as abandoned.

### Failure handling

| Condition | Behaviour |
| --- | --- |
| `git` missing | Reported at startup; backups paused |
| `remote` unset | Template written; backups paused with an explicit warning |
| Push rejected | One retry after merging the remote tip; nothing force-pushed |
| Worktree missing | Reported; recreated by restarting DSH |
| Worktree holds a different branch | Refused rather than adopted, so two branches never share one snapshot |
| Commit identity missing | Falls back to the configured `userName` / `userEmail` |

### Observability

`<home>/sync-plugin/status.json` records, per line, the timestamp of the last success and the last error:

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

A line that has not succeeded for 48 hours is reported in the DSH log at startup.

---

## Troubleshooting

**Backups paused, `remote` is empty.**
Set `remote` in `<home>/sync-plugin/config.json` and restart DSH, or run `/dsh-sync setup <url>`.

**Push fails with `could not read Username`.**
The plugin runs without a terminal, so git cannot prompt. Configure a passphrase-free SSH key, or a credential helper that already holds a token.

**`index.lock: File exists`.**
The plugin avoids concurrent runs against one index by design. This error indicates a previous DSH process did not exit cleanly; remove the stale lock under that worktree's `.git` directory.

**The snapshot line never runs.**
Check `lines.snapshot.enabled` and inspect `status.json`. A `git` binary missing from `PATH` is the most common cause and is reported at startup.

**A worktree is refused because it holds another branch.**
The plugin will not adopt a directory checked out on a different branch. Point `worktree` elsewhere or remove the stale directory.

**Chinese command output does not appear.**
Confirm that `locale` is `"zh"`, or set `DSH_AUTO_SYNC_LOCALE=zh`.

---

## Development

The repository has no runtime dependencies. Tests build throwaway repositories under the system temporary directory and assert the resulting remote contents, including negative cases: secrets, logs and build output must never appear on any branch.

```sh
node tests/e2e.mjs           # setup, hot commit, snapshot, push
node tests/verify-remote.mjs # assertions over what landed on the remote
node tests/edge.mjs          # workspace line, adoption, unconfigured start, path escape
node tests/onboard.mjs       # remote validation, onboarding message, command, locale parity
node tests/api.mjs           # settings routes: validation, persistence, origin fence
node tests/client.mjs        # client script: module factory, tab registration
```

| Path | Responsibility |
| --- | --- |
| `index.js` | Plugin entry: scheduling, hot line, lifecycle |
| `cold-sync.mjs` | Detached snapshot line |
| `workspace-sync.mjs` | Project mirror line |
| `release-backup.mjs` | Release archive line |
| `lib/config.mjs` | Defaults, layering, first-run template |
| `lib/setup.mjs` | Repository initialisation, adoption, ignore rules, worktrees |
| `lib/onboard.mjs` | First-run guidance and the `/dsh-sync` command |
| `lib/i18n.mjs` | Chinese and English user-facing text |
| `lib/api.mjs` | Settings-page Host routes |
| `lib/client.js` | Settings-page browser half |
| `lib/git.mjs` | Git facade |
| `lib/copy.mjs` | Cross-platform directory mirroring |
| `lib/status.mjs` | Status reporting |
| `lib/exec.mjs` | Process helpers |

---

## License

MIT. See [LICENSE](LICENSE).
