# `/dsh-config-sync/*` HTTP API (v1)

Every route is registered on the host `webServer` as `{ kind: 'exact', path, handler }`.
Handlers are plain `(request, response)`; JSON responses are
`{'cache-control':'no-store','content-type':'application/json; charset=utf-8'}`.
All payloads are `{ ok: true, ... }` or `{ ok: false, error: string }`.
Bodies are JSON capped at 64 KiB; `readJsonBody` handles parsing.

## Guard

Every **POST** route runs the same-origin guard before doing anything:

- if `host` header is present, it must name a loopback authority
  (`127.0.0.1`, `localhost`, `[::1]`) or one of the host-declared trusted
  authorities (read from `ctx.get('connection')?.trustedHosts`, optional);
- `sec-fetch-site: cross-site` is always refused;
- when `origin` is present it must match `host` (absent `origin` is allowed —
  the Desktop proxy strips it);
- on a plain `dsh web` deployment the host's own request gate
  (`connection.requestRejection`) is consulted and its status passed through;
  on the official Desktop host the gate is skipped because that host ends
  browser auth in its own proxy (the same reason the market disables its gate
  there, #648);
- refusal: `403 { ok:false, error: 'untrusted origin' }`.
- validation or engine failures answer `400 { ok:false, error }`; the UI shows
  the server's message.

## Routes

### `GET /dsh-config-sync/status`

```json
{
  "ok": true,
  "version": "0.1.0",
  "profile": { "name": "desktop", "dir": "C:\\Users\\…\\.dsh\\profiles\\desktop" },
  "device": { "id": "uuid", "name": "hostname" },
  "remote": { "kind": "webdav", "label": "坚果云 WebDAV", "root": "https://…",
              "configured": true, "hasPassword": true, "hasToken": false,
              "probe": { "ok": true, "latencyMs": 210, "detail": "" } },
  "scope": ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-lock.yaml"],
  "crypto": { "enabled": false },
  "direction": "both",
  "lastSync": { "at": 1793330000000, "remote": "webdav", "ok": true } ,
  "busy": false,
  "pendingRestart": false,
  "conflicts": [ { "file": "cordis.patch.yml", "remoteFile": "cordis.patch.yml.remote-dev-ab12cd-20261030-131500",
                   "at": 1793330000000 } ],
  "logTail": [ { "at": 1793330000000, "level": "info", "event": "sync", "detail": "…" } ],
  "backups": [ { "id": "20261030-131500-both", "at": 1793330000000, "op": "both", "files": ["package.json"] } ]
}
```

`probe` is `null` until a probe ran; `GET /status` never probes (fast, no network).

### `GET /dsh-config-sync/config`

```json
{ "ok": true,
  "remote": { "kind": "webdav", "baseUrl": "https://dav.jianguoyun.com/dav/",
              "username": "me@example.com", "path": "dsh-config-sync/desktop",
              "owner": "", "repo": "", "branch": "main",
              "hasPassword": true, "hasToken": false },
  "crypto": { "enabled": false, "hasPassphrase": false },
  "scope": [...], "direction": "both", "autoSyncOnStart": true }
```

### `POST /dsh-config-sync/config`

```json
{ "remote": { "kind": "webdav", "baseUrl": "…", "username": "…", "password": "…", "path": "…" },
  "crypto": { "enabled": false, "passphrase": "" },
  "scope": ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-lock.yaml"],
  "direction": "both", "autoSyncOnStart": true }
```

Empty/missing secret fields keep the stored value; `password: ""` clears it.
Answer: `{ ok: true, config: <same as GET /config> }`.
Secrets are written to `$DSH_HOME/config-sync/remote.json` (mode 0600) and never
returned.

### `POST /dsh-config-sync/probe`

Body: optional remote override, otherwise stored settings.
Answer: `{ ok: true, probe: { ok, latencyMs, detail } }` (probe failures still
answer `ok:true` with `probe.ok:false`; only transport errors are `ok:false`).

### `POST /dsh-config-sync/check`

```json
{ "direction": "both" }   // optional; defaults to the configured direction
```

Dry run, no writes. Answer:

```json
{ "ok": true,
  "plan": {
    "direction": "both",
    "files": [ { "file": "package.json", "localSha": "…", "remoteSha": "…",
                 "baseSha": "…", "action": "push" | "pull" | "conflict" | "same" | "only-local" | "only-remote" | "skipped" } ],
    "summary": { "push": 1, "pull": 0, "conflict": 0, "same": 3 }
  } }
```

### `POST /dsh-config-sync/sync`

```json
{ "direction": "push" | "pull" | "both", "dryRun": false }
```

Answer:

```json
{ "ok": true, "report": {
  "direction": "both",
  "pushed": ["cordis.patch.yml"], "pulled": [],
  "conflicts": [], "localCopies": [ { "file": "cordis.yml", "copy": "cordis.yml.local-pc-20261030-131500", "reason": "first-sync-adopt-remote" } ],
  "skipped": [], "errors": [],
  "backupId": "20261030-131500-both",
  "restartRequired": false,
  "pnpm": { "ran": false, "ok": true, "outputTail": "" },
  "manifestSyncAt": 1793330000000 } }
```

A conflict never fails the run; it is reported and left for `/conflict`.
Failures answer **HTTP 409 with `{ ok:false, report }`** (the report is still
rendered by the UI, so a partially-applied run stays visible). An `ok:false`
answer with no report means nothing was changed (the backup is still listed).

### `POST /dsh-config-sync/conflict`

```json
{ "file": "cordis.patch.yml", "action": "use-local" | "use-remote" }
```

`use-remote`: replace the local file with the saved remote copy (backup first);
`use-local`: keep local and clear the conflict entry (the next sync pushes it).

### `GET /dsh-config-sync/backups`

`{ ok: true, backups: [ { id, at, op, files, remoteKind } ] }`

### `POST /dsh-config-sync/backups/restore`

`{ "id": "20261030-131500-both" }` → restores the files listed in that backup
(atomic, own backup first). Answer
`{ ok: true, report: { id, restored: ["package.json"], restartRequired: true } }`.

### `GET /dsh-config-sync/logs?tail=200`

`text/plain; charset=utf-8` NDJSON export (redacted), capped at 2000 lines.

### `GET /dsh-config-sync/update`

Read-only look at this plugin's own installation. The profile's dependency spec
decides the form, so the panel need not know how the user installed it:

```json
{
  "ok": true,
  "update": {
    "form": "git",                  // "git" | "link" | "registry"
    "spec": "github:xiaokang6/dsh-config-sync",
    "canApply": true,
    "pinned": "aeeb63c",            // commit in pnpm-lock.yaml (git form)
    "latest": "49b444a",            // refs/heads/<ref> on GitHub
    "upToDate": false,              // absent when either side could not be read
    "via": "refs",                  // "refs" | "api" | "git" | "pinned"
    "detail": "a newer commit is published; press 一键升级"
  }
}
```

The ref lookup is HTTPS first — GitHub's smart-HTTP advertisement
(`/info/refs?service=git-upload-pack`, validated for its service prelude and a
40-hex ref line before it is believed), then the REST API, then the `git` binary —
so a host without git on `PATH`, or with git's own proxy unconfigured, still gets
an answer. When `HTTP(S)_PROXY` is set the request goes through undici's
`EnvHttpProxyAgent`, because Node's global `fetch` ignores those variables.
`upToDate` is omitted rather than guessed: an unreadable pin and an unreachable
ref are both "unknown", and `detail` carries every attempt's failure — never a
false "already up to date" and never a false "update waiting".

A `link:` install answers `behind` (commits behind its upstream) and `dirty`
(uncommitted tracked edits) instead; `canApply` is false when the worktree is
dirty, because a web route must not move someone's work aside.

### `POST /dsh-config-sync/update`

Guarded (same-origin + host gate, like every mutating route). Upgrades the
installed copy and reports what moved:

- `git` form — `pnpm update dsh-config-sync` in the profile; the pin moving is
  the proof, `restartRequired` follows it.
- `link` form — `git merge --ff-only @{upstream}` in the checkout; refused with
  `ran: false` when tracked edits are uncommitted.
- no dependency / nothing to do — `ok: false` with HTTP 409 and a readable
  `detail`.

```json
{
  "ok": true,
  "update": {
    "ran": true, "ok": true, "form": "git",
    "pinBefore": "aeeb63c", "pinAfter": "49b444a",
    "restartRequired": true,
    "outputTail": "…pnpm tail…",
    "detail": "aeeb63c → 49b444a"
  }
}
```

Nothing here restarts the host: DSH keeps ESM modules in memory, so the panel
says "reload" (header refresh button) instead of pretending the new code is live.

## Client expectations

The settings page (`client/client.js`) is hand-written CJS, `require('react')`
only, registers `settings.plugins.tab` and `plugins.item` slots with id
`config-sync`, and calls these routes with `fetch(path, { credentials: 'same-origin' })`.
