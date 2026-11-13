/**
 * LAN transport for profile sync.
 *
 * No dependency on Cordis or the host: this module owns the wire and the
 * trust model only.
 *
 * Trust model
 * -----------
 * Two machines pair ONCE, without any secret crossing the wire:
 *
 *   1. A → B: POST /pair/offer  { id, name, port, x, nonce }  (x = ephemeral X25519 public key)
 *   2. B   : computes shared = ECDH(B.eph, A.x) and a 6-digit SAS from the
 *            shared secret, both public keys and both ids.
 *   3. A   : receives B's ephemeral key + SAS, computes the same shared secret.
 *   4. HUMAN on both screens compares the SAS; B approves locally (the button
 *      lives in B's own UI, never over the network).
 *   5. Both derive  token = SHA-256(shared || protocol || sorted ids) and store
 *      it for that peer. The code never travels: an eavesdropper only sees
 *      public keys, and the SAS pins the ECDH channel.
 *
 * Every later call is signed: HMAC-SHA256(token, method\npath\nts\nnonce\nbodyHash),
 * inside a 120s window, with a per-peer nonce replay cache.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'

export const PROTOCOL = 'dsh-profile-sync/1'
export const DEFAULT_PORT = 47931
export const DEFAULT_DISCOVERY_PORT = 47932
export const ANNOUNCE_MS = 5000
export const PAIR_TTL_MS = 120_000
export const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_CLOCK_SKEW_MS = 120_000
const NONCE_TTL_MS = 10 * 60_000
const MAX_PENDING_PAIRS = 5

/* --------------------------------------------------------------- encoding */

export function b64u(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function fromB64u(text) {
  return Buffer.from(text, 'base64url')
}

export function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

/* --------------------------------------------------------------- identity */

/**
 * Stable device identity for the LAN protocol.
 * @param {string | (() => string)} hostname - machine name, or a getter for tests.
 * @returns {{ id: string, name: string }}
 */
export function createIdentity(hostname) {
  const name = typeof hostname === 'function' ? hostname() : String(hostname)
  return { id: sha256hex(`${PROTOCOL}:${name}:${randomBytes(8).toString('hex')}`).slice(0, 16), name }
}

/* ---------------------------------------------------------------- pairing */

/** One ephemeral X25519 key pair, exported as a raw JWK public key. */
export function createEphemeral() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } }
}

function publicKeyFromJwk(jwk) {
  if (jwk?.kty !== 'OKP' || jwk?.crv !== 'X25519' || typeof jwk.x !== 'string') {
    throw new Error('pairing: the peer sent an invalid X25519 key')
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: jwk.x }, format: 'jwk' })
}

/** ECDH shared secret between our ephemeral key and the peer's public JWK. */
export function sharedSecret(privateKey, peerJwk) {
  return diffieHellman({ privateKey, publicKey: publicKeyFromJwk(peerJwk) })
}

/** Six-digit short authentication string shown on both screens. */
export function sasCode(shared, idA, idB, xA, xB) {
  const ids = [idA, idB].sort()
  const keys = [xA, xB].sort()
  const digest = createHash('sha256')
    .update(PROTOCOL)
    .update('\0sas\0')
    .update(shared)
    .update(ids.join('\0'))
    .update(keys.join('\0'))
    .digest()
  const value = digest.readUInt32BE(0) % 1_000_000
  const text = String(value).padStart(6, '0')
  return `${text.slice(0, 3)} ${text.slice(3)}`
}

/** Long-lived per-peer bearer token, derived from the paired shared secret. */
export function pairToken(shared, idA, idB) {
  const ids = [idA, idB].sort()
  return createHash('sha256')
    .update(PROTOCOL)
    .update('\0token\0')
    .update(shared)
    .update(ids.join('\0'))
    .digest('hex')
}

/* ------------------------------------------------------------------ hmac */

