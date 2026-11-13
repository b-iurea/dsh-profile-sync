/**
 * Host-side LAN manager: peer book, pairing lifecycle, discovery, signed
 * push/pull and the daily diff check.
 *
 * The wire and the trust model live in ./lan.js; this module owns the state
 * that must survive a restart (~/.dsh/profile-sync/lan.json, mode 0600) and
 * the calls into the profile (capture/apply via the injected services).
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { assertSnapshot, backupSnapshot, capture, applyPlan, hashSnapshot, isEmptyPlan, planCounts, planPull, stateDir } from './sync.js'
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_PORT,
  createDiscovery,
  createIdentity,
  createLanServer,
  fetchPeerSnapshot,
  fetchPeerState,
  probePeer,
  pushSnapshot,
  startPairing,
} from './lan.js'

const DAILY_MS = 24 * 60 * 60 * 1000

function lanPath() {
  return join(stateDir(), 'lan.json')
}

function emptyState() {
  return { version: 1, identity: null, peers: [], pendingReload: null, daily: null, enabled: null }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(lanPath(), 'utf8'))
    return { ...emptyState(), ...parsed, peers: Array.isArray(parsed.peers) ? parsed.peers : [] }
  } catch {
    return emptyState()
  }
}

async function saveState(state) {
  await mkdir(stateDir(), { recursive: true })
  const path = lanPath()
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

/** Remove a peer from the book (token included). */
export function forgetPeer(state, peerId) {
  state.peers = state.peers.filter((peer) => peer.id !== peerId)
  return state
}

/**
 * @param {object} options
 * @param {object} options.config - the plugin row config.
 * @param {() => object} options.servicesOf - resolves pluginManager/configEditor.
 * @param {(config: object) => object} options.captureOptions - profile/host/excludeEntries for capture().
 * @param {(message: string) => void} [options.log]
 */
