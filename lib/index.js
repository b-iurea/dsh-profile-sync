/**
 * Host adapter: exposes the profile-sync core as the `profile_sync` agent tool.
 */
import {
  applyPlan,
  assessConflict,
  backupSnapshot,
  capture,
  clearState,
  hashSnapshot,
  isEmptyPlan,
  planCounts,
  planPull,
  readRemote,
  readState,
  writeRemote,
  writeState,
} from './sync.js'
import { createLanHost } from './lan-host.js'

export const name = 'profile-sync'
export const inject = ['tools']

const DEFAULTS = {
  repo: '',
  branch: '',
  file: 'dsh-profile.json',
  gitDir: '',
  profile: '',
  excludeEntries: [],
  prune: false,
  lanEnabled: false,
  lanPort: 47931,
  lanDiscoveryPort: 47932,
  lanAutoApply: true,
  manualPeers: [],
}

function normalize(rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (!Array.isArray(config.excludeEntries)) config.excludeEntries = []
  if (!Array.isArray(config.manualPeers)) config.manualPeers = []
  return config
}

function servicesOf(ctx) {
  const pluginManager = ctx.get('pluginManager')
  const configEditor = ctx.get('configEditor')
  if (pluginManager === undefined) throw new Error('The plugin manager service is not available in this profile')
  if (configEditor === undefined) throw new Error('The config editor service is not available in this profile')
  return {
    listBundles: () => pluginManager.listBundles(),
    listPlugins: () => pluginManager.listPlugins(),
    configuration: () => configEditor.configuration(),
    edit: (entry, change) => configEditor.edit(entry, change),
    installBundle: (spec, options) => pluginManager.installBundle(spec, options),
    setBundleEnabled: (bundle, enabled) => pluginManager.setBundleEnabled(bundle, enabled),
    setPluginEnabled: (id, enabled) => pluginManager.setPluginEnabled(id, enabled),
  }
}

function captureOptions(config) {
  return {
    profile: config.profile || process.env.DSH_PROFILE || 'default',
    excludeEntries: config.excludeEntries,
  }
}

function summary(value) {
  if (value.ok === false) return `Profile sync failed: ${value.error}`
  const lines = [value.summary]
  if (value.details !== undefined) lines.push(JSON.stringify(value.details, null, 2))
  return lines.filter(Boolean).join('\n')
}

async function status(ctx, config) {
  if (!config.repo) {
    return {
      ok: true,
      configured: false,
      summary: 'Profile sync has no repository yet. Configure it with action "configure" and a Git URL or a shared folder path.',
      details: { repo: '', profile: config.profile || process.env.DSH_PROFILE || 'default' },
    }
  }
  const services = servicesOf(ctx)
  const { snapshot: local, catalog } = await capture(services, captureOptions(config))
  const localHash = hashSnapshot(local)
  const remoteResult = await readRemote(config)
  const remote = remoteResult.snapshot
  const state = await readState()
  const remoteHash = remote ? hashSnapshot(remote) : null
  const localDrift = state?.localHash !== undefined ? localHash !== state.localHash : false
  const remoteDrift = remote && state?.remoteHash !== undefined ? remoteHash !== state.remoteHash : false
  const plan = remote
    ? planPull({ remote, local, catalog, prune: Boolean(config.prune), excludeEntries: config.excludeEntries })
    : null
  return {
    ok: true,
    configured: true,
    summary: remote
      ? `Remote snapshot from ${remote.exportedAt} (${remote.source?.host ?? 'unknown host'}); ${plan
          ? JSON.stringify(planCounts(plan))
          : 'no plan'}`
      : `No snapshot at ${remoteResult.path} yet; push this machine to create it.`,
    details: {
      repo: config.repo,
      path: remoteResult.path,
      profile: local.source.profile,
      local: { hash: localHash, ...local.stats },
      remote: remote ? { hash: remoteHash, exportedAt: remote.exportedAt, source: remote.source, stats: remote.stats } : null,
      baseline: state ? { at: state.at, localHash: state.localHash, remoteHash: state.remoteHash } : null,
      drift: { local: localDrift, remote: remoteDrift },
      pending: plan ? planCounts(plan) : null,
      versions: plan?.versions ?? [],
      skipped: plan?.skipped ?? [],
    },
  }
}