export function signaturePayload({ method, path, ts, nonce, bodyHash }) {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`
}

export function signRequest(token, request) {
  return createHmac('sha256', token).update(signaturePayload(request)).digest('base64url')
}

export function verifySignature(token, request, signature) {
  if (typeof signature !== 'string' || signature === '') return false
  return safeEqual(signRequest(token, request), signature)
}

/* ------------------------------------------------------------------- http */

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readJson(text) {
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

function canonicalUrl(text) {
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('peer URL is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('peer URL must be http or https')
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

/* -------------------------------------------------------------- discovery */

/**
 * UDP discovery: every machine announces its id, name, port and a short
 * snapshot hash on the LAN, and listens for the others.
 * @returns start/stop/scan controls and the live peer map.
 */
export function createDiscovery({ identity, port, getAnnouncement, discoveryPort = DEFAULT_DISCOVERY_PORT, intervalMs = ANNOUNCE_MS, onPeer, log = () => {} }) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  let timer
  let started = false

  const announce = () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, kind: 'profile-sync', id: identity.id, name: identity.name, port, ...getAnnouncement() }))
    try {
      socket.send(payload, 0, payload.length, discoveryPort, '255.255.255.255')
    } catch (error) {
      log(`discovery announce failed: ${error.message}`)
    }
  }

  socket.on('message', (buffer, rinfo) => {
    let message
    try {
      message = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (message?.kind !== 'profile-sync' || message.v !== 1) return
    if (message.id === identity.id) return
    if (typeof message.id !== 'string' || typeof message.name !== 'string') return
    onPeer?.({
      id: message.id,
      name: message.name,
      url: `http://${rinfo.address}:${Number(message.port) || DEFAULT_PORT}`,
      profile: typeof message.profile === 'string' ? message.profile : '',
      hash: typeof message.hash === 'string' ? message.hash : '',
      seenAt: Date.now(),
    })
  })
  socket.on('error', (error) => log(`discovery socket error: ${error.message}`))

  return {
    start() {
      if (started) return
      started = true
      socket.bind(discoveryPort, () => {
        try {
          socket.setBroadcast(true)
        } catch (error) {
          log(`discovery broadcast unavailable: ${error.message}`)
        }
        announce()
        timer = setInterval(announce, intervalMs)
        timer.unref?.()
      })
    },
    scan() {
      announce()
    },
    stop() {
      started = false
      if (timer) clearInterval(timer)
      timer = undefined
      try {
        socket.close()
      } catch {}
    },
  }
}

/* ----------------------------------------------------------------- server */

/**
 * The peer-to-peer HTTP server one machine exposes on the LAN.
 *
 * @param {object} options
 * @param {{id: string, name: string}} options.identity
 * @param {number} options.port - listening port (0.0.0.0).
 * @param {() => Promise<{hash: string, profile: string, exportedAt?: string}>} options.getState
 * @param {(peerId: string, snapshot: unknown) => Promise<{ok: boolean, [key: string]: unknown}>} options.applyPush
 * @param {() => Promise<unknown>} options.getSnapshot - full snapshot for a trusted peer.
 * @param {(peerId: string) => string | undefined} options.getPeerToken
 * @param {(request: object) => void} options.onPairRequest
 * @param {() => Array<{id: string, name: string, token: string}>} options.listPeers - trusted peers (for the UI).
 * @param {(message: string) => void} [options.log]
 */
