# `client/` — settings-page UI

Hand-written browser half of `dsh-config-sync`. No build step, no JSX, no
dependencies beyond the `react` the shell seeds into the module table.

## Format

`client/client.js` is a lazy-CJS module in the shell's module format:

```js
window.__ModuleLoader__.load({ id: 'dsh-config-sync', factory: (require) => { … } })
```

The factory requires only `react`, builds its exports object from scratch
(`var module` / `var exports`, like the shell's own client bundles) and returns
`module.exports` with:

| export | meaning |
| --- | --- |
| `name` | `dsh-config-sync` |
| `inject` | `['slots', 'locale']` — the services the panel needs |
| `apply(ctx)` | registers the dictionaries and the two slot contributions |
| `dictionaries` | `{ zh, en }`, exposed for tooling only |

## Slots

| slot | id | order |
| --- | --- | --- |
| `settings.plugins.tab` | `config-sync` | 45 |
| `plugins.item` | `config-sync` | 30 |

Both render the same `SyncPanel`; `plugins.item` answers `view: 'summary'` with
the one-line `summary` string and `view: 'page'` with the panel (title hidden).
The panel's only prop dependency is `t`, which `apply` injects through the
slot's `inject` face, so the panel renders correctly in both homes.

## Routes

All data comes from the host half over relative paths below `/dsh-config-sync`,
with `credentials: 'same-origin'` and a JSON body for every POST:

`GET /status`, `GET|POST /config`, `POST /probe`, `POST /check`, `POST /sync`,
`POST /conflict`, `GET /backups`, `POST /backups/restore`, `GET /logs?tail=100`.

Failures are classified before they reach the UI: a rejected `fetch`, an HTTP
404 (host half not installed), another non-2xx status, and a `{ ok: false }`
body each get their own bilingual message. A refused `POST /sync` answers 409
with the report it built, and that report is still rendered.

## Styling

One inline `<style>` (`data-plugin-css="dsh-config-sync/panel.css"`), class
prefix `dcs-`. Colours come from the `--dsw-alias-*` theme variables with
neutral fallbacks, so the panel follows the light/dark theme without hard-coded
backgrounds. Secrets are never read back: fields show `已保存，留空保持不变`
placeholders and an untouched secret is omitted from the POST body, which keeps
the stored value.
