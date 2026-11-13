/**
 * Profile sync core: a semantic snapshot of a DSH profile (selected bundles,
 * plugin row enablement, plugin settings) plus a Git / shared-folder transport.
 *
 * This module has no Cordis dependency on purpose: it is testable in isolation
 * and the Host adapter in `index.js` only supplies the live services.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const SCHEMA = 1
export const KIND = 'dsh-profile-sync'
export const DEFAULT_FILE = 'dsh-profile.json'
/** This plugin's own row: its config holds a machine-local path, never synced. */
export const SELF = { id: 'profile-sync', name: 'dsh-profile-sync' }

/* ------------------------------------------------------------------ helpers */

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keys whose values must never leave the machine. `*Env` names are references, not secrets. */
export function isSecretKey(key) {
  if (/env$/i.test(key)) return false
  // Token budgets are settings, not credentials: maxTokens, maxOutputTokens, contextTokens.
  if (/^(?:max|min|context|num|total|input|output)[a-z]*tokens?$/i.test(key)) return false
  return /api[-_]?key|(?:^|[-_])token$|secret|password|passwd|credential|private[-_]?key|access[-_]?key/i.test(key)
}

/** Remove secret-looking values from a raw config, recursively. */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) continue
    out[key] = scrub(item)
  }
  return out
}

/** Re-apply local secret values that the remote snapshot deliberately does not carry. */
export function withLocalSecrets(remote, local) {
  if (Array.isArray(remote)) {
    if (!Array.isArray(local)) return remote
    return remote.map((item, index) => withLocalSecrets(item, local[index]))
  }
  if (!isPlainObject(remote)) return remote
  const out = { ...remote }
  if (!isPlainObject(local)) return out
  for (const [key, value] of Object.entries(local)) {
    if (isSecretKey(key) && !(key in out)) out[key] = value
    else if ((isPlainObject(out[key]) || Array.isArray(out[key])) && (isPlainObject(value) || Array.isArray(value))) {
      out[key] = withLocalSecrets(out[key], value)
    }
  }
  return out
}

/** Dotted paths of the fields scrub() removed, so pull can tell the user what to fill in. */
export function secretPaths(value, prefix = '') {
  const paths = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => paths.push(...secretPaths(item, `${prefix}${prefix ? '.' : ''}${index}`)))
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const path = `${prefix}${prefix ? '.' : ''}${key}`
      if (isSecretKey(key)) paths.push(path)
      else paths.push(...secretPaths(item, path))
    }
  }
  return paths
}

function readPath(value, path) {
  let current = value
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/** Collect the environment-variable names a config depends on. */
export function collectEnvRefs(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, into)
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/env$/i.test(key) && typeof item === 'string' && item.trim() !== '') into.add(item.trim())
      else collectEnvRefs(item, into)
    }
  }
  return into
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
  return out
}

