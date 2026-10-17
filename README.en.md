# dsh-auto-sync

English | [中文](README.md)

> Automatic, versioned backup of your DeepSeek Harness home — to **your own**
> private git repository.

`dsh-auto-sync` is a DeepSeek Harness plugin that keeps everything DSH writes
under its home directory under version control. Conversations, memory files,
settings, installed plugins and their dependency trees are committed and pushed
to a remote you control, so a lost laptop, a corrupted profile or a failed
upgrade is recoverable in minutes.

The plugin ships no credentials and no default destination. It never talks to a
server operated by this project; the only remote it knows about is the one you
configure.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [First run](#first-run)
- [The `/dsh-sync` command](#the-dsh-sync-command)
- [Interface language](#interface-language)
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

## Why this exists

DeepSeek Harness keeps state in several places that are easy to lose and
awkward to reconstruct:

| State | Typical location | Why it matters |
| --- | --- | --- |
| Session logs | `<home>/sessions/**` | The full history of every conversation |
| Memory files | `<home>/memories/**`, `<home>/memory/**` | Accumulated context and project knowledge |
| Credentials and settings | `<home>/settings.yaml`, `<home>/.credentials.yaml` | Providers, models, preferences |
| Profile plugins | `<home>/profiles/<name>/` | Installed bundles, lockfiles, local patches |
| Project work | any directory you choose | Source code you were working on |

Most of this is machine-local and undocumented, and the plugin trees are
expensive to rebuild by hand. `dsh-auto-sync` treats the home as a working tree
and turns it into a durable, restorable artifact.

Two properties are deliberate:

1. **Storage stays under your control.** The destination is an ordinary git
   remote: a private GitHub or GitLab repository, an internal review server, or
   a bare repository on a NAS.
2. **Failures are visible.** A backup tool that stops working silently is worse
   than no backup tool. Every run records its outcome, and a stale line is
   reported in the DSH log.

---

## How it works

The plugin registers with the profile's bundle layer and runs inside the host
process. It schedules work; it does not perform git operations inline. Small,
frequent state is committed in-process, while full snapshots run detached so a
shutdown does not truncate them.

```
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

Each line owns a branch and a **separate git worktree**, so no two lines ever
compete for one index — the failure mode that produces
`index.lock: File exists` under concurrent backups. A detached shutdown snapshot
therefore cannot collide with a hot commit.

Configuration is read from two layers, with a defined precedence:

1. the Cordis entry's `config` in the profile patch — convenient for pinning
   values per profile;
2. `<home>/sync-plugin/config.json` — the long-lived copy a person edits;
3. built-in defaults.

The file layer wins over the patch layer for any key it states, because the
plugin manager rewrites profile patches while the config file is authored by
hand.

---

## Requirements

| Component | Version | Notes |
| --- | --- | --- |
| DeepSeek Harness | `>= 0.2.0-rc.2` | Declared as an optional peer; newer releases are not blocked |
| Node.js | `^22.19 \|\| >= 24` | Already present in a DSH installation |
| git | 2.30+ | Must be on `PATH`; probed at startup |

The plugin is cross-platform. It has no platform-specific dependencies: the
directory mirroring, locking and process handling are implemented with Node's
own modules rather than shell utilities.

---

## Installation

### From the desktop application

1. Open **Plugins** in the sidebar.
2. Choose **Add plugin** and enter the absolute path of this directory.
3. Enable the `dsh-auto-sync` bundle.
4. Restart DeepSeek Harness.

### From the CLI

```sh
dsh plugin --profile desktop add link:/absolute/path/to/dsh-auto-sync
```

### First run

On the first start with no configuration present, the plugin writes a
documented template to `<home>/sync-plugin/config.json` and logs a warning
explaining that backups are paused until `remote` is set.

You can finish setup either through the slash command or by editing the file.

**Through the command** — no restart needed:

```text
/dsh-sync setup git@github.com:you/dsh-backup.git
```

**By hand** — fill in the remote and restart:

```json
{
  "remote": "git@github.com:you/dsh-backup.git"
}
```

On the next start the plugin initialises the repository, creates one branch and
worktree per enabled line, and begins backing up.

### The `/dsh-sync` command

Available whenever the profile provides the `commands` service (the Web and
desktop profiles do; headless and ACP profiles do not).

| Command | Effect |
| --- | --- |
| `/dsh-sync` | Report the remote, the lines, and the last success per line |
| `/dsh-sync setup [url]` | Set the remote and run the first-run setup |
| `/dsh-sync remote <url>` | Change the remote only, leaving branches alone |
| `/dsh-sync lines` | List the backup lines and their branches |
| `/dsh-sync workspace <path>` | Enable the workspace line for a project directory |
| `/dsh-sync workspace off` | Disable the workspace line |
| `/dsh-sync run` | Schedule a snapshot immediately |
| `/dsh-sync doctor` | Diagnose git, the repository, the branches and the worktrees |

Every change made through the command is written to the config file, so the
result is visible and diffable rather than implied by UI state.

### Interface language

Command output and first-run guidance are available in Chinese and English,
resolved in this order:

1. `locale` in the config (`zh` or `en`),
2. the `DSH_AUTO_SYNC_LOCALE` environment variable,
3. the DSH UI locale, when the host exposes one,
4. `en`.

Log messages stay in English so a report pasted into an issue is readable by
anyone.

---

## Settings page

In the desktop and Web profiles, **Settings → Plugins** gains an **Automatic
backup** tab. It reads and writes the same config file as the slash command:

- edit the remote repository URL (saving it for a first-time install runs the
  setup immediately, with no restart)
- see each backup line's branch, enabled state, last success and last error
- name a project directory to back up too; clearing it disables the line
- run a snapshot on demand

It is split in two halves:

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `lib/api.mjs` | Registers three same-origin routes on `webServer` |
| Client | `lib/client.js` | Browser script registering a `settings.plugins.tab` tab |

The client half is a **plain browser script** loaded through
`window.__ModuleLoader__.load`, using the React the host already provides —
**there is no build step**; edit it and reload.

### Routes

| Route | Method | Effect |
| --- | --- | --- |
| `/api/dsh-auto-sync/status` | GET | Config, per-line status, git availability |
| `/api/dsh-auto-sync/config` | POST | Validate and persist the remote, locale, intervals, workspace |
| `/api/dsh-auto-sync/snapshot` | POST | Schedule a snapshot now (409 when no remote is set) |

Only the fields the page owns are accepted; every other key in the file is
preserved, so hand-written content survives a round trip through the UI.

**Cross-origin fence:** mutating requests must carry an `Origin` that matches
`Host`, otherwise they are refused with 403. Another site cannot drive backups
through the user's browser.

A profile without a `webServer` (headless, CLI) registers no routes, so there is
no page to serve; the plugin itself is unaffected.

---

## Configuration

The configuration file lives at `<home>/sync-plugin/config.json`.

### Top-level keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `remote` | `string` | `""` | URL of the backup remote. **Required.** SSH and HTTPS are both accepted. |
| `remoteName` | `string` | `"origin"` | Remote name used when `origin` already points at a different repository. |
| `worktree` | `string` | `<home>-backup` | Parent directory for the per-line checkouts. Must be **outside** the home. |
| `exclude` | `string[]` | see below | Additional ignore patterns appended to the home's `.gitignore`. |
| `userName` | `string` | `"dsh-auto-sync"` | Commit author, used only when git has no identity configured. |
| `userEmail` | `string` | `"dsh-auto-sync@localhost"` | Commit email, same condition. |
| `locale` | `string` | `"zh"` | Language of the command output and onboarding text: `zh` or `en`. |
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

Each line accepts `enabled` and `branch`, plus the keys below.

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
| `includeNodeModules` | `true` | Re-include the profile's `node_modules` in the snapshot despite the home-level exclusion. |
| `files` | manifest list | Profile files mirrored alongside the dependency tree. |

**`lines.workspace`**

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | The line stays idle until a `source` is named. |
| `source` | `""` | Absolute path of the project directory to mirror. |
| `exclude` | `[".git", "node_modules", "dist", "build", "target", ".cache"]` | Directory and file names skipped anywhere in the tree. Replaces the defaults entirely when set. |

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

Small, frequently changing state. Files are copied into the line's worktree,
committed and pushed. Default cadence is 30 seconds after a turn ends, with a
15-minute floor so state still lands during a long-running tool sequence.

### `snapshot` → `dsh-snapshot`

A full mirror of the home, plus the configured profile's dependency manifest
and installed dependency tree. This is the line that makes a machine
recoverable. `link:` dependencies are recorded by their manifest entry and
restored by a package manager after a clone; published dependencies are
vendored into the branch.

Runs daily, on shutdown, and once shortly after startup when the previous
snapshot is older than the interval — a restart loop would otherwise reset the
countdown and never reach the line.

### `workspace` → `dsh-workspace`

Mirrors one project directory so that the code being worked on is versioned
alongside the state that describes it. Disabled by default. Build output and
dependency caches are excluded; the exclusion list is configurable.

### `release` → GitHub Release asset

**The other form of full backup**: the whole home packed into a `tar.gz` and
published as a release asset.

Why both full-backup lines exist:

| | `snapshot` (branch) | `release` (asset) |
| --- | --- | --- |
| Storage | every version lands in git history | one archive per version |
| Cost | tens of thousands of files, every commit | one compressed file |
| Restore | `git checkout` | download and extract, no plugin needed |
| Keeping many | history grows forever | keep N, prune the rest |

Use `snapshot` for the everyday increment and `release` for long-term archives
and disaster recovery.

Measured on a 3.4 GB home (dependencies excluded): about **369 MiB**, one file.

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
- Anything above `partSizeBytes` is split into `.part000`, `.part001`, … with a
  `manifest.json` carrying each part's sha256.
- `keep` bounds retention; older tags (which embed the timestamp) are deleted
  first, and **only tags with this line's prefix are ever considered**.
- `.credentials.yaml` is excluded. `includeSecrets: true` packs it in — on a
  public repository that is a key leak, not a backup.

Try it without uploading anything first:

```sh
node release-backup.mjs --dry-run
```

It reports the archive size, the part count and the destination repository.

**Transport**: the GitHub CLI when present, the REST API with a token otherwise.
That order is deliberate — behind a TLS-intercepting proxy (corporate proxy, an
accelerator that rewrites `hosts`) Node's `fetch` fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, while `gh` uses its own trust chain and works.
On the REST path the token comes from `DSH_AUTO_SYNC_GITHUB_TOKEN`,
`GITHUB_TOKEN`, or `gh auth token`.

---

## Restoring

Restore an entire home:

```sh
git clone <your-remote> ~/.dsh
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
git clone --branch dsh-workspace <your-remote> project
```

`git log dsh-snapshot -- <path>` yields the revision history of any individual
file, which makes the backup usable as a recovery mechanism rather than only as
a disaster copy.

---

## Security model

**Secrets are excluded by default.** The plugin adds `.credentials.yaml` and
the other patterns listed above to the home's `.gitignore` on first run.
`.credentials.yaml` holds provider API keys; it must never be pushed.

**Existing repositories are adopted, not taken over.** If the home is already a
git repository with a remote, its history and remote configuration are left
untouched. The plugin adds branches and worktrees only. It never rewrites,
rebases or force-pushes existing history, and it never changes a remote that
already points somewhere.

**Nothing is force-pushed.** A rejected push is retried once after integrating
the remote tip, with the local snapshot winning conflicts. History is append-only
from the plugin's perspective.

**Configuration cannot exfiltrate files.** `lines.hot.paths` are resolved
against the home and refused when they escape it, so a malformed config cannot
turn a backup line into a file copier.

**The plugin fails open for the session.** No error is thrown into the session
event chain. A failing backup is logged and recorded and the conversation
continues; the failure surfaces through the status file and the log rather than
through a broken chat.

---

## Operational behaviour

### Concurrency

Every line owns an independent worktree and index. The snapshot script takes a
lock file, so overlapping triggers (timer, startup catch-up, shutdown) serialise
instead of corrupting an in-flight commit. A lock older than one hour is treated
as abandoned.

### Failure handling

| Condition | Behaviour |
| --- | --- |
| `git` missing | Startup check reports it; backups are paused |
| `remote` unset | Template written; backups paused with an explicit warning |
| Push to primary remote rejected | One retry after merging the remote tip; nothing force-pushed |
| Worktree missing | Reported; recreate by restarting DSH |
| Worktree holds a different branch | Refused rather than adopted, so two branches never share one snapshot |
| Commit identity missing | Falls back to the configured `userName` / `userEmail` |

### Observability

`<home>/sync-plugin/status.json` records, per line, the timestamp of the last
success and the message of the last error:

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

**Backups paused: `remote` is empty.**
Set `remote` in `<home>/sync-plugin/config.json` and restart DSH.

**Push fails with `could not read Username`.**
The plugin runs without a terminal, so git cannot prompt. Configure an SSH key
without a passphrase, or a credential helper that already holds a token.

**`index.lock: File exists`.**
Result of a concurrent run against one index, which this plugin avoids by
design. If it appears, a previous DSH process did not exit cleanly: remove the
stale lock under the worktree's `.git` directory.

**Snapshot line never runs.**
Verify `lines.snapshot.enabled` and check `status.json`. A missing `git` on
`PATH` is the most common cause, and is reported at startup.

**Worktree refused because it holds another branch.**
The plugin will not adopt a directory checked out on a different branch. Point
`worktree` elsewhere or remove the stale directory.

---

## Development

The repository is dependency-free. Tests build throwaway repositories under the
system temporary directory and assert the resulting remote contents, including
negative cases: secrets, logs and build output must never appear on any branch.

```sh
node tests/e2e.mjs           # full flow: setup, hot commit, snapshot, push
node tests/verify-remote.mjs # assertions over what landed on the remote
node tests/edge.mjs          # workspace line, adoption, unconfigured start, path escape
node tests/onboard.mjs       # remote validation, onboarding message, /dsh-sync command
node tests/api.mjs           # settings routes: validation, persistence, origin fence
node tests/client.mjs        # client script: module factory, slot registration
```

| Path | Responsibility |
| --- | --- |
| `index.js` | Plugin entry: scheduling, hot line, lifecycle |
| `cold-sync.mjs` | Detached snapshot line |
| `workspace-sync.mjs` | Project mirror line |
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