export function createLanHost({ config, servicesOf, captureOptions, log = () => {} }) {
  const state = emptyState()
  let ready = null
  let server = null
  let discovery = null
  let dailyTimer = null
  let started = false
  const discovered = new Map()
  const outgoing = new Map()
  let hashCache = { at: 0, hash: '', profile: '', exportedAt: null }

  const portOr = (value, fallback) => (value === 0 || value === '0' ? 0 : Number(value) || fallback)
  /** Runtime switch lives in lan.json; the config value is only the first-run default. */
  const isEnabled = () => state.enabled ?? config.lanEnabled === true
  const readConfig = () => ({
    enabled: isEnabled(),
    port: portOr(config.lanPort, DEFAULT_PORT),
    discoveryPort: portOr(config.lanDiscoveryPort, DEFAULT_DISCOVERY_PORT),
    autoApply: config.lanAutoApply !== false,
    manualPeers: Array.isArray(config.manualPeers) ? config.manualPeers : [],
  })

  const snapshot = async () => {
    const { snapshot: local, catalog } = await capture(servicesOf(), captureOptions(config))
    return { local, catalog }
  }

  const currentState = async () => {
    if (Date.now() - hashCache.at < 3000 && hashCache.hash !== '') return hashCache
    const { local } = await snapshot()
    hashCache = { at: Date.now(), hash: hashSnapshot(local), profile: local.source?.profile ?? '', exportedAt: local.exportedAt ?? null }
    return hashCache
  }

  const findPeer = (id) => state.peers.find((peer) => peer.id === id)
  /** The peer record plus our own id: signed calls must name the sender. */
  const callPeer = (peer) => ({ ...peer, selfId: state.identity.id })

  const persist = async () => {
    await saveState(state)
  }

  const addPeer = async ({ id, name, url, token }) => {
    const existing = findPeer(id)
    if (existing !== undefined) {
      Object.assign(existing, { name, url, token, lastSeen: Date.now() })
    } else {
      state.peers.push({ id, name, url, token, pairedAt: new Date().toISOString(), lastSeen: Date.now(), hash: null, localHash: null, remoteHash: null, lastSyncAt: null })
    }
    await persist()
  }

  const startServer = async () => {
    if (server !== null) return
    const { port, discoveryPort } = readConfig()
    if (!isEnabled()) return
    server = createLanServer({
      identity: state.identity,
      port,
      getState: currentState,
      getSnapshot: async () => (await snapshot()).local,
      getPeerToken: (peerId) => findPeer(peerId)?.token,
      onPairRequest: () => {},
      log,
      applyPush: (peerId, incoming) => applyRemote(peerId, incoming, {}),
    })
    let bound = null
    for (let attempt = 0; attempt < 3 && bound === null; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        bound = await server.listen()
      } catch (error) {
        log(`LAN peer server failed to listen (attempt ${attempt + 1}): ${error.message}`)
      }
    }
    if (bound === null) {
      // A reload can overlap the previous instance still closing its socket.
      server = null
      setTimeout(() => {
        startServer().catch(() => {})
      }, 1500).unref?.()
      return
    }
    log(`LAN peer server listening on 0.0.0.0:${bound.port}`)
    discovery = createDiscovery({
      identity: state.identity,
      port: server.server.address().port,
      discoveryPort,
      getAnnouncement: () => ({ profile: hashCache.profile, hash: hashCache.hash }),
      onPeer: (peer) => {
        const known = findPeer(peer.id)
        if (known !== undefined) {
          known.url = peer.url
          known.lastSeen = Date.now()
          if (peer.hash) known.hash = peer.hash
        }
        discovered.set(peer.id, { ...peer, seenAt: Date.now() })
      },
      log,
    })
    discovery.start()
    currentState().catch(() => {})
  }

  const stopServer = async () => {
    discovery?.stop()
    discovery = null
    if (server !== null) {
      await server.close().catch(() => {})
      server = null
    }
  }

  const applyRemote = async (peerId, incoming, { force = false } = {}) => {
    assertSnapshot(incoming)
    const peer = findPeer(peerId)
    const { local, catalog } = await snapshot()
    const localHash = hashSnapshot(local)
    const remoteHash = hashSnapshot(incoming)
    if (localHash === remoteHash) {
      return { ok: true, noop: true, summary: 'Already in sync with the peer snapshot.', changes: 0, restartRequired: false }
    }
    if (!force && peer?.localHash && peer.localHash !== localHash && localHash !== remoteHash) {
      return { ok: false, code: 'local-changes', error: 'This machine changed since the last sync with that peer; pull with force locally or push from here first.' }
    }
    const plan = planPull({ remote: incoming, local, catalog, prune: Boolean(config.prune), excludeEntries: config.excludeEntries })
    const queuedInstalls = plan.install.splice(0)
    const backup = await backupSnapshot(local, 'before-lan-apply')
    const applied = await applyPlan({ plan, catalog, services: servicesOf() })
    state.pendingReload = {
      from: peer?.name ?? incoming.source?.host ?? 'peer',
      at: new Date().toISOString(),
      changes: applied.changes.length,
      warnings: applied.warnings,
      restartRequired: applied.restartRequired,
      queuedInstalls,
      backup,
    }
    if (peer !== undefined) {
      peer.localHash = localHash
      peer.remoteHash = remoteHash
      peer.hash = remoteHash
      peer.lastSyncAt = new Date().toISOString()
    }
    await persist()
    return {
      ok: true,
      changes: applied.changes.length,
      warnings: applied.warnings,
      restartRequired: applied.restartRequired,
      queuedInstalls,
      counts: planCounts(plan),
    }
  }

  const listPeers = () => {
    const trusted = state.peers.map((peer) => {
      const seen = discovered.get(peer.id)
      const live = seen !== undefined && Date.now() - seen.seenAt < 30_000
      return {
        id: peer.id,
        name: peer.name,
        url: peer.url,
        trusted: true,
        online: live,
        hash: peer.hash ?? null,
        localHash: peer.localHash ?? null,
        remoteHash: peer.remoteHash ?? null,
        lastSeen: peer.lastSeen ?? null,
        lastSyncAt: peer.lastSyncAt ?? null,
        drift: peer.hash !== null && peer.hash !== hashCache.hash,
      }
    })
    const untrusted = [...discovered.values()]
      .filter((item) => findPeer(item.id) === undefined && item.id !== state.identity.id)
      .map((item) => ({ id: item.id, name: item.name, url: item.url, trusted: false, online: true, hash: item.hash ?? null, drift: item.hash ? item.hash !== hashCache.hash : false }))
    return [...trusted, ...untrusted]
  }

  const check = async () => {
    await ready
    const { local } = await snapshot()
    const localHash = hashSnapshot(local)
    const diffs = []
    for (const peer of state.peers) {
      try {
        const remote = await fetchPeerState(callPeer(peer))
        peer.hash = remote.hash
        peer.lastSeen = Date.now()
        if (remote.hash !== localHash) diffs.push({ peerId: peer.id, name: peer.name, remoteHash: remote.hash, localHash })
      } catch (error) {
        log(`LAN check failed for ${peer.name}: ${error.message}`)
      }
    }
    state.daily = { at: new Date().toISOString(), diffs }
    await persist()
    return state.daily
  }

  const host = {
    get ready() {
      return ready
    },
    state,
    async init() {
      ready = (async () => {
        const loaded = await loadState()
        Object.assign(state, loaded)
        if (state.identity === null || typeof state.identity.id !== 'string') {
          state.identity = createIdentity(hostname)
          await persist()
        }
        if (typeof state.enabled !== 'boolean') {
          state.enabled = config.lanEnabled === true
          await persist()
        }
        await startServer()
        for (const url of readConfig().manualPeers) {
          try {
            const hello = await probePeer(url)
            discovered.set(hello.id, { id: hello.id, name: hello.name, url: hello.url, hash: hello.hash, seenAt: Date.now() })
          } catch (error) {
            log(`manual peer ${url} unreachable: ${error.message}`)
          }
        }
      })()
      await ready
      return host
    },
    startDailyChecks() {
      if (dailyTimer !== null) return
      dailyTimer = setInterval(() => {
        check().catch(() => {})
      }, DAILY_MS)
      dailyTimer.unref?.()
      setTimeout(() => {
        check().catch(() => {})
      }, 90_000).unref?.()
    },
    async start() {
      if (started) return
      started = true
      await startServer()
      if (isEnabled()) host.startDailyChecks()
    },
    async stop() {
      started = false
      if (dailyTimer) clearInterval(dailyTimer)
      dailyTimer = null
      await stopServer()
    },
    async setEnabled(enabled) {
      state.enabled = enabled
      await persist()
      if (enabled) {
        await startServer()
        host.startDailyChecks()
      } else {
        await stopServer()
      }
    },
    async status() {
      await ready
      await currentState()
      return {
        identity: state.identity,
        enabled: isEnabled(),
        port: server?.server.address()?.port ?? readConfig().port,
        discoveryPort: readConfig().discoveryPort,
        peers: listPeers(),
        pendingPairs: server?.pendingPairs() ?? [],
        outgoingPair: [...outgoing.values()].map((item) => ({ sas: item.sas, pairId: item.pairId, peer: item.peer, url: item.url, at: item.at }))[0] ?? null,
        pendingReload: state.pendingReload,
        daily: state.daily,
        autoApply: readConfig().autoApply,
      }
    },
    async pair(url) {
      await ready
      if (server === null) throw new Error('LAN sync is disabled on this machine; enable it before pairing.')
      const identity = state.identity
      const startedPairing = await startPairing(url, identity, server.server.address()?.port ?? readConfig().port)
      const record = { ...startedPairing, at: Date.now() }
      outgoing.set(startedPairing.pairId, record)
      // Poll in the background: the human on the other machine approves there.
      ;(async () => {
        try {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            if (!outgoing.has(startedPairing.pairId)) return
            const response = await fetch(`${startedPairing.url}/profile-sync/lan/pair/status?pairId=${encodeURIComponent(startedPairing.pairId)}&nonce=${encodeURIComponent(startedPairing.nonce)}`, { signal: AbortSignal.timeout(5000) })
            const payload = await response.json()
            if (payload.status === 'approved') {
              await addPeer({ id: startedPairing.peer.id, name: startedPairing.peer.name, url: startedPairing.url, token: startedPairing.token })
              outgoing.delete(startedPairing.pairId)
              return
            }
            if (payload.status === 'rejected') {
              outgoing.delete(startedPairing.pairId)
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
        } catch (error) {
          log(`pairing poll failed: ${error.message}`)
        } finally {
          outgoing.delete(startedPairing.pairId)
        }
      })()
      return { pairId: startedPairing.pairId, sas: startedPairing.sas, peer: startedPairing.peer }
    },
    async approve(pairId) {
      await ready
      if (server === null) throw new Error('LAN sync is disabled on this machine')
      const approved = server.approve(pairId)
      const peer = { id: approved.peerId, name: approved.name, url: approved.url, token: approved.token }
      await addPeer(peer)
      return { peer }
    },
    async reject(pairId) {
      await ready
      server?.reject(pairId)
    },
    async forget(peerId) {
      forgetPeer(state, peerId)
      await persist()
    },
    async push(peerId) {
      await ready
      const peer = findPeer(peerId)
      if (peer === undefined) throw new Error('unknown peer')
      const { local } = await snapshot()
      const result = await pushSnapshot(callPeer(peer), local)
      if (result.status !== 200 || result.result?.ok !== true) {
        return { ok: false, code: result.result?.code ?? 'push-failed', error: result.result?.error ?? `the peer answered ${result.status}` }
      }
      peer.hash = hashSnapshot(local)
      peer.localHash = peer.hash
      peer.remoteHash = peer.hash
      peer.lastSyncAt = new Date().toISOString()
      await persist()
      return { ok: true, peer: peer.name, result: result.result }
    },
    async pull(peerId, { force = false } = {}) {
      await ready
      const peer = findPeer(peerId)
      if (peer === undefined) throw new Error('unknown peer')
      const incoming = await fetchPeerSnapshot(callPeer(peer))
      return applyRemote(peerId, incoming, { force })
    },
    check,
    async checkNow() {
      return check()
    },
    async acknowledgeReload() {
      state.pendingReload = null
      await persist()
    },
    listPeers,
    async peerStatus(peerId) {
      const peer = findPeer(peerId)
      if (peer === undefined) throw new Error('unknown peer')
      const remote = await fetchPeerState(callPeer(peer))
      return { peer: peer.name, hash: remote.hash, exportedAt: remote.exportedAt }
    },
  }
  return host
}
