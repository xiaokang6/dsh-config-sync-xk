# @xiaokang6/dsh-config-sync — design

Goals: keep one DSH profile's configuration identical across devices, through
坚果云 (Nutstore) WebDAV or GitHub, with no data loss and no surprises.

## Scope (v1)

Synced files, relative to the active profile directory (default scope):

| file | why |
| --- | --- |
| `package.json` | plugin dependencies + `dsh.profile.bundles` |
| `cordis.patch.yml` | the user's patch layer (model providers, MCP rows, toggles) |
| `cordis.yml` | profile root entry list (usually `[]`) |
| `pnpm-lock.yaml` | reproducible plugin versions |

Never synced: `node_modules/`, `.dsh-market/snapshots/`, sessions, attachments.
`~/.dsh/.credentials.yaml` and `.env` are **not** synced in v1: the UI warns
that `cordis.patch.yml` may already contain inline secrets.

## Safety rules (learned the hard way)

1. Never write outside the profile directory; paths are validated (no `..`, no
   absolute paths, no symlinked parents).
2. Every apply creates a local backup of the files it is about to touch under
   `$DSH_HOME/config-sync/backups/<timestamp>-<op>/`, with a manifest.
3. Writes are atomic (temp file + rename), UTF-8 without BOM.
4. `node_modules` is never edited directly. After pulling `package.json` /
   `pnpm-lock.yaml`, the plugin runs `pnpm install` (preferring the host-published
   package manager, else PATH pnpm) and only marks "restart required".
5. A pull that would leave `package.json` with zero dependencies while it had
   some before is **refused** unless the user explicitly allows it — the
   market's restore flow once wiped `node_modules` exactly this way.
6. Deletions are not propagated by default: a file missing on one side is
   reported, not deleted on the other side.
7. Secrets (WebDAV password, GitHub token, encryption passphrase) are stored in
   `$DSH_HOME/config-sync/remote.json` (0600, local-only), never in the synced
   profile files and never echoed back over HTTP.

## Conflict model (per user's choice)

Per-file content hashes, three-way with the last-synced state as the base:

- local changed only → push
- remote changed only → pull
- both changed to the same hash → no-op
- both changed differently → **conflict**: the local file is left untouched, the
  remote version is written next to it as `<name>.remote-<device>-<yyyyMMddHHmmss>`,
  and the UI lists it with "采用远端 / 采用本地" actions.
- **first sync on a new device** (no merge base yet): the remote is adopted for
  files that differ, and the local version is kept as
  `<name>.local-<device>-<yyyyMMddHHmmss>`; nothing is lost, and the device
  starts from the other machines' configuration instead of a wall of conflicts.
  A push-only run is explicit and still uploads the local side.

## Remote layout

```
<remote root>/manifest.json
<remote root>/files/<relative file path>     # raw text, or AES-256-GCM envelope
```

`manifest.json`:

```json
{
  "schema": 1,
  "profile": "desktop",
  "deviceId": "uuid",
  "deviceName": "hostname",
  "syncAt": 1793330000000,
  "crypto": { "enabled": false, "alg": "aes-256-gcm" },
  "files": {
    "cordis.patch.yml": { "sha256": "…", "size": 5347, "remotePath": "files/cordis.patch.yml" }
  }
}
```

Local state (`$DSH_HOME/config-sync/state/<profile>.json`) remembers the last
synced hash of every file (the merge base) plus the remote identity.

## Components

- `lib/index.js` — plugin entry: Config schema, profile resolution, route mount.
- `lib/routes.js` — `/dsh-config-sync/*` HTTP API (`docs/http-api.md`).
- `lib/sync/engine.js` — plan + apply, backups, conflict records, state.
- `lib/sync/paths.js` — DSH home / profile / device / local config paths.
- `lib/sync/manifest.js` — hashing, manifest (de)serialization, validation.
- `lib/sync/crypto.js` — AES-256-GCM envelope (scrypt key derivation).
- `lib/sync/backup.js` — local backups + restore.
- `lib/sync/pnpm.js` — safe `pnpm install` runner.
- `lib/sync/remotes/*` — WebDAV + GitHub adapters (`docs/remote-interface.md`).
- `client/client.js` — settings-page UI (hand-written CJS factory, React only).

## Verification

- `node --test test/` — unit + remote-adapter tests against in-memory mock
  WebDAV/GitHub servers, plus an end-to-end engine test over a temp profile.
- Real-machine check against 坚果云 WebDAV (user-provided app password).
- Install into the `desktop` profile via `scripts/install.mjs` (`link:` +
  bundle row) and verify the market/settings page still load.