export function contentOf(snapshot) {
  return {
    schema: snapshot.schema,
    bundles: [...(snapshot.bundles ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    entries: [...(snapshot.entries ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    plugins: [...(snapshot.plugins ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    envRefs: [...(snapshot.envRefs ?? [])].sort(),
  }
}

export function hashSnapshot(snapshot) {
  return createHash('sha256').update(JSON.stringify(stable(contentOf(snapshot)))).digest('hex')
}

export function deepEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
}

export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stateDir() {
  return join(homeDir(), 'profile-sync')
}

/** A snapshot is only trusted when it is one of ours. */
export function assertSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || snapshot.kind !== KIND) throw new Error('Not a DSH profile snapshot (missing "kind")')
  if (snapshot.schema !== SCHEMA) throw new Error(`Unsupported snapshot schema ${snapshot.schema}; expected ${SCHEMA}`)
  if (!Array.isArray(snapshot.bundles) || !Array.isArray(snapshot.entries)) throw new Error('Malformed snapshot: bundles/entries missing')
  return snapshot
}

/* ----------------------------------------------------------------- capture */

/**
 * Read the live profile through the config editor and plugin manager.
 * @param services {listBundles, listPlugins, configuration}
 */
export async function capture(services, options = {}) {
  const { profile = 'default', host = hostname(), excludeEntries = [] } = options
  const excluded = new Set(excludeEntries)
  const [bundlesRaw, pluginsRaw] = await Promise.all([services.listBundles(), services.listPlugins()])
  const configuration = services.configuration()

  const catalog = configuration.map(({ entry, inherited, override }) => {
    const current = entry.options.config ?? {}
    const explicit = override ?? {}
    return {
      id: entry.options.id,
      name: entry.options.name,
      live: entry,
      current,
      inherited,
      override: explicit,
      hasOverride: isPlainObject(explicit) ? Object.keys(explicit).length > 0 : true,
    }
  })

  const bundles = bundlesRaw
    .filter((bundle) => (bundle.installed || bundle.enabled) && bundle.availability !== 'missing')
    .map((bundle) => ({
      name: bundle.name,
      enabled: Boolean(bundle.enabled),
      official: Boolean(bundle.official),
      installed: Boolean(bundle.installed),
      version: bundle.version ?? null,
      source: bundle.source ?? null,
      localSource: isLocalSource(bundle.source),
    }))

  const entries = catalog
    .filter((item) => item.hasOverride && !excluded.has(item.id) && item.id !== SELF.id && item.name !== SELF.name)
    .map((item) => ({
      id: item.id,
      name: item.name ?? null,
      config: scrub(item.override),
      secretFields: secretPaths(item.override),
    }))

  const plugins = pluginsRaw
    .filter((plugin) => plugin.moduleName !== SELF.name)
    .map((plugin) => ({ id: plugin.entryId, enabled: Boolean(plugin.enabled) }))

  const envRefs = new Set()
  for (const item of catalog) collectEnvRefs(item.override, envRefs)

  const snapshot = {
    schema: SCHEMA,
    kind: KIND,
    exportedAt: new Date().toISOString(),
    source: { host, profile, platform: process.platform, node: process.version },
    bundles,
    entries,
    plugins,
    envRefs: [...envRefs].sort(),
    stats: { bundles: bundles.length, entries: entries.length, plugins: plugins.length },
  }
  return { snapshot, catalog }
}

export function isLocalSource(source) {
  if (typeof source !== 'string' || source === '') return false
  return /^(link:|file:)/.test(source) || isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) || /^\.{1,2}[\\/]/.test(source) || source.startsWith('~/')
}

/* -------------------------------------------------------------------- diff */

/**
 * Compare a remote snapshot with the live profile.
 * @returns a plan; nothing here changes the machine.
 */
export function planPull({ remote, local, catalog, prune = false, excludeEntries = [] }) {
  const excluded = new Set(excludeEntries)
  const remoteBundles = new Map(remote.bundles.map((item) => [item.name, item]))
  const localBundles = new Map(local.bundles.map((item) => [item.name, item]))
  const localEntries = new Map(catalog.map((item) => [item.id, item]))
  const localPlugins = new Map(local.plugins.map((item) => [item.id, item]))

  const plan = { install: [], enable: [], disable: [], entries: [], reset: [], plugins: [], secrets: [], skipped: [], versions: [] }

  for (const bundle of remote.bundles) {
    const mine = localBundles.get(bundle.name)
    if (mine === undefined) {
      if (bundle.localSource) {
        plan.skipped.push({ kind: 'bundle', id: bundle.name, reason: 'installed from a local path; install it manually' })
      } else if (bundle.official || !bundle.source) {
        plan.skipped.push({ kind: 'bundle', id: bundle.name, reason: 'shipped with the harness; nothing to install' })
      } else {
        plan.install.push({ name: bundle.name, spec: bundle.source ?? bundle.name, enabled: bundle.enabled })
      }
      continue
    }
    if (!mine.installed && bundle.installed) {
      if (bundle.localSource) plan.skipped.push({ kind: 'bundle', id: bundle.name, reason: 'installed from a local path; install it manually' })
      else if (bundle.official || !bundle.source) plan.skipped.push({ kind: 'bundle', id: bundle.name, reason: 'shipped with the harness; nothing to install' })
      else plan.install.push({ name: bundle.name, spec: bundle.source ?? bundle.name, enabled: bundle.enabled })
      continue
    }
    if (mine.enabled !== bundle.enabled) {
      if (bundle.enabled) plan.enable.push(bundle.name)
      else plan.disable.push(bundle.name)
    }
    if (bundle.version && mine.version && bundle.version !== mine.version) {
      plan.versions.push({ name: bundle.name, local: mine.version, remote: bundle.version })
    }
  }

  const remoteIds = new Set(remote.entries.map((entry) => entry.id))
  for (const entry of remote.entries) {
    if (excluded.has(entry.id)) {
      plan.skipped.push({ kind: 'entry', id: entry.id, reason: 'excluded on this machine (excludeEntries)' })
      continue
    }
    const mine = localEntries.get(entry.id)
    if (mine === undefined) {
      plan.skipped.push({ kind: 'entry', id: entry.id, reason: 'no such row in this profile (plugin not installed?)' })
      continue
    }
    const desired = withLocalSecrets(entry.config, mine.current)
    const missingSecrets = (entry.secretFields ?? []).filter((path) => readPath(mine.current, path) === undefined)
    if (missingSecrets.length > 0) plan.secrets.push({ id: entry.id, fields: missingSecrets })
    if (!deepEqual(desired, mine.override)) plan.entries.push({ id: entry.id, remoteConfig: entry.config, desired })
  }
  if (prune) {
    for (const item of catalog) {
      if (item.hasOverride && !remoteIds.has(item.id) && !excluded.has(item.id) && item.id !== SELF.id && item.name !== SELF.name) {
        plan.reset.push(item.id)
      }
    }
  }

  for (const plugin of remote.plugins) {
    const mine = localPlugins.get(plugin.id)
    if (mine === undefined) {
      plan.skipped.push({ kind: 'row', id: plugin.id, reason: 'row not present in this profile' })
      continue
    }
    if (mine.enabled !== plugin.enabled) plan.plugins.push({ id: plugin.id, enabled: plugin.enabled })
  }

  for (const bundle of local.bundles) {
    if (!remoteBundles.has(bundle.name) && bundle.enabled) {
      plan.skipped.push({ kind: 'bundle', id: bundle.name, reason: 'enabled here but absent from the snapshot' })
    }
  }
  return plan
}

export function planCounts(plan) {
  return {
    install: plan.install.length,
    enable: plan.enable.length,
    disable: plan.disable.length,
    entries: plan.entries.length,
    reset: plan.reset.length,
    rows: plan.plugins.length,
    secrets: plan.secrets.length,
    skipped: plan.skipped.length,
  }
}

export function isEmptyPlan(plan) {
  const { secrets: _secrets, ...counts } = planCounts(plan)
  return Object.values(counts).every((value) => value === 0) && plan.versions.length === 0
}

/**
 * Decide whether an action would silently discard work done elsewhere.
 * @returns {{blocked: boolean, code?: string, message?: string}}
 */
export function assessConflict({ action, localHash, remoteHash, state, force = false }) {
  if (force || remoteHash === null || remoteHash === localHash) return { blocked: false }
  const localChanged = state?.localHash !== undefined && localHash !== state.localHash
  const remoteChanged = state?.remoteHash !== undefined && remoteHash !== state.remoteHash
  if (action === 'push' && (remoteChanged || state?.remoteHash === undefined)) {
    return {
      blocked: true,
      code: 'conflict',
      message:
        'The snapshot changed on another machine since this machine last synced. Pull first, or pass force=true to overwrite it.',
    }
  }
  if (action === 'pull' && localChanged) {
    return {
      blocked: true,
      code: 'conflict',
      message:
        'This machine changed locally since the last sync. The snapshot would overwrite those changes; review with action "status", then pass force=true to let the snapshot win.',
    }
  }
  return { blocked: false }
}

/* ------------------------------------------------------------------- apply */

function noteChange(result, changes, warnings, name) {
  if (result === undefined || result === null) return
  if (result.application === 'failed') warnings.push(`${name}: ${result.error ?? 'failed'}`)
  else changes.push({ target: name, application: result.application, stage: result.stage, changed: result.changed })
  if (Array.isArray(result.warnings)) warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`))
}

export async function applyPlan({ plan, catalog, services, onChange = () => {} }) {
  const changes = []
  const warnings = []
  const missing = new Map(plan.skipped.map((item) => [`${item.kind}:${item.id}`, item]))
  let restartRequired = false

  for (const item of plan.install) {
    if (missing.has(`bundle:${item.name}`)) continue
    const result = await services.installBundle(item.spec, { enabled: item.enabled })
    noteChange(result, changes, warnings, item.name)
    if (result?.application === 'restart-required') restartRequired = true
    if (result?.application === 'failed') continue
    if (result?.changed) onChange(`install ${item.name}`)
  }

  for (const name of plan.enable) {
    const result = await services.setBundleEnabled(name, true)
    noteChange(result, changes, warnings, name)
    if (result?.application === 'restart-required') restartRequired = true
    if (result?.changed) onChange(`enable ${name}`)
  }
  for (const name of plan.disable) {
    const result = await services.setBundleEnabled(name, false)
    noteChange(result, changes, warnings, name)
    if (result?.application === 'restart-required') restartRequired = true
    if (result?.changed) onChange(`disable ${name}`)
  }

  for (const item of plan.entries) {
    const mine = catalog.find((entry) => entry.id === item.id)
    if (mine === undefined) {
      warnings.push(`${item.id}: row disappeared before it could be applied`)
      continue
    }
    try {
      await services.edit(mine.live, (current) => withLocalSecrets(item.remoteConfig, current))
      changes.push({ target: item.id, application: 'applied', stage: 'config', changed: true })
      onChange(`config ${item.id}`)
    } catch (error) {
      warnings.push(`${item.id}: ${error.message}`)
    }
  }

  for (const item of plan.secrets) {
    warnings.push(`${item.id}: the snapshot has no value for ${item.fields.join(', ')}; set it locally (credentials are never synced)`)
  }

  for (const id of plan.reset) {
    const mine = catalog.find((entry) => entry.id === id)
    if (mine === undefined) continue
    try {
      await services.edit(mine.live, (_current, inherited) => inherited)
      changes.push({ target: id, application: 'applied', stage: 'config', changed: true })
      onChange(`reset ${id}`)
    } catch (error) {
      warnings.push(`${id}: ${error.message}`)
    }
  }

  for (const item of plan.plugins) {
    const result = await services.setPluginEnabled(item.id, item.enabled)
    noteChange(result, changes, warnings, item.id)
    if (result?.application === 'restart-required') restartRequired = true
    if (result?.changed) onChange(`${item.enabled ? 'enable' : 'disable'} row ${item.id}`)
  }

  if (!restartRequired) restartRequired = changes.some((change) => change.stage === 'install' || change.stage === 'enable' || change.stage === 'remove')
  return { changes, warnings, restartRequired }
}

/* --------------------------------------------------------------- transport */

export function expandPath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** Decide whether `repo` is a Git remote or a shared folder. */
export function resolveLocation(config) {
  const repo = String(config.repo ?? '').trim()
  if (repo === '') throw new Error('No sync repository configured: set "repo" in the plugin settings (a Git URL or a shared folder path)')
  const expanded = expandPath(repo)
  const explicitlyLocal = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded) || /^\.{1,2}[\\/]/.test(repo) || repo.startsWith('~')
  const looksGit = /^(?:git\+|git@|ssh:\/\/|https?:\/\/|file:\/\/|github:|gitlab:|bitbucket:)/i.test(repo)
  if (!explicitlyLocal && looksGit) {
    return {
      kind: 'git',
      url: repo,
      dir: expandPath(config.gitDir || join(stateDir(), 'repo')),
      branch: typeof config.branch === 'string' && config.branch !== '' ? config.branch : null,
    }
  }
  return { kind: 'folder', dir: resolve(expanded), branch: null }
}

async function exists(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function git(dir, args) {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: dir,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { stdout, stderr }
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || '').trim()
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${detail}`)
  }
}