export function createLanServer({ identity, port, getState, getSnapshot, applyPush, getPeerToken, onPairRequest, log = () => {} }) {
  const pending = new Map()
  const nonces = new Map()
  const offersByIp = new Map()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lan.internal')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/profile-sync/lan/hello') {
        const state = await getState()
        send(res, 200, { v: 1, id: identity.id, name: identity.name, port, profile: state.profile, hash: state.hash, exportedAt: state.exportedAt ?? null })
        return
      }

      if (req.method === 'POST' && path === '/profile-sync/lan/pair/offer') {
        const ip = req.socket.remoteAddress ?? 'unknown'
        const window = offersByIp.get(ip) ?? { count: 0, resetAt: Date.now() + 60_000 }
        if (Date.now() > window.resetAt) {
          window.count = 0
          window.resetAt = Date.now() + 60_000
        }
        if (window.count >= 5) throw Object.assign(new Error('too many pairing attempts'), { status: 429 })
        window.count += 1
        offersByIp.set(ip, window)

        const body = readJson(await readBody(req, 64 * 1024))
        if (typeof body.id !== 'string' || body.id.length < 6 || typeof body.name !== 'string') {
          throw Object.assign(new Error('pairing: id and name are required'), { status: 400 })
        }
        if (pending.size >= MAX_PENDING_PAIRS) throw Object.assign(new Error('too many pending pairs'), { status: 429 })
        const eph = createEphemeral()
        const shared = sharedSecret(eph.privateKey, body.x)
        const sas = sasCode(shared, body.id, identity.id, body.x.x, eph.publicKey.x)
        const pairId = randomBytes(16).toString('hex')
        const record = {
          pairId,
          sas,
          shared,
          peer: { id: body.id, name: body.name, port: Number(body.port) || DEFAULT_PORT },
          url: `http://${ip}:${Number(body.port) || DEFAULT_PORT}`,
          nonce: typeof body.nonce === 'string' ? body.nonce : '',
          createdAt: Date.now(),
          status: 'pending',
        }
        pending.set(pairId, record)
        const timer = setTimeout(() => pending.delete(pairId), PAIR_TTL_MS)
        timer.unref?.()
        onPairRequest?.({ pairId, id: record.peer.id, name: record.peer.name, url: record.url, sas, at: record.createdAt })
        send(res, 200, { pairId, sas, id: identity.id, name: identity.name, port, x: eph.publicKey })
        return
      }

      if (req.method === 'GET' && path === '/profile-sync/lan/pair/status') {
        const pairId = url.searchParams.get('pairId') ?? ''
        const nonce = url.searchParams.get('nonce') ?? ''
        const record = pending.get(pairId)
        if (record === undefined || record.nonce !== nonce) throw Object.assign(new Error('unknown pairing'), { status: 404 })
        send(res, 200, { status: record.status })
        return
      }

      /* ---- signed peer calls ---- */
      if (path.startsWith('/profile-sync/lan/p2p/')) {
        const peerId = req.headers['x-ps-peer']
        const ts = Number(req.headers['x-ps-ts'])
        const nonce = req.headers['x-ps-nonce']
        const signature = req.headers['x-ps-sig']
        if (typeof peerId !== 'string' || !Number.isFinite(ts) || typeof nonce !== 'string' || nonce.length < 8) {
          send(res, 401, { ok: false, code: 'unsigned', error: 'missing signature headers' })
          return
        }
        if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
          send(res, 401, { ok: false, code: 'clock-skew', error: 'signed request is outside the allowed clock window' })
          return
        }
        const token = getPeerToken(peerId)
        if (token === undefined) {
          send(res, 401, { ok: false, code: 'untrusted', error: 'this machine is not paired with you' })
          return
        }
        const bodyText = req.method === 'POST' ? await readBody(req) : ''
        const bodyHash = sha256hex(bodyText)
        const request = { method: req.method ?? 'GET', path: path + (url.search || ''), ts: String(ts), nonce, bodyHash }
        if (!verifySignature(token, request, signature)) {
          send(res, 401, { ok: false, code: 'bad-signature', error: 'signature mismatch' })
          return
        }
        const seenAt = nonces.get(`${peerId}:${nonce}`)
        if (seenAt !== undefined && Date.now() - seenAt < NONCE_TTL_MS) {
          send(res, 401, { ok: false, code: 'replay', error: 'nonce already used' })
          return
        }
        nonces.set(`${peerId}:${nonce}`, Date.now())
        if (nonces.size > 5000) {
          for (const [key, at] of nonces) if (Date.now() - at > NONCE_TTL_MS) nonces.delete(key)
        }

        if (req.method === 'GET' && path === '/profile-sync/lan/p2p/state') {
          const state = await getState()
          send(res, 200, { ok: true, id: identity.id, name: identity.name, ...state })
          return
        }
        if (req.method === 'GET' && path === '/profile-sync/lan/p2p/snapshot') {
          send(res, 200, { ok: true, snapshot: await getSnapshot() })
          return
        }
        if (req.method === 'POST' && path === '/profile-sync/lan/p2p/push') {
          const payload = readJson(bodyText)
          if (payload?.snapshot === undefined) throw Object.assign(new Error('push: snapshot is required'), { status: 400 })
          const result = await applyPush(peerId, payload.snapshot)
          send(res, result.ok === false ? 409 : 200, result)
          return
        }
        send(res, 404, { ok: false, code: 'not-found', error: 'unknown peer endpoint' })
        return
      }

      send(res, 404, { ok: false, code: 'not-found', error: 'unknown endpoint' })
    } catch (error) {
      send(res, error.status ?? 500, { ok: false, code: error.status === undefined ? 'error' : 'bad-request', error: error.message ?? String(error) })
    }
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject)
          resolve({ port: server.address().port })
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
    /** Pending incoming pair requests, for the local UI. */
    pendingPairs() {
      return [...pending.values()]
        .filter((record) => record.status === 'pending')
        .map((record) => ({ pairId: record.pairId, id: record.peer.id, name: record.peer.name, url: record.url, sas: record.sas, at: record.createdAt }))
    },
    /** Approve a pending request locally: returns the token the host must persist. */
    approve(pairId, nonce) {
      const record = pending.get(pairId)
      if (record === undefined) throw new Error('unknown or expired pairing request')
      if (nonce !== undefined && record.nonce !== nonce) throw new Error('pairing request does not match')
      record.status = 'approved'
      const token = pairToken(record.shared, record.peer.id, identity.id)
      return { peerId: record.peer.id, name: record.peer.name, url: record.url, token }
    },
    reject(pairId) {
      pending.delete(pairId)
    },
    /** Status lookups (for tests and the local UI). */
    status(pairId) {
      return pending.get(pairId)?.status
    },
  }
}

