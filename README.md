# dsh-profile-sync

Keep two or more [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
machines aligned: providers, installed plugins, enabled/disabled rows and plugin
settings — including theme, fonts and sidebar preferences.

Two transports, one snapshot format:

- **Git or a shared folder** — push/pull through a private repo, Syncthing, Dropbox
  or iCloud. Works across networks and through firewalls.
- **LAN sidecar** — the two machines discover each other on the local network,
  pair once with a 6-digit code, then a **Push** button sends the configuration
  and the other machine applies it immediately.

![icon](icon.svg)

## Why not just copy the profile directory?

Because a profile is more than files. `dsh-profile-sync` reads the live profile
through the `pluginManager` and `configEditor` services and applies the diff with
the same APIs the Plugin Manager uses. The profile's `cordis.patch.yml` is never
rewritten by hand: comments, `insert` rows and `!!js` expressions stay intact.
The transport only carries a **semantic snapshot** (bundles, row state, config
overrides, environment variable names), not raw files.

## What it syncs

| Item | Notes |
| --- | --- |
| Installed and selected bundles | installs missing ones, enables/disables |
| Enabled/disabled plugin rows | e.g. a shipped tool you turned off |
| Plugin configuration | profile overrides: providers, baseURL, models, theme, fonts, sidebar |
| Required environment variables | **names only** (`DEEPSEEK_API_KEY`, …) |

## What it does not sync

- **Credentials and secrets** (`~/.dsh/.credentials.yaml`, inline API keys). They
  stay per device: secret-looking fields are stripped from the snapshot, and a pull
  keeps the local values instead of overwriting them.
- **Transient layout** (panel widths): DSH resets it on reload by design. Theme,
  fonts and persistent preferences are configuration and do sync.
- Sessions, workspaces and chat history.
- Bundles installed from a local path (`link:`/`file:`): that path does not exist
  on another machine, so they must be installed by hand (the snapshot flags them).

## Install

The plugin must exist on **both** machines before it can sync anything. Keep it in
its own Git repo, clone it on each PC and install it once from that path:

```bash
git clone https://github.com/b-iurea/dsh-profile-sync ~/dsh-profile-sync
```

Then, from the Plugin Manager (or by asking the agent), install the bundle from
`~/dsh-profile-sync`. From then on, plugin updates are a `git pull`.

Requires DeepSeek Harness with the `pluginManager` and `configEditor` services
(shipped in the standard profile) and Node.js 20+.

## Usage

First machine (already configured):

```
profile_sync { action: "push" }
```

Second machine (fresh DSH install, plugin installed):

```
profile_sync { action: "configure", repo: "<same repo>" }
profile_sync { action: "status" }
profile_sync { action: "pull", dryRun: true }   # preview
profile_sync { action: "pull" }
```

Restart DSH if the result says `restartRequired` (new or changed bundles).

- `status` compares local, snapshot and last sync, and shows the plan.
- `push` refuses to overwrite a snapshot changed elsewhere: pull first, or use `force: true`.
- `pull` refuses to overwrite local changes made after the last sync: `force: true`
  lets the snapshot win.
- Every `pull` writes a backup to `~/.dsh/profile-sync/backups/<timestamp>-before-pull/`.
- Last-sync state lives in `~/.dsh/profile-sync/state.json`; in Git mode each
  machine also leaves `machines/<hostname>.json` in the repository.

### Tool actions

| Action | Purpose |
| --- | --- |
| `status` | local hash, remote hash, pending changes, drift |
| `push` | write the snapshot to the repo (or send it to a LAN peer) |
| `pull` | apply the remote snapshot (`dryRun`, `force`) |
| `configure` | set `repo`, `branch`, `excludeEntries`, `prune` |
| `lan-status` / `lan-enable` / `lan-disable` | LAN sidecar lifecycle |
| `lan-pair` / `lan-approve` / `lan-reject` / `lan-forget` | pairing |
| `lan-push` / `lan-pull` / `lan-check` | send, fetch, compare |

## LAN sidecar (no Git)

Turn it on from the **Sync** panel in the bottom-right corner, or with
`profile_sync { action: "lan-enable" }`. The plugin then exposes a small P2P
server on the LAN (`0.0.0.0:47931`) and announces itself over UDP broadcast on
`47932`. The switch is stored in `~/.dsh/profile-sync/lan.json` and does not
reload the plugin.

1. Turn on LAN on both machines.
2. Pick the discovered PC and press **Pair** (or paste its
   `http://<ip>:47931` URL). A 6-digit code appears on both screens: compare it
   and approve on the machine that receives the request.
3. From then on the peers are trusted: **Push** sends the snapshot, the receiver
   applies it immediately (with a backup) and shows a "Reload the page" banner.
4. Every 24 hours a check compares hashes and lists diverging peers; **Check now**
   runs it immediately.

Trust is not a shared secret in the clear: pairing uses X25519 and the 6-digit
code binds the channel; every later call is HMAC-SHA256 signed with a token
derived from the ECDH secret, with a 120 s window and a replay cache. Trusted
peers and tokens live in `~/.dsh/profile-sync/lan.json` (mode 0600).

What the sidecar does **not** do: it does not carry sessions, does not run tools
on the other machine, and never installs bundles automatically. Missing bundles
go to a queue for manual install (supply chain). The server only listens while
`lanEnabled` is true.

If the port is busy (for example two DSH processes), the panel shows
`LAN port 47931 is busy`; restart DSH once to release the socket.

## Configuration

In the profile, row `profile-sync`:

```yaml
- id: profile-sync
  name: dsh-profile-sync
  config:
    repo: 'git@github.com:user/dsh-profile.git'
    branch: ''            # optional
    file: dsh-profile.json
    excludeEntries: []    # row ids to keep machine-local
    prune: false          # true = also drop local overrides missing from the snapshot
    lanEnabled: false     # first-run default; afterwards the panel switch wins
    lanPort: 47931
    lanDiscoveryPort: 47932
    lanAutoApply: true
    manualPeers: []       # explicit URLs when UDP broadcast is blocked (VLANs)
```

`repo` accepts:

- a Git URL (`https://`, `git@`, `ssh://`, `file://`): cloned to
  `~/.dsh/profile-sync/repo`, with `pull --ff-only` / `commit` / `push`;
- a folder path (also `~/...`): ideal with Syncthing, Dropbox or iCloud.

## Per-machine endpoints

Some settings only make sense on one machine (for example a baseURL on your home
LAN that does not exist at work). The `profile-sync` row itself is never exported,
so each machine can keep its own `excludeEntries`. Listed rows are neither
exported by `push` nor applied by `pull`; they stay local configuration.

```yaml
# home PC
excludeEntries: []
# work PC: keep out the providers that point at the home LAN
excludeEntries: ['llm-deepseek', 'llm-pi-ai']
```

`status` and `pull --dryRun` show skipped rows with the reason
`excluded on this machine (excludeEntries)`.

## Notes and limits

- Bundle versions are not upgraded automatically: the snapshot records them and
  `status` reports differences.
- Bundle order in the profile is not guaranteed: new bundles are appended (as
  `dsh plugin add` would). Harmless in most setups.
- Referenced environment variables must be set on both machines; the plugin does
  not copy them.
- The LAN sidecar is meant for a trusted network. On a managed work network keep
  `lanEnabled: false` there and use Git.
- Offline tests: `node test/smoke.mjs`, `node test/lan-smoke.mjs`,
  `node test/client-smoke.mjs`.

## License

MIT
