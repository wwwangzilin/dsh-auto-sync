# dsh-auto-sync

Automatic, versioned backup of your DeepSeek Harness home to **your own
private git repository**. Your conversations, memory files, settings and
installed dependencies are committed and pushed for you, so a wiped machine or
a bad upgrade costs you nothing.

- **You own the storage.** Any git remote works: a private GitHub/GitLab repo,
  a self-hosted server, a bare repository on a NAS.
- **Three lines, three branches.** Small hot state after every turn, a full
  snapshot daily, and optionally one project directory of your choice.
- **Cross-platform.** Windows, macOS and Linux. The only requirement is Node 22+
  and `git` on `PATH`.
- **Never silent.** Every run records its outcome in a status file; a stale
  backup is warned about instead of quietly staying stale.

## Install

```sh
dsh plugin --profile desktop add link:/absolute/path/to/dsh-auto-sync
```

Or use the **Plugins** page of the desktop app and point it at this directory.
Enable the bundle, restart DSH.

On first start with no configuration, the plugin writes a template to
`<home>/sync-plugin/config.json` and pauses. Fill in `remote` and restart:

```json
{
  "remote": "git@github.com:you/dsh-backup.git"
}
```

That is the whole required setup. Everything else has a default.

## What each line backs up

| Line | Branch | When | Contents |
| --- | --- | --- | --- |
| `hot` | `dsh-hot` | 30 s after each turn ends, and every 15 min | Small state files, e.g. `.sync-status.json` |
| `snapshot` | `dsh-snapshot` | Daily and on shutdown | The whole home plus the profile's dependency manifest and `node_modules` |
| `workspace` | `dsh-workspace` | With each snapshot | One project directory you name |

The snapshot line is what saves you: it includes the session logs, memory
files, `settings.yaml`, and the profile's installed plugin tree. `link:`
dependencies are recorded by their manifest entry; `pnpm install` restores them
after a clone.

## Configuration

All keys are optional except `remote`. The file lives at
`<home>/sync-plugin/config.json`; values in the profile's patch layer win over
defaults but lose to the file, because the plugin manager rewrites patches.

| Key | Default | Meaning |
| --- | --- | --- |
| `remote` | `""` | URL of your private repository. Required. |
| `remoteName` | `origin` | Remote name to use when `origin` already points elsewhere. |
| `worktree` | `<home>-backup` | Where the checkout lives. Must be outside the home. |
| `exclude` | secrets, `node_modules`, `*.log` | Extra ignore patterns. |
| `userName` / `userEmail` | `dsh-auto-sync` | Commit identity used only when git has none configured. |
| `lines.hot` | on, branch `dsh-hot` | `paths`, `debounceMs`, `intervalMs`, `enabled`, `branch`. |
| `lines.snapshot` | on, branch `dsh-snapshot` | `intervalMs`, `profile`, `includeNodeModules`, `files`. |
| `lines.workspace` | off | `enabled`, `source` (project root), `branch`, `exclude`. |

To also back up a project:

```json
{
  "remote": "git@github.com:you/dsh-backup.git",
  "lines": {
    "workspace": {
      "enabled": true,
      "source": "/home/you/projects/app"
    }
  }
}
```

## Safety

- `.credentials.yaml` and the other patterns in `.gitignore` are added to every
  home this plugin initialises. **Secrets never reach the remote.**
- A home that already is a git repository with a remote is **adopted**: its
  history and remote are left untouched, and the plugin only adds branches and
  worktrees. It never rewrites or force-pushes your history.
- A push is retried once after integrating the remote tip, with local content
  winning the merge. Nothing is force-pushed.
- `hot` paths are resolved against the home and refused if they escape it, so a
  bad config cannot turn a backup into a file copier.
- The plugin never throws into the session: a failure is logged and recorded,
  and the conversation continues.

## Restore

```sh
git clone <your-remote> ~/.dsh
cd ~/.dsh && git checkout dsh-snapshot
# or take only one file:
git show dsh-snapshot:sessions/....jsonl > that-file
```

Then install the profile's plugins again from the committed manifest:

```sh
dsh plugin --profile desktop install
```

## Status and troubleshooting

```sh
cat ~/.dsh/sync-plugin/status.json
```

Each line records `lastSuccessAt` and `lastError`. A line that has not
succeeded for 48 h is warned about in the DSH log.

Common causes of a failing push:

- **No credential for the remote.** The plugin runs without a terminal, so git
  cannot prompt. Use an SSH key with no passphrase, or a credential helper that
  already holds a token.
- **`git` not on `PATH`.** The startup check reports this explicitly.
- **A worktree directory that holds a different branch.** The plugin refuses to
  adopt it rather than mixing two branches into one snapshot; move or remove the
  directory.

## Tests

The suite builds a throwaway bare repository and home under the system temp
directory and asserts what lands on every branch, including that secrets and
build output stay out.

```sh
node tests/e2e.mjs && node tests/verify-remote.mjs && node tests/edge.mjs
```

## License

MIT
