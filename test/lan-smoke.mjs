/**
 * Offline checks for the LAN sidecar: pairing, signed requests, replay
 * protection, and the host manager against a real peer server on loopback.
 * No discovery: UDP broadcast is environment-dependent, the pairing path is not.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, hashSnapshot } from '../lib/sync.js'
import {
  createIdentity,
  createLanServer,
  fetchPeerSnapshot,
  fetchPeerState,
  pollPairing,
  pushSnapshot,
  sha256hex,
  signRequest,
  startPairing,
} from '../lib/lan.js'
import { createLanHost } from '../lib/lan-host.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

function mockServices() {
  const overrides = new Map([
    ['ui-theme', { preference: 'dark' }],
    ['llm-test', { baseURL: 'http://local', apiKey: 'sk-test' }],
  ])
  const entries = new Map([
    ['ui-theme', { options: { id: 'ui-theme', name: 'dsh-client-ui-theme', config: { preference: 'dark' } } }],
    ['llm-test', { options: { id: 'llm-test', name: 'dsh-llm-test', config: { baseURL: 'http://local', apiKey: 'sk-test' } } }],
  ])
  const edits = []
  const services = {
    listBundles: async () => [
      { name: 'dsh-base', enabled: true, official: true, installed: true, version: '1.0.0', source: null },
      { name: 'local-thing', enabled: true, official: false, installed: true, version: '0.1.0', source: 'link:/tmp/local-thing' },
    ],
    listPlugins: async () => [
      { entryId: 'include:ui-theme', moduleName: 'dsh-client-ui-theme', enabled: true },
      { entryId: 'include:llm-test', moduleName: 'dsh-llm-test', enabled: true },
    ],
    configuration: () =>
      [...entries.values()].map((entry) => ({
        entry,
        inherited: {},
        override: overrides.get(entry.options.id),
      })),
    edit: async (entry, change) => {
      const next = change(entry.options.config, {})
      entry.options.config = next
      overrides.set(entry.options.id, next)
      edits.push({ id: entry.options.id, next })
    },
    installBundle: async () => ({ changed: true, application: 'applied' }),
    setBundleEnabled: async () => ({ changed: false, application: 'applied' }),
    setPluginEnabled: async () => ({ changed: false, application: 'applied' }),
  }
  return { services, edits }
}

check('pairing derives the same SAS and token on both sides', async () => {
  const a = createIdentity('machine-a')
  const b = createIdentity('machine-b')
  const server = createLanServer({
    identity: a,
    port: 0,
    getState: async () => ({ hash: 'h', profile: 'test' }),
    getSnapshot: async () => null,
    applyPush: async () => ({ ok: true }),
    getPeerToken: () => undefined,
  })
  const { port } = await server.listen()
  try {
    const started = await startPairing(`http://127.0.0.1:${port}`, b, 0)
    const [pending] = server.pendingPairs()
    assert.equal(pending.pairId, started.pairId)
    assert.equal(pending.sas, started.sas)
    const approved = server.approve(started.pairId)
    assert.equal(approved.token, started.token)
    assert.equal(await pollPairing(`http://127.0.0.1:${port}`, started.pairId, started.nonce, { attempts: 3, delayMs: 50 }), true)
  } finally {
    await server.close()
  }
})

check('signed requests: valid, tampered, replayed and stale', async () => {
  const a = createIdentity('machine-a')
  const b = createIdentity('machine-b')
  const peer = { id: b.id, name: b.name, url: '', token: 'token-1' }
  const server = createLanServer({
    identity: a,
    port: 0,
    getState: async () => ({ hash: 'hash-1', profile: 'test', exportedAt: 'now' }),
    getSnapshot: async () => ({ kind: 'dsh-profile-sync', schema: 1, bundles: [], entries: [] }),
    applyPush: async () => ({ ok: true }),
    getPeerToken: (id) => (id === b.id ? peer.token : undefined),
  })
  const { port } = await server.listen()
  peer.url = `http://127.0.0.1:${port}`
  try {
    const state = await fetchPeerState(peer)
    assert.equal(state.hash, 'hash-1')
    const snapshot = await fetchPeerSnapshot(peer)
    assert.equal(snapshot.kind, 'dsh-profile-sync')
    const push = await pushSnapshot(peer, { kind: 'dsh-profile-sync', schema: 1, bundles: [], entries: [] })
    assert.equal(push.status, 200)

    const path = '/profile-sync/lan/p2p/state'
    const ts = Date.now()
    const nonce = 'replay-nonce-1'
    const headers = () => {
      const sig = signRequest(peer.token, { method: 'GET', path, ts, nonce, bodyHash: sha256hex('') })
      return { 'x-ps-peer': b.id, 'x-ps-ts': String(ts), 'x-ps-nonce': nonce, 'x-ps-sig': sig }
    }
    const first = await fetch(peer.url + path, { headers: headers() })
    assert.equal(first.status, 200)
    const replay = await fetch(peer.url + path, { headers: headers() })
    assert.equal(replay.status, 401)
    const tampered = await fetch(peer.url + path, {
      headers: (() => {
        const sig = signRequest(peer.token, { method: 'GET', path, ts, nonce: 'n2', bodyHash: sha256hex('x') })
        return { 'x-ps-peer': b.id, 'x-ps-ts': String(ts), 'x-ps-nonce': 'n2', 'x-ps-sig': sig }
      })(),
    })
    assert.equal(tampered.status, 401)
    const staleTs = Date.now() - 600_000
    const staleSig = signRequest(peer.token, { method: 'GET', path, ts: staleTs, nonce: 'n3', bodyHash: sha256hex('') })
    const stale = await fetch(peer.url + path, { headers: { 'x-ps-peer': b.id, 'x-ps-ts': String(staleTs), 'x-ps-nonce': 'n3', 'x-ps-sig': staleSig } })
    assert.equal(stale.status, 401)
    const stranger = await fetchPeerState({ ...peer, token: 'wrong' }).then(() => 'ok', (error) => error.message)
    assert.match(String(stranger), /signature|401|unauthorized/i)
  } finally {
    await server.close()
  }
})

check('host pairing, push, pull and daily check against a live peer', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-lan-home-'))
  const { services, edits } = mockServices()
  const local = await capture(services, { profile: 'test', host: 'machine-a' })
  const remoteSnapshot = JSON.parse(JSON.stringify(local.snapshot))
  remoteSnapshot.entries.find((entry) => entry.id === 'ui-theme').config.preference = 'light'
  remoteSnapshot.entries.find((entry) => entry.id === 'ui-theme').name = 'dsh-client-ui-theme'

  const tokens = new Map()
  let received = null
  const peerIdentity = createIdentity('machine-b')
  const peerServer = createLanServer({
    identity: peerIdentity,
    port: 0,
    getState: async () => ({ hash: hashSnapshot(remoteSnapshot), profile: 'test', exportedAt: remoteSnapshot.exportedAt }),
    getSnapshot: async () => remoteSnapshot,
    applyPush: async (peerId, snapshot) => {
      received = { peerId, snapshot }
      return { ok: true, changes: 0, restartRequired: false }
    },
    getPeerToken: (peerId) => tokens.get(peerId),
  })
  const peerBound = await peerServer.listen()
  const host = createLanHost({
    config: { lanEnabled: true, lanPort: 0, lanDiscoveryPort: 0, excludeEntries: [], prune: false },
    servicesOf: () => services,
    captureOptions: () => ({ profile: 'test', host: 'machine-a' }),
  })
  try {
    await host.init()
    await host.start()
    const started = await host.pair(`http://127.0.0.1:${peerBound.port}`)
    assert.match(started.sas, /^\d{3} \d{3}$/)
    const [pending] = peerServer.pendingPairs()
    const approved = peerServer.approve(pending.pairId)
    tokens.set(host.state.identity.id, approved.token)
    const peerId = started.peer.id
    for (let attempt = 0; attempt < 40 && !host.listPeers().some((peer) => peer.trusted); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(host.listPeers().some((peer) => peer.trusted && peer.id === peerId), 'pairing must complete')

    const pushed = await host.push(peerId)
    assert.equal(pushed.ok, true)
    assert.ok(received !== null)
    assert.equal(received.snapshot.entries.find((entry) => entry.id === 'ui-theme').config.preference, 'dark')

    const pulled = await host.pull(peerId, { force: true })
    assert.equal(pulled.ok, true)
    assert.ok(edits.some((edit) => edit.id === 'ui-theme' && edit.next.preference === 'light'))
    assert.equal(host.state.pendingReload.from, 'machine-b')
    assert.ok(host.state.pendingReload.changes >= 1)

    const daily = await host.checkNow()
    assert.equal(daily.diffs.length, 0)

    const before = await capture(services, { profile: 'test', host: 'machine-a' })
    assert.equal(before.snapshot.entries.find((entry) => entry.id === 'ui-theme').config.preference, 'light')
  } finally {
    await host.stop()
    await peerServer.close()
  }
})

check('pull refuses to overwrite unsynced local changes without force', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-lan-home-'))
  const { services, edits } = mockServices()
  const local = await capture(services, { profile: 'test', host: 'machine-a' })
  const remoteSnapshot = JSON.parse(JSON.stringify(local.snapshot))
  remoteSnapshot.entries.find((entry) => entry.id === 'ui-theme').config.preference = 'light'
  const tokens = new Map()
  const peerServer = createLanServer({
    identity: createIdentity('machine-b'),
    port: 0,
    getState: async () => ({ hash: hashSnapshot(remoteSnapshot), profile: 'test' }),
    getSnapshot: async () => remoteSnapshot,
    applyPush: async () => ({ ok: true }),
    getPeerToken: (peerId) => tokens.get(peerId),
  })
  const peerBound = await peerServer.listen()
  const host = createLanHost({
    config: { lanEnabled: true, lanPort: 0, lanDiscoveryPort: 0, excludeEntries: [], prune: false },
    servicesOf: () => services,
    captureOptions: () => ({ profile: 'test', host: 'machine-a' }),
  })
  try {
    await host.init()
    await host.start()
    const started = await host.pair(`http://127.0.0.1:${peerBound.port}`)
    const [pending] = peerServer.pendingPairs()
    tokens.set(host.state.identity.id, peerServer.approve(pending.pairId).token)
    for (let attempt = 0; attempt < 40 && !host.listPeers().some((peer) => peer.trusted); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await host.pull(started.peer.id, { force: true })
    edits.length = 0
    // Change the profile after the last sync: the next pull must stop.
    await services.edit({ options: { id: 'llm-test', name: 'dsh-llm-test', config: { baseURL: 'http://changed', apiKey: 'sk' } } }, (current) => ({ ...current, baseURL: 'http://changed' }))
    const blocked = await host.pull(started.peer.id)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'local-changes')
    const forced = await host.pull(started.peer.id, { force: true })
    assert.equal(forced.ok, true)
  } finally {
    await host.stop()
    await peerServer.close()
  }
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.stack ?? error}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} LAN checks passed`)
process.exit(failed === 0 ? 0 : 1)