async function push(ctx, config, params) {
  const services = servicesOf(ctx)
  const { snapshot: local } = await capture(services, captureOptions(config))
  const localHash = hashSnapshot(local)
  const remoteResult = await readRemote(config)
  const remote = remoteResult.snapshot
  const remoteHash = remote ? hashSnapshot(remote) : null
  const state = await readState()

  const conflict = assessConflict({ action: 'push', localHash, remoteHash, state, force: params.force === true })
  if (conflict.blocked) {
    return {
      ok: false,
      code: conflict.code,
      error: conflict.message,
      details: { remote: remoteResult.path, remoteExportedAt: remote?.exportedAt ?? null, baseline: state?.at ?? null },
    }
  }

  const written = await writeRemote(config, local, { message: params.message })
  await writeState({
    at: new Date().toISOString(),
    host: local.source.host,
    repo: config.repo,
    file: written.path,
    localHash,
    remoteHash: localHash,
    exportedAt: local.exportedAt,
  })
  return {
    ok: true,
    summary: `Pushed ${local.stats.bundles} bundles and ${local.stats.entries} configured rows to ${config.repo}${written.commit ? ` (commit ${written.commit})` : ''}.`,
    details: {
      path: written.path,
      machinePath: written.machinePath,
      commit: written.commit,
      hash: localHash,
      stats: local.stats,
      envRefs: local.envRefs,
      profile: local.source.profile,
    },
  }
}

async function pull(ctx, config, params) {
  const services = servicesOf(ctx)
  const remoteResult = await readRemote(config)
  const remote = remoteResult.snapshot
  if (remote === null) {
    return { ok: false, code: 'no-snapshot', error: `No snapshot at ${remoteResult.path}. Push from the machine that is already configured, then pull here.` }
  }
  const { snapshot: local, catalog } = await capture(services, captureOptions(config))
  const localHash = hashSnapshot(local)
  const remoteHash = hashSnapshot(remote)
  const state = await readState()

  const conflict = assessConflict({ action: 'pull', localHash, remoteHash, state, force: params.force === true })
  if (conflict.blocked && params.dryRun !== true) {
    return {
      ok: false,
      code: conflict.code,
      error: conflict.message,
      details: { localHash, remoteHash, baseline: state?.at ?? null },
    }
  }

  const prune = params.prune === undefined ? Boolean(config.prune) : params.prune === true
  const plan = planPull({ remote, local, catalog, prune, excludeEntries: config.excludeEntries })
  const counts = planCounts(plan)
  if (params.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      summary: `Would apply ${counts.install} installs, ${counts.enable + counts.disable} bundle toggles, ${counts.entries} configs, ${counts.reset} resets and ${counts.rows} row toggles; ${counts.secrets} local secrets to set; ${counts.skipped} skipped.${conflict.blocked ? ` This pull would be blocked: ${conflict.message} Preview only; use force=true to apply it.` : ''}`,
      details: { counts, plan, skipped: plan.skipped, secrets: plan.secrets, versions: plan.versions, conflict: conflict.blocked ? { code: conflict.code, message: conflict.message } : null },
    }
  }
  if (isEmptyPlan(plan)) {
    const secrets = plan.secrets.map((item) => `${item.id}: ${item.fields.join(', ')}`)
    const skipped = counts.skipped === 0 ? '' : ` ${counts.skipped} item(s) skipped (see details).`
    return {
      ok: true,
      summary: `${secrets.length ? `Already in sync. Set these values locally (never synced): ${secrets.join('; ')}.` : 'Already in sync: nothing to apply.'}${skipped}`,
      details: { counts, secrets: plan.secrets, skipped: plan.skipped, remoteExportedAt: remote.exportedAt },
    }
  }

  const backup = await backupSnapshot(local, 'before-pull')
  const applied = await applyPlan({ plan, catalog, services })
  const after = await capture(services, captureOptions(config))
  const afterHash = hashSnapshot(after.snapshot)
  await writeState({
    at: new Date().toISOString(),
    host: local.source.host,
    repo: config.repo,
    file: remoteResult.path,
    localHash: afterHash,
    remoteHash,
    exportedAt: remote.exportedAt,
  })

  return {
    ok: true,
    summary: `Applied ${applied.changes.length} changes${applied.warnings.length ? `, ${applied.warnings.length} warnings` : ''}.${applied.restartRequired ? ' Restart DSH to finish loading changed bundles.' : ''}`,
    details: {
      counts,
      changes: applied.changes,
      warnings: applied.warnings,
      restartRequired: applied.restartRequired,
      backup,
      remoteExportedAt: remote.exportedAt,
      skipped: plan.skipped,
      envRefs: remote.envRefs,
      localHashAfter: afterHash,
    },
  }
}