const EMPTY_REMOTE = /couldn't find remote ref|no such ref|could not read from remote repository|HEAD is now at|empty repository|does not appear to be a git repository/i

async function ensureRepo(location) {
  if (location.kind === 'folder') {
    await mkdir(location.dir, { recursive: true })
    return { fresh: false }
  }
  const dotGit = await exists(join(location.dir, '.git'))
  if (dotGit === null) {
    await mkdir(dirname(location.dir), { recursive: true })
    const args = ['clone', '--depth', '1']
    if (location.branch) args.push('--branch', location.branch)
    args.push(location.url, location.dir)
    await git(dirname(location.dir), args)
    return { fresh: true }
  }
  try {
    await git(location.dir, ['pull', '--ff-only'])
  } catch (error) {
    if (!EMPTY_REMOTE.test(error.message)) throw error
  }
  return { fresh: false }
}

export function snapshotPath(config, location) {
  return join(location.dir, config.file || DEFAULT_FILE)
}

export async function readRemote(config) {
  const location = resolveLocation(config)
  await ensureRepo(location)
  const path = snapshotPath(config, location)
  try {
    const text = await readFile(path, 'utf8')
    return { snapshot: assertSnapshot(JSON.parse(text)), path, location }
  } catch (error) {
    if (error.code === 'ENOENT') return { snapshot: null, path, location }
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${error.message}`)
    throw error
  }
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

export async function writeRemote(config, snapshot, { message = null } = {}) {
  const location = resolveLocation(config)
  await ensureRepo(location)
  const path = snapshotPath(config, location)
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  await writeAtomic(path, text)
  const machinePath = join(location.dir, 'machines', `${hostname()}.json`)
  await writeAtomic(machinePath, text)

  if (location.kind === 'folder') return { path, machinePath, commit: null, location }

  await git(location.dir, ['add', '--', path, machinePath])
  const summary = message || `profile sync from ${hostname()} (${snapshot.exportedAt})`
  let commit = null
  try {
    await git(location.dir, ['commit', '-m', summary])
  } catch (error) {
    if (!/nothing to commit|no changes added/i.test(error.message)) throw error
  }
  try {
    const { stdout } = await git(location.dir, ['rev-parse', '--short', 'HEAD'])
    commit = stdout.trim()
  } catch {
    commit = null
  }
  const ref = location.branch ? `HEAD:${location.branch}` : 'HEAD'
  try {
    await git(location.dir, ['push', 'origin', ref])
  } catch {
    await git(location.dir, ['push', '-u', 'origin', ref])
  }
  return { path, machinePath, commit, location }
}

/* ------------------------------------------------------------------- state */

export function statePath() {
  return join(stateDir(), 'state.json')
}

export async function readState() {
  try {
    const text = await readFile(statePath(), 'utf8')
    const state = JSON.parse(text)
    if (!isPlainObject(state) || state.kind !== KIND) return null
    return state
  } catch {
    return null
  }
}

/** Drop the sync baseline: a different repository has its own history. */
export async function clearState() {
  await rm(statePath(), { force: true })
}

export async function writeState(state) {
  await writeAtomic(statePath(), `${JSON.stringify({ kind: KIND, ...state }, null, 2)}\n`)
}

/** Keep a copy of the local profile before it is overwritten. */
export async function backupSnapshot(snapshot, label = 'before-pull') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(stateDir(), 'backups', `${stamp}-${label}`)
  const path = join(dir, `${hostname()}.json`)
  await writeAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  return path
}