/* ----------------------------------------------------------------- client */

function requestHeaders(peer, { method, path, bodyText, ts = Date.now(), nonce = randomBytes(12).toString('hex') }) {
  const bodyHash = sha256hex(bodyText)
  const signature = signRequest(peer.token, { method, path, ts: String(ts), nonce, bodyHash })
  return {
    'content-type': 'application/json',
    'x-ps-peer': peer.selfId ?? peer.id,
    'x-ps-ts': String(ts),
    'x-ps-nonce': nonce,
    'x-ps-sig': signature,
  }
}

async function callJson(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    payload = { ok: false, code: 'bad-response', error: `peer answered ${response.status}` }
  }
  return { status: response.status, payload }
}

/** Probe another machine without any trust. */
export async function probePeer(url) {
  const base = canonicalUrl(url)
  const { status, payload } = await callJson(`${base}/profile-sync/lan/hello`)
  if (status !== 200) throw new Error(`the peer answered ${status}`)
  return { url: base, ...payload }
}

/** Signed read of a trusted peer's current hash. */
export async function fetchPeerState(peer) {
  const path = '/profile-sync/lan/p2p/state'
  const { status, payload } = await callJson(`${peer.url}${path}`, { headers: requestHeaders(peer, { method: 'GET', path, bodyText: '' }) })
  if (status !== 200 || payload.ok !== true) throw new Error(payload.error ?? `the peer answered ${status}`)
  return payload
}

/** Signed read of a trusted peer's full snapshot. */
export async function fetchPeerSnapshot(peer) {
  const path = '/profile-sync/lan/p2p/snapshot'
  const { status, payload } = await callJson(`${peer.url}${path}`, { headers: requestHeaders(peer, { method: 'GET', path, bodyText: '' }) })
  if (status !== 200 || payload.ok !== true) throw new Error(payload.error ?? `the peer answered ${status}`)
  return payload.snapshot
}

/** Signed push of our snapshot to a trusted peer. */
export async function pushSnapshot(peer, snapshot) {
  const path = '/profile-sync/lan/p2p/push'
  const bodyText = JSON.stringify({ snapshot })
  const { status, payload } = await callJson(`${peer.url}${path}`, {
    method: 'POST',
    headers: requestHeaders(peer, { method: 'POST', path, bodyText }),
    body: bodyText,
    timeoutMs: 30_000,
  })
  return { status, result: payload }
}

/** Step 1 of pairing: offer our ephemeral key to a peer we found. */
export async function startPairing(url, identity, port) {
  const base = canonicalUrl(url)
  const eph = createEphemeral()
  const nonce = randomBytes(12).toString('hex')
  const { status, payload } = await callJson(`${base}/profile-sync/lan/pair/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: identity.id, name: identity.name, port, x: eph.publicKey, nonce }),
  })
  if (status !== 200 || typeof payload.pairId !== 'string') throw new Error(payload.error ?? `the peer answered ${status}`)
  const shared = sharedSecret(eph.privateKey, payload.x)
  const sas = sasCode(shared, identity.id, payload.id, eph.publicKey.x, payload.x.x)
  return {
    url: base,
    pairId: payload.pairId,
    sas,
    nonce,
    peer: { id: payload.id, name: payload.name },
    token: pairToken(shared, identity.id, payload.id),
  }
}

/** Step 2: wait for the human on the other machine to approve. */
export async function pollPairing(url, pairId, nonce, { attempts = 40, delayMs = 1500 } = {}) {
  const base = canonicalUrl(url)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { status, payload } = await callJson(`${base}/profile-sync/lan/pair/status?pairId=${encodeURIComponent(pairId)}&nonce=${encodeURIComponent(nonce)}`)
    if (status === 404) throw new Error(payload.error ?? 'pairing request expired')
    if (payload.status === 'approved') return true
    if (payload.status === 'rejected') return false
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}
