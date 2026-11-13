# dsh-profile-sync

Tiene allineati due (o più) computer che usano DeepSeek Harness: provider, plugin
selezionati, righe abilitate/disabilitate e impostazioni dei plugin — quindi anche
tema, font e preferenze della sidebar.

Lo fa con uno **snapshot semantico**, non copiando file: legge il profilo vivo
tramite i servizi `pluginManager` e `configEditor`, quindi applica le differenze
con le stesse API che userebbe Plugin Manager. Il `cordis.patch.yml` del profilo
non viene mai riscritto a mano: commenti, righe `insert` e espressioni `!!js`
restano intatti.

## Cosa sincronizza

| Cosa | Note |
| --- | --- |
| Bundle installati e selezionati | installa quelli mancanti, abilita/disabilita |
| Righe di plugin abilitate/disabilitate | es. un tool shipped spento |
| Configurazione dei plugin | override del profilo: provider, baseURL, modelli, tema, font, sidebar |
| Variabili d'ambiente richieste | solo i **nomi** (`DEEPSEEK_API_KEY`, …) |

## Cosa non sincronizza

- **Credenziali e segreti** (`~/.dsh/.credentials.yaml`, chiavi API inline): restano
  per dispositivo. I campi che sembrano segreti vengono rimossi dallo snapshot e,
  in pull, i valori locali vengono conservati.
- **Layout transitorio** (larghezze pannelli): DSH lo azzera al reload per design.
  Tema, font e preferenze persistenti invece sono configurazione e vengono sincronizzati.
- Sessioni, workspace e cronologia chat.
- Bundle installati da un percorso locale (`link:`/`file:`): su un'altra macchina
  quel percorso non esiste; vanno installati a mano (lo snapshot lo segnala).

## Configurazione

Nel profilo, riga `profile-sync`:

```yaml
- id: profile-sync
  name: dsh-profile-sync
  config:
    repo: 'git@github.com:utente/dsh-profile.git'
    branch: ''            # opzionale
    file: dsh-profile.json
    excludeEntries: []    # id di righe da non sincronizzare (es. percorsi macchina)
    prune: false          # true = rimuove anche override locali assenti dallo snapshot
    lanEnabled: false     # sidecar LAN: spento finché non lo accendi tu
    lanPort: 47931
    lanDiscoveryPort: 47932
    lanAutoApply: true
    manualPeers: []       # URL espliciti se il broadcast UDP non passa (es. reti con VLAN)
```

`repo` accetta:

- un URL Git (`https://`, `git@`, `ssh://`, `file://`): clona in
  `~/.dsh/profile-sync/repo` e fa `pull --ff-only` / `commit` / `push`;
- un percorso di cartella (anche `~/...`): ideale con Syncthing, Dropbox o iCloud.

In alternativa, l'agente può salvarlo:

```
profile_sync { action: "configure", repo: "git@github.com:utente/dsh-profile.git" }
profile_sync { action: "configure", repo: "…", excludeEntries: ["llm-pi-ai"], prune: false }
```

## Uso

Prima macchina (già configurata):

```
profile_sync { action: "push" }
```

Seconda macchina (nuova installazione DSH, plugin installato):

```
profile_sync { action: "configure", repo: "<stesso repo>" }
profile_sync { action: "status" }
profile_sync { action: "pull", dryRun: true }   # anteprima
profile_sync { action: "pull" }
```

Poi riavvia DSH se il risultato dice `restartRequired` (bundle nuovi o cambiati).

### Installare il plugin sulla seconda macchina

Il plugin deve esistere su **entrambe** le macchine prima che possa sincronizzare
qualcosa. Essendo un bundle locale, la via più semplice è tenerlo in un repository
Git suo, clonarlo su ogni PC e installarlo una volta:

```bash
git clone <repo-del-plugin> ~/dsh-profile-sync
```