async function configure(ctx, config, params) {
  const repo = typeof params.repo === 'string' ? params.repo.trim() : ''
  if (repo === '') return { ok: false, error: 'configure needs "repo": a Git URL or a shared folder path.' }
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || entry === undefined) return { ok: false, error: 'This plugin row cannot persist configuration in this profile.' }
  const patch = { repo }
  if (typeof params.branch === 'string') patch.branch = params.branch
  if (Array.isArray(params.excludeEntries)) patch.excludeEntries = params.excludeEntries.filter((id) => typeof id === 'string')
  if (typeof params.prune === 'boolean') patch.prune = params.prune
  await editor.edit(entry, (current) => ({ ...current, ...patch }))
  if (repo !== config.repo) await clearState()
  return {
    ok: true,
    summary: `Saved sync repository: ${repo}. Restart is not required for the value, but the plugin row reloads.`,
    details: { repo, branch: patch.branch ?? config.branch ?? '' },
  }
}

async function lanStatus(host) {
  const status = await host.status()
  const trusted = status.peers.filter((peer) => peer.trusted)
  const online = trusted.filter((peer) => peer.online).length
  return {
    ok: true,
    summary: status.enabled
      ? `LAN sync is on (port ${status.port}); ${trusted.length} trusted peer(s), ${online} online, ${status.pendingPairs.length} pairing request(s).`
      : 'LAN sync is off on this machine. Enable it from the Profile sync panel or with action lan-enable.',
    details: status,
  }
}

async function lanDispatch(ctx, config, host, params) {
  switch (params.action) {
    case 'lan-status':
      return lanStatus(host)
    case 'lan-enable':
      return setLanEnabled(ctx, config, host, true)
    case 'lan-disable':
      return setLanEnabled(ctx, config, host, false)
    case 'lan-pair': {
      const target = typeof params.peer === 'string' ? params.peer.trim() : ''
      if (target === '') return { ok: false, error: 'lan-pair needs "peer": a peer URL such as http://192.168.1.20:47931, or a peer id.' }
      const url = /^https?:\/\//i.test(target) ? target : host.listPeers().find((peer) => peer.id === target)?.url
      if (!url) return { ok: false, error: `Unknown peer "${target}".` }
      const started = await host.pair(url)
      return {
        ok: true,
        summary: `Pairing request sent to ${started.peer.name}. Compare the code ${started.sas} on both screens and approve it there.`,
        details: started,
      }
    }
    case 'lan-approve': {
      const approved = await host.approve(params.pairId)
      return { ok: true, summary: `Paired with ${approved.peer.name}.`, details: approved }
    }
    case 'lan-reject':
      await host.reject(params.pairId)
      return { ok: true, summary: 'Pairing request rejected.' }
    case 'lan-forget':
      await host.forget(params.peer)
      return { ok: true, summary: 'Peer forgotten.' }
    case 'lan-push': {
      const pushed = await host.push(params.peer)
      return pushed.ok
        ? { ok: true, summary: `Pushed this profile to ${pushed.peer}. They will be asked to reload the page.`, details: pushed.result }
        : { ok: false, code: pushed.code, error: pushed.error }
    }
    case 'lan-pull': {
      const pulled = await host.pull(params.peer, { force: params.force === true })
      if (!pulled.ok) return { ok: false, code: pulled.code, error: pulled.error }
      return {
        ok: true,
        summary: pulled.noop ? 'Already in sync with that peer.' : `Pulled ${pulled.changes} change(s) from the peer.${pulled.restartRequired ? ' Restart DSH to load changed bundles.' : ''}`,
        details: pulled,
      }
    }
    case 'lan-check': {
      const daily = await host.checkNow()
      return {
        ok: true,
        summary: daily.diffs.length === 0 ? 'Daily check: the trusted peers match this profile.' : `Daily check: ${daily.diffs.length} peer(s) differ from this profile.`,
        details: daily,
      }
    }
    default:
      return { ok: false, error: `Unknown action "${params.action}"` }
  }
}

async function setLanEnabled(ctx, config, host, enabled) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor !== undefined && entry !== undefined) {
    await editor.edit(entry, (current) => ({ ...current, lanEnabled: enabled }))
  }
  await host.setEnabled(enabled)
  return {
    ok: true,
    summary: enabled ? 'LAN sync enabled on this machine. It listens on the LAN and can now pair.' : 'LAN sync disabled.',
    details: { lanEnabled: enabled },
  }
}

