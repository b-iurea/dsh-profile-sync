/**
 * Client half of dsh-profile-sync: a small overlay panel (pill + card) and the
 * "reload the page" banner. Everything it does goes through /profile-sync/api,
 * which the host plugin exposes behind the standard same-origin browser check.
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-sync',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const inject = ['slots']

    const ACCENT = '#1f6feb'
    const GOOD = '#2ea043'
    const WARN = '#d29922'
    const DIM = 'rgba(230,237,243,0.62)'
    const CARD = 'rgba(17,19,24,0.94)'
    const LINE = 'rgba(255,255,255,0.14)'
    const TEXT = '#e6edf3'

    const styles = {
      pill: {
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 999,
        border: `1px solid ${LINE}`,
        background: CARD,
        color: TEXT,
        font: '12px/1.2 ui-sans-serif, system-ui, sans-serif',
        cursor: 'pointer',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      },
      card: {
        position: 'fixed',
        right: 16,
        bottom: 58,
        zIndex: 60,
        width: 344,
        maxHeight: '70vh',
        overflow: 'auto',
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${LINE}`,
        background: CARD,
        color: TEXT,
        font: '12px/1.45 ui-sans-serif, system-ui, sans-serif',
        boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
      },
      banner: {
        position: 'fixed',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: CARD,
        color: TEXT,
        font: '12px/1.4 ui-sans-serif, system-ui, sans-serif',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      },
      button: {
        padding: '5px 9px',
        borderRadius: 7,
        border: `1px solid ${LINE}`,
        background: 'rgba(255,255,255,0.06)',
        color: TEXT,
        font: '12px/1.2 ui-sans-serif, system-ui, sans-serif',
        cursor: 'pointer',
      },
      primary: {
        padding: '5px 9px',
        borderRadius: 7,
        border: `1px solid ${ACCENT}`,
        background: ACCENT,
        color: '#fff',
        font: '12px/1.2 ui-sans-serif, system-ui, sans-serif',
        cursor: 'pointer',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      name: { fontWeight: 600 },
      dim: { color: DIM },
      peer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 0',
        borderTop: `1px solid ${LINE}`,
      },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '5px 7px',
        borderRadius: 7,
        border: `1px solid ${LINE}`,
        background: 'rgba(0,0,0,0.25)',
        color: TEXT,
        font: '12px/1.2 ui-monospace, monospace',
      },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 999, background: color, flex: 'none' }),
      sas: { font: '600 20px/1.2 ui-monospace, monospace', letterSpacing: 3, margin: '6px 0' },
      error: { color: '#ff7b72', marginTop: 8 },
      section: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${LINE}` },
    }

    async function api(path, body) {
      const response = await fetch(`/profile-sync/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `request failed (${response.status})`)
      if (payload.ok === false) throw new Error(payload.error ?? 'request failed')
      return payload
    }

    function Panel() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [snoozedAt, setSnoozedAt] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          setState(await api('/state'))
          setError('')
        } catch (cause) {
          setError(cause.message ?? String(cause))
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 8000)
        return () => clearInterval(timer)
      }, [refresh])

      const run = React.useCallback(
        async (fn) => {
          setBusy(true)
          try {
            const result = await fn()
            if (result?.summary) setNotice(result.summary)
            setError('')
            await refresh()
          } catch (cause) {
            setError(cause.message ?? String(cause))
          } finally {
            setBusy(false)
          }
        },
        [refresh],
      )

      const pending = state?.pendingReload
      const showBanner = pending !== null && pending !== undefined && pending.at !== snoozedAt
      const trusted = state?.peers?.filter((peer) => peer.trusted) ?? []
      const untrusted = state?.peers?.filter((peer) => !peer.trusted) ?? []
      const pairs = state?.pendingPairs ?? []
      const dotColor = !state?.enabled ? 'rgba(255,255,255,0.35)' : pending || pairs.length > 0 ? WARN : GOOD

      return h(
        React.Fragment,
        null,
        showBanner
          ? h(
              'div',
              { style: styles.banner, role: 'status' },
              h('span', null, `Nuova configurazione da ${pending.from}: ${pending.changes} modifiche applicate.`),
              h(
                'button',
                {
                  style: styles.primary,
                  onClick: () => {
                    api('/reload-seen', {})
                      .catch(() => {})
                      .finally(() => window.location.reload())
                  },
                },
                'Ricarica la pagina',
              ),
              h('button', { style: styles.button, onClick: () => setSnoozedAt(pending.at) }, 'Più tardi'),
            )
          : null,
        open
          ? h(
              'div',
              { style: styles.card },
              h(
                'div',
                { style: { ...styles.row, justifyContent: 'space-between' } },
                h('span', { style: { fontWeight: 700 } }, 'Sincronizzazione profilo'),
                h(
                  'button',
                  { style: styles.button, onClick: () => setOpen(false), title: 'Chiudi' },
                  '×',
                ),
              ),
              h(
                'div',
                { style: { ...styles.row, marginTop: 6 } },
                h('span', { style: styles.dot(dotColor) }),
                h('span', null, state?.enabled ? `LAN attiva · porta ${state.port}` : 'LAN spenta su questa macchina'),
              ),

              !state?.enabled
                ? h(
                    'div',
                    { style: styles.section },
                    h('div', { style: styles.dim }, 'Attiva la LAN per scoprire e accoppiare gli altri PC.'),
                    h(
                      'button',
                      { style: { ...styles.primary, marginTop: 8 }, disabled: busy, onClick: () => run(() => api('/enable', { enabled: true })) },
                      'Attiva LAN',
                    ),
                  )
                : null,

              pairs.length > 0
                ? h(
                    'div',
                    { style: styles.section },
                    h('div', { style: styles.name }, 'Richieste di accoppiamento'),
                    ...pairs.map((pair) =>
                      h(
                        'div',
                        { key: pair.pairId, style: { paddingTop: 8 } },
                        h('div', { style: styles.dim }, `${pair.name} vuole accoppiarsi`),
                        h('div', { style: styles.sas }, pair.sas),
                        h('div', { style: styles.dim }, 'Confronta il codice sull’altro schermo.'),
                        h(
                          'div',
                          { style: { ...styles.row, marginTop: 6 } },
                          h('button', { style: styles.primary, disabled: busy, onClick: () => run(() => api('/pair/approve', { pairId: pair.pairId })) }, 'Approva'),
                          h('button', { style: styles.button, disabled: busy, onClick: () => run(() => api('/pair/reject', { pairId: pair.pairId })) }, 'Rifiuta'),
                        ),
                      ),
                    ),
                  )
                : null,

              state?.outgoingPair
                ? h(
                    'div',
                    { style: styles.section },
                    h('div', { style: styles.dim }, `In attesa di approvazione su ${state.outgoingPair.peer.name}`),
                    h('div', { style: styles.sas }, state.outgoingPair.sas),
                  )
                : null,

              h(
                'div',
                { style: styles.section },
                h('div', { style: styles.name }, 'PC accoppiati'),
                trusted.length === 0 ? h('div', { style: styles.dim }, 'Nessun peer. Avvia la ricerca qui sotto.') : null,
                ...trusted.map((peer) =>
                  h(
                    'div',
                    { key: peer.id, style: styles.peer },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h(
                        'div',
                        { style: styles.row },
                        h('span', { style: styles.dot(peer.online ? GOOD : 'rgba(255,255,255,0.3)') }),
                        h('span', { style: styles.name }, peer.name),
                      ),
                      h('div', { style: styles.dim }, peer.drift ? 'diverge da questo PC' : peer.lastSyncAt ? `ultimo sync ${new Date(peer.lastSyncAt).toLocaleString()}` : 'ancora da sincronizzare'),
                    ),
                    h(
                      'div',
                      { style: styles.row },
                      h('button', { style: styles.primary, disabled: busy, onClick: () => run(() => api('/push', { peerId: peer.id })) }, 'Push'),
                      h(
                        'button',
                        {
                          style: styles.button,
                          disabled: busy,
                          onClick: () => {
                            if (peer.drift && !window.confirm(`Sovrascrivere le modifiche locali con quelle di ${peer.name}?`)) return
                            run(() => api('/pull', { peerId: peer.id }))
                          },
                        },
                        'Pull',
                      ),
                    ),
                  ),
                ),
                ...untrusted.map((peer) =>
                  h(
                    'div',
                    { key: peer.id, style: styles.peer },
                    h('span', { style: styles.dim }, `${peer.name} (scoperto, non accoppiato)`),
                    h('button', { style: styles.button, disabled: busy, onClick: () => run(() => api('/pair', { url: peer.url })) }, 'Accoppia'),
                  ),
                ),
              ),

              h(
                'div',
                { style: styles.section },
                h('div', { style: styles.name }, 'Accoppia con un PC'),
                h(
                  'div',
                  { style: { ...styles.row, marginTop: 6 } },
                  h('input', { style: styles.input, placeholder: 'http://192.168.1.20:47931', value: url, onChange: (event) => setUrl(event.target.value) }),
                  h('button', { style: styles.primary, disabled: busy || url.trim() === '', onClick: () => run(async () => { const r = await api('/pair', { url: url.trim() }); setUrl(''); return r }) }, 'Accoppia'),
                ),
                h('div', { style: { ...styles.dim, marginTop: 4 } }, 'Il codice a 6 cifre va confrontato a voce o a vista.'),
              ),

              pending
                ? h(
                    'div',
                    { style: styles.section },
                    h('div', { style: styles.name }, 'Aggiornamento applicato'),
                    h('div', { style: styles.dim }, `Da ${pending.from}: ${pending.changes} modifiche${pending.restartRequired ? ' · richiede riavvio' : ''}.`),
                    pending.queuedInstalls?.length
                      ? h('div', { style: styles.dim }, `${pending.queuedInstalls.length} bundle da installare (non automatico): ${pending.queuedInstalls.map((item) => item.name).join(', ')}`)
                      : null,
                    h('button', { style: { ...styles.primary, marginTop: 8 }, onClick: () => run(() => api('/reload-seen', {})) }, 'Segna come visto'),
                  )
                : null,

              h(
                'div',
                { ...styles.section, ...styles.row, justifyContent: 'space-between' },
                h('span', { style: styles.dim }, state?.daily?.at ? `Controllo giornaliero: ${new Date(state.daily.at).toLocaleString()}` : 'Controllo giornaliero: non ancora eseguito'),
                h('button', { style: styles.button, disabled: busy, onClick: () => run(() => api('/check', {})) }, 'Controlla'),
              ),

              state?.enabled
                ? h(
                    'div',
                    { style: styles.section },
                    h('button', { style: styles.button, disabled: busy, onClick: () => run(() => api('/enable', { enabled: false })) }, 'Disattiva LAN'),
                  )
                : null,

              notice ? h('div', { style: { ...styles.dim, marginTop: 8 } }, notice) : null,
              error ? h('div', { style: styles.error }, error) : null,
            )
          : null,
        h(
          'button',
          { style: styles.pill, onClick: () => setOpen((value) => !value), title: 'Sincronizzazione profilo' },
          h('span', { style: styles.dot(dotColor) }),
          'Sync',
          pending || pairs.length > 0 ? h('span', { style: { color: WARN } }, '•') : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-profile-sync:panel',
            order: 60,
            registrant: 'dsh-profile-sync',
            inject: () => ({}),
          },
          Panel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
