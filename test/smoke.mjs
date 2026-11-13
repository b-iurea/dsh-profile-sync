/**
 * Offline smoke test for the sync core. Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPlan,
  assessConflict,
  backupSnapshot,
  capture,
  collectEnvRefs,
  hashSnapshot,
  planPull,
  readRemote,
  scrub,
  withLocalSecrets,
  writeRemote,
} from '../lib/sync.js'

let passed = 0
function ok(name) {
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

function fakeProfile({ bundles, plugins, rows }) {
  const config = rows.map((row) => ({
    entry: { options: { id: row.id, name: row.name, config: row.current } },
    inherited: row.inherited ?? {},
    override: row.override,
  }))
  const calls = []
  const services = {
    listBundles: async () => bundles,
    listPlugins: async () => plugins,
    configuration: () => config,
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'applied', stage: 'install', target: spec, enabled: options?.enabled }
    },
    setBundleEnabled: async (name, enabled) => {
      calls.push(['bundle', name, enabled])
      return { changed: true, application: 'applied', stage: 'enable', target: name }
    },
    setPluginEnabled: async (id, enabled) => {
      calls.push(['row', id, enabled])
      return { changed: true, application: 'applied', stage: 'enable', target: id }
    },
    edit: async (entry, change) => {
      const current = entry.options.config
      const next = change(current, {})
      calls.push(['edit', entry.options.id, next])
    },
  }
  return { services, calls, config }
}

const baseBundles = [
  { name: 'dsh-plugin', enabled: true, installed: true, official: false, version: '2.3.9', source: 'dsh-plugin@2.3.9' },
  { name: 'dsh-smooth-stream', enabled: false, installed: true, official: false, version: '0.8.0', source: 'dsh-smooth-stream@0.8.0' },
  { name: 'dsh-profile-sync', enabled: true, installed: true, official: false, version: '0.1.0', source: 'link:/home/engineering/plugins/dsh-profile-sync' },
]

const rows = [
  {
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    current: {
      providers: {
        strix: {
          apiKey: 'sk-local-test',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'http://192.0.2.207:9292/v1',
          models: [{ id: 'm', maxTokens: 65536 }],
        },
      },
    },
    override: {
      providers: {
        strix: {
          apiKey: 'sk-local-test',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'http://192.0.2.207:9292/v1',
          models: [{ id: 'm', maxTokens: 65536 }],
        },
      },
    },
  },
  { id: 'profile-sync', name: 'dsh-profile-sync', current: { repo: '/tmp/only-here' }, override: { repo: '/tmp/only-here' } },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', current: { preference: 'dark' }, override: { preference: 'dark' } },
  { id: 'untouched', name: 'something', current: { a: 1 }, override: {} },
]

const plugins = [
  { entryId: 'ui-theme', enabled: true },
  { entryId: 'session-log-deepseek', enabled: false },
]

// 1. scrub / env refs / secret merge
{
  const cleaned = scrub(rows[0].override)
  assert.equal(cleaned.providers.strix.apiKey, undefined)
  assert.equal(cleaned.providers.strix.apiKeyEnv, 'DEEPSEEK_API_KEY')
  const refs = collectEnvRefs(rows[0].override)
  assert.deepEqual([...refs], ['DEEPSEEK_API_KEY'])
  const merged = withLocalSecrets(scrub(rows[0].override), rows[0].current)
  assert.equal(merged.providers.strix.apiKey, 'sk-local-test', 'local secret is preserved on apply')
  ok('secrets are scrubbed and re-applied locally')
}

// 2. capture
const { services, calls, config } = fakeProfile({ bundles: baseBundles, plugins, rows })
{
  const { snapshot, catalog } = await capture(services, { profile: 'web' })
  assert.equal(snapshot.kind, 'dsh-profile-sync')
  assert.equal(snapshot.bundles.length, 3)
  assert.equal(snapshot.bundles.find((b) => b.name === 'dsh-profile-sync').localSource, true)
  assert.equal(snapshot.entries.length, 2, 'empty override rows and this plugin are not exported')
  const llm = snapshot.entries.find((e) => e.id === 'llm-pi-ai')
  assert.equal(llm.config.providers.strix.apiKey, undefined)
  assert.equal(llm.config.providers.strix.models[0].maxTokens, 65536, 'token budgets are settings, not secrets')
  assert.deepEqual(llm.secretFields, ['providers.strix.apiKey'])
  assert.equal(snapshot.entries.some((e) => e.id === 'profile-sync'), false)
  assert.deepEqual(snapshot.envRefs, ['DEEPSEEK_API_KEY'])
  assert.equal(catalog.length, 4)
  assert.equal(snapshot.stats.entries, 2)
  ok('capture builds a scrubbed semantic snapshot')

  // hashes ignore exportedAt/source
  const clone = structuredClone(snapshot)
  clone.exportedAt = '2000-01-01T00:00:00.000Z'
  clone.source.host = 'another'
  assert.equal(hashSnapshot(snapshot), hashSnapshot(clone))
  assert.equal(hashSnapshot({ ...snapshot, entries: [] }) === hashSnapshot(snapshot), false)
  ok('hashes are content-only')
}

// 3. plan + apply
{
  const { snapshot: remote } = await capture(services, { profile: 'web' })
  remote.entries = remote.entries.map((entry) =>
    entry.id === 'ui-theme' ? { ...entry, config: { preference: 'light' } } : entry,
  )
  remote.bundles = remote.bundles.map((bundle) =>
    bundle.name === 'dsh-smooth-stream' ? { ...bundle, enabled: true } : bundle,
  )
  remote.bundles.push({ name: 'dsh-new-bundle', enabled: true, installed: true, official: false, version: '1.0.0', source: 'dsh-new-bundle@1.0.0', localSource: false })
  remote.plugins = remote.plugins.map((plugin) => (plugin.id === 'session-log-deepseek' ? { ...plugin, enabled: true } : plugin))
  remote.entries.push({ id: 'missing-row', name: 'gone', config: { x: 1 } })

  const { snapshot: local, catalog } = await capture(services, { profile: 'web' })
  const plan = planPull({ remote, local, catalog })
  assert.deepEqual(plan.install.map((item) => item.name), ['dsh-new-bundle'])
  assert.deepEqual(plan.enable, ['dsh-smooth-stream'])
  assert.deepEqual(plan.entries.map((item) => item.id), ['ui-theme'])
  assert.deepEqual(plan.plugins, [{ id: 'session-log-deepseek', enabled: true }])
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.skipped[0].id, 'missing-row')

  const excludedPlan = planPull({ remote, local, catalog, excludeEntries: ['ui-theme'] })
  assert.deepEqual(excludedPlan.entries.map((item) => item.id), [])
  assert.equal(excludedPlan.skipped.some((item) => item.id === 'ui-theme' && /excluded/.test(item.reason)), true)
  ok('planPull computes installs, toggles, configs and skips')

  const before = calls.length
  const applied = await applyPlan({ plan, catalog, services })
  assert.equal(applied.changes.length, 4)
  assert.equal(applied.warnings.length, 0)
  assert.equal(calls.length, before + 4)
  const edit = calls.find((call) => call[0] === 'edit' && call[1] === 'ui-theme')
  assert.deepEqual(edit[2], { preference: 'light' })
  ok('applyPlan applies the plan through the services')
}

// 4. folder transport
{
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-folder-'))
  const config = { repo: dir }
  const { snapshot } = await capture(services, { profile: 'web' })
  const written = await writeRemote(config, snapshot)
  assert.ok(existsSync(written.path))
  assert.ok(existsSync(written.machinePath))
  const read = await readRemote(config)
  assert.deepEqual(read.snapshot.entries, snapshot.entries)
  assert.equal(hashSnapshot(read.snapshot), hashSnapshot(snapshot))
  await rm(dir, { recursive: true, force: true })
  ok('shared-folder transport round-trips')
}

// 5. git transport (bare origin)
{
  process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'DSH Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'test@example.invalid'
  process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || 'DSH Test'
  process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'test@example.invalid'
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-'))
  process.env.DSH_HOME = join(root, 'machine-a')
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' })
  const config = { repo: `file://${origin}`, file: 'dsh-profile.json' }
  const { snapshot } = await capture(services, { profile: 'web' })
  const first = await writeRemote(config, snapshot, { message: 'first' })
  assert.ok(first.commit, 'commit created')
  const read = await readRemote(config)
  assert.equal(hashSnapshot(read.snapshot), hashSnapshot(snapshot))

  // second machine: independent clone directory, new snapshot pushed
  process.env.DSH_HOME = join(root, 'machine-b')
  const secondConfig = { repo: `file://${origin}`, file: 'dsh-profile.json' }
  const changed = structuredClone(snapshot)
  changed.exportedAt = new Date().toISOString()
  changed.entries = changed.entries.map((entry) => (entry.id === 'ui-theme' ? { ...entry, config: { preference: 'system' } } : entry))
  await writeRemote(secondConfig, changed, { message: 'second' })
  const readBack = await readRemote(config)
  assert.equal(readBack.snapshot.entries.find((entry) => entry.id === 'ui-theme').config.preference, 'system')
  assert.equal(readBack.snapshot.source.host !== undefined, true)
  const log = execFileSync('git', ['log', '--oneline'], { cwd: origin }).toString()
  assert.match(log, /second/)
  await rm(root, { recursive: true, force: true })
  ok('git transport pushes, pulls and keeps machine history')
}

// 6. conflict decisions
{
  const state = { localHash: 'L0', remoteHash: 'R0' }
  assert.equal(assessConflict({ action: 'push', localHash: 'L1', remoteHash: 'R1', state }).blocked, true)
  assert.equal(assessConflict({ action: 'push', localHash: 'L1', remoteHash: 'R1', state, force: true }).blocked, false)
  assert.equal(assessConflict({ action: 'push', localHash: 'L1', remoteHash: 'L1', state }).blocked, false)
  assert.equal(assessConflict({ action: 'push', localHash: 'L1', remoteHash: 'L1', state: null }).blocked, false)
  assert.equal(assessConflict({ action: 'push', localHash: 'L1', remoteHash: 'R1', state: null }).blocked, true, 'first push must not clobber someone else')
  assert.equal(assessConflict({ action: 'pull', localHash: 'L1', remoteHash: 'R1', state }).blocked, true)
  assert.equal(assessConflict({ action: 'pull', localHash: 'L0', remoteHash: 'R1', state }).blocked, false)
  assert.equal(assessConflict({ action: 'pull', localHash: 'L1', remoteHash: 'R0', state }).blocked, true, 'remote unchanged does not license overwriting local work')
  assert.equal(assessConflict({ action: 'pull', localHash: 'L1', remoteHash: 'R1', state, force: true }).blocked, false)
  ok('conflicts block destructive syncs unless forced')
}

// 7. backup
{
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-sync-backup-'))
  const { snapshot } = await capture(services, { profile: 'web' })
  const path = await backupSnapshot(snapshot, 'test')
  const text = await readFile(path, 'utf8')
  assert.equal(JSON.parse(text).kind, 'dsh-profile-sync')
  ok('backup writes a restorable snapshot')
}

console.log(`\n${passed} checks passed`)