async function dispatch(ctx, config, params, host) {
  if (typeof params.action === 'string' && params.action.startsWith('lan-')) return lanDispatch(ctx, config, host, params)
  switch (params.action) {
    case 'status':
      return status(ctx, config)
    case 'push':
      return push(ctx, config, params)
    case 'pull':
      return pull(ctx, config, params)
    case 'configure':
      return configure(ctx, config, params)
    default:
      return { ok: false, error: `Unknown action "${params.action}"` }
  }
}

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig)
  const host = createLanHost({
    config,
    servicesOf: () => servicesOf(ctx),
    captureOptions,
    log: (message) => {
      try {
        ctx.logger?.debug?.(message)
      } catch {}
    },
  })
  ctx.effect(() => () => {
    host.stop().catch(() => {})
  })
  host
    .init()
    .then(() => host.start())
    .catch((error) => {
      try {
        ctx.logger?.warn?.(`profile-sync LAN: ${error.message}`)
      } catch {}
    })

  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer !== undefined) {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: '/profile-sync/api',
        handler: async (req, res) => {
          const denied = connection?.requestRejection?.(req)
          if (denied !== undefined) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'This browser is not allowed to manage profile sync on this host.' }))
            return
          }
          const url = new URL(req.url, 'http://localhost')
          const route = url.pathname.slice('/profile-sync/api'.length) || '/state'
          try {
            await host.ready
            let result
            switch (`${req.method} ${route}`) {
              case 'GET /state':
                result = { ok: true, ...(await host.status()) }
                break
              case 'POST /enable':
                result = { ok: true, ...(await setLanEnabled(ctx, config, host, (await readJson(req)).enabled === true)) }
                break
              case 'POST /pair':
                result = await host.pair(String((await readJson(req)).url ?? ''))
                result = { ok: true, ...result }
                break
              case 'POST /pair/approve':
                result = { ok: true, ...(await host.approve((await readJson(req)).pairId)) }
                break
              case 'POST /pair/reject':
                await host.reject((await readJson(req)).pairId)
                result = { ok: true }
                break
              case 'POST /peer':
                result = { ok: true, peers: host.listPeers() }
                break
              case 'POST /forget':
                await host.forget((await readJson(req)).peerId)
                result = { ok: true }
                break
              case 'POST /push':
                result = await host.push((await readJson(req)).peerId)
                break
              case 'POST /pull':
                result = await host.pull((await readJson(req)).peerId, { force: true })
                break
              case 'POST /check':
                result = { ok: true, ...(await host.checkNow()) }
                break
              case 'POST /reload-seen':
                await host.acknowledgeReload()
                result = { ok: true }
                break
              default:
                res.writeHead(404, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: `Unknown route ${req.method} ${route}` }))
                return
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify(result))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: error.message ?? String(error) }))
          }
        },
      }),
    )
  }

  ctx.tools.register({
    name: 'profile_sync',
    description:
      'Synchronize this DeepSeek Harness profile with the other machine: selected bundles, plugin row enablement, and plugin settings such as providers, theme, fonts and sidebar preferences. The snapshot lives in a Git repository or a shared folder (Syncthing, Dropbox, iCloud). Call status before push/pull when the other machine may have changed; credentials and API keys are never exported. Never invents provider keys: environment-variable names are reported as references only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'push', 'pull', 'configure', 'lan-status', 'lan-enable', 'lan-disable', 'lan-pair', 'lan-approve', 'lan-reject', 'lan-forget', 'lan-push', 'lan-pull', 'lan-check'],
          description: 'status: compare this machine with the snapshot. push: write this machine as the new snapshot. pull: apply the snapshot here (dryRun previews, force resolves a conflict). configure: save the repository URL/path.',
        },
        repo: {
          type: 'string',
          description: 'For configure: a Git URL (https/ssh) or a shared folder path. Accepts ~/paths.',
        },
        branch: {
          type: 'string',
          description: 'For configure: optional Git branch to push to.',
        },
        dryRun: {
          type: 'boolean',
          description: 'For pull: compute and return the plan without changing anything.',
        },
        force: {
          type: 'boolean',
          description: 'For pull: let the snapshot win even though this machine changed locally. For push: overwrite a snapshot that changed on the other machine.',
        },
        prune: {
          type: 'boolean',
          description: 'For pull: also remove local override rows that the snapshot does not contain. Off by default.',
        },
        excludeEntries: {
          type: 'array',
          items: { type: 'string' },
          description: 'For configure: plugin row ids that stay local to this machine (never exported, never applied).',
        },
        message: {
          type: 'string',
          description: 'For push: the commit message in Git mode.',
        },
        peer: {
          type: 'string',
          description: 'For LAN actions: the peer id, or a peer URL for lan-pair.',
        },
        pairId: {
          type: 'string',
          description: 'For lan-approve/lan-reject: the pairing request id.',
        },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: summary(value) }],
    },
    presentCall: (args) => ({ card: 'generic', kind: 'write', title: `Profile sync: ${args.action}` }),
    async execute(args) {
      try {
        return await dispatch(ctx, config, args, host)
      } catch (error) {
        return { ok: false, code: 'error', error: error.message ?? String(error) }
      }
    },
  })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}