poi, dal Plugin Manager (o chiedendo all'agente), installa il bundle da
`~/dsh-profile-sync`. Da quel momento gli aggiornamenti del plugin sono un `git pull`.

- `status` confronta locale, snapshot e ultima sincronizzazione, e mostra il piano.
- `push` rifiuta di sovrascrivere uno snapshot modificato altrove: prima `pull`,
  oppure `force: true`.
- `pull` rifiuta di sovrascrivere modifiche locali fatte dopo l'ultimo sync:
  `force: true` fa vincere lo snapshot.
- Prima di ogni `pull` viene salvato un backup in
  `~/.dsh/profile-sync/backups/<timestamp>-before-pull/`.
- Lo stato dell'ultimo sync è in `~/.dsh/profile-sync/state.json`; in modalità Git
  ogni macchina lascia anche `machines/<hostname>.json` nel repository.

## Sidecar LAN (senza Git)

Con `lanEnabled: true` il plugin espone un piccolo server P2P sulla LAN
(`0.0.0.0:47931`) e si annuncia via UDP broadcast su `47932`. Serve per spingere
la configurazione da un PC all'altro con un pulsante, senza passare da GitHub.

1. Accendi la LAN su entrambi i PC: pannello **Sync** in basso a destra, oppure
   `profile_sync { action: "lan-enable" }`.
2. Scegli il PC scoperto e premi **Accoppia** (in alternativa incolla il suo URL
   `http://<ip>:47931`). Compare un codice a 6 cifre su entrambi gli schermi:
   confrontalo e approva sul PC che riceve la richiesta.
3. Da quel momento i due PC sono fidati: **Push** invia lo snapshot, il ricevente
   lo applica subito (con backup) e mostra un banner "Ricarica la pagina".
4. Ogni 24 ore un controllo confronta gli hash e segnala la divergenza; il pulsante
   **Controlla** lo esegue subito.

La fiducia non è a chiave condivisa in chiaro: l'accoppiamento usa X25519 e il
codice a 6 cifre lega il canale; ogni chiamata successiva è firmata HMAC-SHA256
con un token derivato dal segreto ECDH, finestra di 120 s e cache anti-replay.
I peer fidati e i loro token stanno in `~/.dsh/profile-sync/lan.json` (0600).

Cosa NON fa il sidecar: non trasporta sessioni, non esegue tool sull'altro PC, non
installa bundle automaticamente. I bundle mancanti finiscono in una coda e vanno
installati a mano (supply chain). Il server ascolta solo quando `lanEnabled` è true.

## Note

- Le versioni dei bundle non vengono aggiornate automaticamente: lo snapshot le
  riporta e `status` segnala le differenze.
- L'ordine dei bundle nel profilo non è garantito: i bundle nuovi vengono accodati
  (come farebbe `dsh plugin add`). Per la maggior parte dei casi non cambia nulla.
- Le variabili d'ambiente referenziate vanno impostate su entrambe le macchine:
  il plugin non le copia.
- Il sidecar LAN è pensato per una rete fidata (casa/ufficio). Se il PC di lavoro
  è su una rete gestita, tieni `lanEnabled: false` lì e usa Git.
- Verifica offline: `node test/smoke.mjs`, `node test/lan-smoke.mjs`,
  `node test/client-smoke.mjs`.
- **Endpoint diversi per macchina** (es. un baseURL sulla LAN di casa che al lavoro
  non esiste): la riga `profile-sync` non viene mai esportata, quindi ogni macchina
  può avere la propria lista `excludeEntries`. Le righe elencate lì non vengono
  né esportate con `push` né applicate con `pull`; restano configurazione locale.

  ```yaml
  # sul PC di casa
  excludeEntries: []
  # sul PC del lavoro: tieni fuori i provider che puntano alla LAN di casa
  excludeEntries: ['llm-deepseek', 'llm-pi-ai']
  ```

  `status` e `pull --dryRun` mostrano le righe saltate con il motivo
  `excluded on this machine (excludeEntries)`.
