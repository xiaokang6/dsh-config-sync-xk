/**
 * dsh-config-sync — browser half.
 *
 * A hand-written client bundle in the shell's lazy-CJS format: the module
 * system registers this factory through `window.__ModuleLoader__.load`, and the
 * Cordis loader treats the returned exports as an ordinary browser plugin. It
 * requires only `react` from the platform seed table.
 *
 * The panel is contributed to the Plugins settings page twice: as one tab of
 * Settings > Built-in plugins (`settings.plugins.tab`) and as a card on the
 * Plugins page itself (`plugins.item`). All data arrives from this package's
 * host half over the `/dsh-config-sync/*` routes documented in
 * `docs/http-api.md`: status, remote settings, dry-run plans, sync, conflict
 * resolution, backups and the log tail. The host never echoes secrets back —
 * answers carry `hasPassword` / `hasToken` flags instead, and an empty secret
 * field keeps the stored value.
 *
 * @module dsh-config-sync/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-config-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this panel. */
    const NS = 'config-sync'
    /** Route prefix mounted by the host half (`docs/http-api.md`). */
    const API = '/dsh-config-sync'

    /** Defaults the form offers when the host has no stored value yet. */
    const DEFAULT_BASE_URL = 'https://dav.jianguoyun.com/dav/'
    const DEFAULT_PATH = 'dsh-config-sync/desktop'
    const DEFAULT_BRANCH = 'main'

    /** Remote kinds the host can talk to, in display order. */
    const KINDS = [
      { id: 'webdav', labelKey: 'kindWebdav' },
      { id: 'github', labelKey: 'kindGithub' },
    ]

    /** Directions the host understands for `direction` fields. */
    const DIRECTIONS = [
      { id: 'push', labelKey: 'directionPush' },
      { id: 'pull', labelKey: 'directionPull' },
      { id: 'both', labelKey: 'directionBoth' },
    ]
    const DIRECTION_IDS = DIRECTIONS.map((entry) => entry.id)

    /** Plan actions the host may report, in summary order. */
    const PLAN_ACTIONS = ['push', 'pull', 'conflict', 'same', 'only-local', 'only-remote', 'skipped']

    const zh = {
      title: '配置同步',
      summary: '在设备之间同步 DSH 配置（坚果云 WebDAV / GitHub）。',
      intro: '把这个 profile 的 package.json、cordis.patch.yml 等文件同步到坚果云 WebDAV 或 GitHub 仓库。写入前会自动备份；冲突的文件会保留远端副本，等你决定用哪一边。',
      statusTitle: '状态',
      device: '设备',
      deviceId: '设备 ID',
      profile: 'Profile',
      profileDir: 'Profile 目录',
      remoteLabel: '远端',
      remoteRoot: '根路径',
      probe: '连通性',
      probeNever: '尚未探测',
      probeOk: '正常',
      probeFail: '失败',
      latency: '延迟',
      probeButton: '测试连接',
      refreshStatus: '刷新状态',
      lastSync: '上次同步',
      lastSyncNever: '从未同步',
      syncOk: '成功',
      syncFail: '失败',
      pendingRestart: '需要重启生效',
      serverBusy: '同步进行中',
      running: '运行中',
      runningOperation: '正在执行…',
      loading: '正在读取状态…',
      loadingLogs: '正在读取日志…',
      unavailableHint: '宿主半尚未就绪：请确认插件已安装，重启 DSH 后重试。',
      notConfigured: '未配置',
      unknown: '未知',
      configTitle: '远端设置',
      remoteKind: '类型',
      kindWebdav: '坚果云 WebDAV',
      kindGithub: 'GitHub',
      baseUrl: 'Base URL',
      username: '用户名',
      password: '应用密码',
      remotePath: '远端路径',
      owner: '仓库所有者（owner）',
      repo: '仓库名（repo）',
      branch: '分支',
      token: '访问令牌（Token）',
      keepSaved: '已保存，留空保持不变',
      newSecret: '尚未保存；填写后保存',
      secretHint: '密钥只保存在本机，不写入被同步的配置文件。留空保持原值。',
      cryptoEnable: '加密远端文件（AES-256-GCM）',
      passphrase: '加密口令',
      cryptoHint: '口令只保存在本机；换设备同步时需要输入同一口令。留空保持原值。',
      cryptoOffHint: '启用后远端文件以 AES-256-GCM 信封保存。',
      directionLabel: '同步方向',
      directionPush: '仅上传',
      directionPull: '仅下载',
      directionBoth: '双向',
      scopeLabel: '同步范围（只读）',
      scopeHint: '范围来自插件的 profile 配置，这里只做展示。',
      scopeEmpty: '没有同步文件',
      save: '保存设置',
      discard: '撤销修改',
      saved: '已保存，下一次同步使用新设置。',
      actionsTitle: '操作',
      actionsHint: '检测差异只读取两端，不写入任何文件；上传 / 下载 / 双向同步都会先备份再写入。',
      actionCheck: '检测差异',
      actionPush: '上传到远端',
      actionPull: '从远端下载',
      actionBoth: '双向同步',
      planTitle: '差异计划',
      planEmpty: '两端一致，没有需要传输的文件。',
      colFile: '文件',
      colAction: '动作',
      colLocal: '本地 sha',
      colRemote: '远端 sha',
      actPush: '上传',
      actPull: '下载',
      actConflict: '冲突',
      actSame: '一致',
      actOnlyLocal: '仅本地',
      actOnlyRemote: '仅远端',
      actSkipped: '跳过',
      reportTitle: '同步结果',
      reportPushed: '已上传',
      reportPulled: '已下载',
      reportConflicts: '冲突',
      reportSkipped: '跳过',
      reportErrors: '错误',
      reportNone: '无',
      reportBackup: '备份',
      reportRestart: '需要重启 DSH',
      reportPnpm: 'pnpm install',
      reportManifest: '清单时间',
      pnpmRan: '已执行',
      pnpmSkipped: '未执行',
      pnpmOk: '成功',
      pnpmFail: '失败',
      conflictsTitle: '冲突',
      conflictsHint: '「采用远端」用保存的远端副本覆盖本地文件；「采用本地」保留本地文件，下一次同步上传它。',
      conflictCopy: '远端副本',
      useRemote: '采用远端',
      useLocal: '采用本地',
      conflictDone: '冲突已处理。',
      backupsTitle: '备份',
      backupsEmpty: '暂无备份。',
      backupFiles: '个文件',
      restore: '恢复',
      restoreConfirm: '恢复该备份会覆盖当前配置文件（恢复前会先备份当前状态）。确定继续？',
      restored: '已恢复文件数',
      restartRequired: '需要重启',
      logsTitle: '日志',
      logsShow: '展开',
      logsHide: '收起',
      logsRefresh: '刷新',
      logsEmpty: '暂无日志。',
      syncDone: '同步完成。',
    }

    const en = {
      title: 'Config sync',
      summary: 'Keep a DSH profile in sync across devices (Nutstore WebDAV / GitHub).',
      intro: "Sync this profile's package.json, cordis.patch.yml and friends to Nutstore WebDAV or a GitHub repository. Every write is backed up first; conflicting files keep a remote copy until you pick a side.",
      statusTitle: 'Status',
      device: 'Device',
      deviceId: 'Device ID',
      profile: 'Profile',
      profileDir: 'Profile directory',
      remoteLabel: 'Remote',
      remoteRoot: 'Root',
      probe: 'Connectivity',
      probeNever: 'Not probed yet',
      probeOk: 'OK',
      probeFail: 'Failed',
      latency: 'latency',
      probeButton: 'Test connection',
      refreshStatus: 'Refresh status',
      lastSync: 'Last sync',
      lastSyncNever: 'Never synced',
      syncOk: 'ok',
      syncFail: 'failed',
      pendingRestart: 'Restart required',
      serverBusy: 'Sync in progress',
      running: 'Working',
      runningOperation: 'Working…',
      loading: 'Reading status…',
      loadingLogs: 'Reading logs…',
      unavailableHint: 'The plugin host half is not ready: check the install and restart DSH.',
      notConfigured: 'Not configured',
      unknown: 'unknown',
      configTitle: 'Remote settings',
      remoteKind: 'Type',
      kindWebdav: 'Nutstore WebDAV',
      kindGithub: 'GitHub',
      baseUrl: 'Base URL',
      username: 'Username',
      password: 'App password',
      remotePath: 'Remote path',
      owner: 'Repository owner',
      repo: 'Repository name',
      branch: 'Branch',
      token: 'Access token',
      keepSaved: 'Saved; leave blank to keep it',
      newSecret: 'Not saved yet; fill in and save',
      secretHint: 'Stored on this machine only, never in the synced profile files. Leave blank to keep the stored value.',
      cryptoEnable: 'Encrypt remote files (AES-256-GCM)',
      passphrase: 'Passphrase',
      cryptoHint: 'Kept on this machine only; another device needs the same passphrase. Leave blank to keep it.',
      cryptoOffHint: 'When enabled, remote files are wrapped in an AES-256-GCM envelope.',
      directionLabel: 'Direction',
      directionPush: 'Push only',
      directionPull: 'Pull only',
      directionBoth: 'Both',
      scopeLabel: 'Scope (read-only)',
      scopeHint: 'The scope comes from the plugin profile configuration and is shown here for reference.',
      scopeEmpty: 'No files',
      save: 'Save settings',
      discard: 'Discard',
      saved: 'Saved; the next sync uses the new settings.',
      actionsTitle: 'Actions',
      actionsHint: 'Checking reads both sides and writes nothing. Push, pull and both back up before writing.',
      actionCheck: 'Check changes',
      actionPush: 'Upload to remote',
      actionPull: 'Download from remote',
      actionBoth: 'Sync both ways',
      planTitle: 'Change plan',
      planEmpty: 'Both sides match; nothing to transfer.',
      colFile: 'File',
      colAction: 'Action',
      colLocal: 'Local sha',
      colRemote: 'Remote sha',
      actPush: 'push',
      actPull: 'pull',
      actConflict: 'conflict',
      actSame: 'same',
      actOnlyLocal: 'local only',
      actOnlyRemote: 'remote only',
      actSkipped: 'skipped',
      reportTitle: 'Sync result',
      reportPushed: 'Pushed',
      reportPulled: 'Pulled',
      reportConflicts: 'Conflicts',
      reportSkipped: 'Skipped',
      reportErrors: 'Errors',
      reportNone: 'none',
      reportBackup: 'Backup',
      reportRestart: 'DSH restart required',
      reportPnpm: 'pnpm install',
      reportManifest: 'Manifest time',
      pnpmRan: 'ran',
      pnpmSkipped: 'not run',
      pnpmOk: 'succeeded',
      pnpmFail: 'failed',
      conflictsTitle: 'Conflicts',
      conflictsHint: 'Use remote overwrites the local file with the saved remote copy; use local keeps the local file and the next sync uploads it.',
      conflictCopy: 'Remote copy',
      useRemote: 'Use remote',
      useLocal: 'Use local',
      conflictDone: 'Conflict resolved.',
      backupsTitle: 'Backups',
      backupsEmpty: 'No backups yet.',
      backupFiles: 'file(s)',
      restore: 'Restore',
      restoreConfirm: 'Restoring overwrites the current configuration files (the current state is backed up first). Continue?',
      restored: 'Restored files',
      restartRequired: 'Restart required',
      logsTitle: 'Logs',
      logsShow: 'Show',
      logsHide: 'Hide',
      logsRefresh: 'Refresh',
      logsEmpty: 'No log entries.',
      syncDone: 'Sync finished.',
    }

    /**
     * Failure copy stays bilingual in both dictionaries: it is the one place a
     * user may need to quote an English message back to a support thread.
     */
    const FAILURES = {
      errNetwork: '无法连接 DSH 宿主服务 · Cannot reach the DSH host service',
      errNotFound: '插件宿主半未加载（HTTP 404） · The plugin host half is not loaded',
      errHttp: '宿主服务返回错误 · The host service answered with an error',
      errRefused: '请求被拒绝 · Request refused',
      errMalformed: '宿主返回了无法解析的数据 · The host answer could not be parsed',
      errUnknown: '未知错误 · Unknown error',
      loadFailed: '读取状态失败 · Failed to read status and configuration',
      errSave: '保存失败 · Save failed',
      errCheck: '检测差异失败 · Check failed',
      errSync: '同步失败 · Sync failed',
      errConflict: '处理冲突失败 · Conflict action failed',
      errRestore: '恢复备份失败 · Backup restore failed',
      errLogs: '读取日志失败 · Failed to read logs',
      errProbe: '测试连接失败 · Connection test failed',
      invalidUrl: '地址必须以 http:// 或 https:// 开头 · The address must start with http:// or https://',
      invalidPath: '远端路径必须以相对路径书写（不能以 / 开头，不能包含 . 或 .. 段） · The remote path must stay relative (no leading slash, no . or .. segments)',
      missingUsername: '请填写用户名 · Username is required',
      missingOwner: '请填写仓库 owner · Repository owner is required',
      missingRepo: '请填写仓库名 · Repository name is required',
      missingPassphrase: '启用加密时必须填写口令 · A passphrase is required when encryption is on',
    }
    Object.assign(zh, FAILURES)
    Object.assign(en, FAILURES)

    /** Style sheet, injected once per page. */
    const CSS = [
      '.dcs-panel{max-width:820px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}',
      '.dcs-title{margin:0;font-size:18px;font-weight:600}',
      '.dcs-intro{margin:0;color:var(--dsw-alias-label-tertiary,inherit);line-height:1.6}',
      '.dcs-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dcs-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.dcs-card-title{margin:0;font-size:14px;font-weight:600}',
      '.dcs-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dcs-inline{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.dcs-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));font-size:12px;line-height:18px}',
      '.dcs-chip-ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dcs-chip-warn{color:var(--dsw-alias-state-warning-primary,#e8590c)}',
      '.dcs-chip-err{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dcs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 14px;margin:0}',
      '.dcs-grid>div{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dcs-grid dt{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px}',
      '.dcs-grid dd{margin:0;overflow-wrap:anywhere}',
      '.dcs-mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12px;overflow-wrap:anywhere}',
      '.dcs-hint{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:1.55}',
      '.dcs-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dcs-label{font-weight:500}',
      '.dcs-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}',
      '.dcs-input{background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;min-width:0}',
      '.dcs-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c6ef5);outline-offset:1px}',
      '.dcs-select{width:100%;max-width:320px}',
      '.dcs-check{display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.dcs-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dcs-btn{border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}',
      '.dcs-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c6ef5)}',
      '.dcs-btn:disabled{opacity:.5;cursor:default}',
      '.dcs-btn-primary{background:var(--dsw-alias-brand-primary,#4c6ef5);border-color:var(--dsw-alias-brand-primary,#4c6ef5);color:var(--dsw-alias-bg-base,#fff)}',
      '.dcs-btn-small{padding:3px 9px;font-size:12px}',
      '.dcs-msg{margin:0;font-size:12px;line-height:1.6}',
      '.dcs-msg-ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dcs-msg-err{color:var(--dsw-alias-state-error-primary,#e03131)}',
      '.dcs-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dcs-table th,.dcs-table td{text-align:left;padding:4px 6px;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));vertical-align:top}',
      '.dcs-table th{color:var(--dsw-alias-label-tertiary,inherit);font-weight:500}',
      '.dcs-tag{font-size:12px}',
      '.dcs-tag-warn{color:var(--dsw-alias-state-warning-primary,#e8590c)}',
      '.dcs-tag-err{color:var(--dsw-alias-state-error-primary,#e03131);font-weight:600}',
      '.dcs-logs{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12px;line-height:1.5;padding:8px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-base,transparent)}',
      '.dcs-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dcs-list-item{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px}',
      '.dcs-sub{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dcs-scope{display:flex;flex-wrap:wrap;gap:6px}',
    ].join('')

    const CSS_TAG = 'dsh-config-sync/panel.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-config-sync'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * A rejected route call, classified so the panel can explain it in words
     * a user can act on (host half missing, host refused, network down).
     */
    class RouteFailure extends Error {
      /**
       * @param {string} code - one of `network`, `notFound`, `http`, `refused`, `malformed`.
       * @param {string} [detail] - server-provided text for `refused`.
       * @param {number} [status] - HTTP status for `http`.
       * @param {any} [payload] - parsed error body, kept for callers that render it.
       */
      constructor(code, detail, status, payload) {
        super(detail === undefined || detail === '' ? code : detail)
        this.name = 'RouteFailure'
        this.code = code
        this.detail = detail ?? ''
        this.status = status ?? 0
        this.payload = payload ?? null
      }
    }

    /**
     * Turn a non-2xx answer into a {@link RouteFailure}. The host still sends
     * `{ ok: false, error }` — and, for a refused sync, the report it built —
     * so the body is the only place the useful explanation lives.
     * @param {Response} response - the failed answer.
     * @returns {Promise<RouteFailure>}
     */
    async function readFailure(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      const detail = payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : ''
      return new RouteFailure(detail === '' ? 'http' : 'refused', detail, response.status, payload)
    }

    /**
     * One request against the plugin's host half.
     * @param {string} path - route below {@link API}, query string included.
     * @param {{method?: string, body?: unknown, text?: boolean}} [options]
     * @returns {Promise<any>} the parsed answer, or the raw body when `text`.
     */
    async function request(path, options = {}) {
      const headers = {}
      const init = { method: options.method ?? 'GET', credentials: 'same-origin', headers }
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch {
        throw new RouteFailure('network')
      }
      if (response.status === 404) throw new RouteFailure('notFound', undefined, 404)
      if (!response.ok) throw await readFailure(response)
      if (options.text === true) {
        try {
          return await response.text()
        } catch {
          throw new RouteFailure('malformed')
        }
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new RouteFailure('malformed')
      }
      if (payload === null || typeof payload !== 'object') throw new RouteFailure('malformed')
      if (payload.ok === false) throw new RouteFailure('refused', typeof payload.error === 'string' ? payload.error : '')
      return payload
    }

    /**
     * Readable text for a rejected call.
     * @param {any} error - whatever the call threw.
     * @param {(key: string) => string} t - the panel's translate function.
     * @returns {string} a message safe to show in the result strip.
     */
    function describeError(error, t) {
      if (error instanceof RouteFailure) {
        switch (error.code) {
          case 'network': return t('errNetwork')
          case 'notFound': return t('errNotFound')
          case 'http': return `${t('errHttp')} · HTTP ${error.status}`
          case 'refused': return error.detail === '' ? t('errRefused') : `${t('errRefused')}: ${error.detail}`
          default: return t('errMalformed')
        }
      }
      return `${t('errUnknown')}: ${error instanceof Error ? error.message : String(error)}`
    }

    /** Show a string field, or a placeholder when it is absent. */
    function textOf(value, fallback) {
      return typeof value === 'string' && value !== '' ? value : fallback
    }

    /** Render one epoch-millisecond stamp in the browser's locale. */
    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    /** Abbreviate a content hash for the plan table. */
    function abbreviateSha(value) {
      if (typeof value !== 'string' || value === '') return '—'
      return value.length > 12 ? `${value.slice(0, 12)}…` : value
    }

    /**
     * Normalise the two configuration answer shapes: `GET /config` returns the
     * fields at the top level, `POST /config` nests them under `config`.
     * @param {any} payload - route answer.
     * @returns {{remote: any, crypto: any, scope: string[], direction: string}}
     */
    function readConfig(payload) {
      const source = payload !== null && typeof payload === 'object' && payload.config !== null && typeof payload.config === 'object'
        ? payload.config
        : payload ?? {}
      const remote = source.remote !== null && typeof source.remote === 'object' ? source.remote : {}
      const crypto = source.crypto !== null && typeof source.crypto === 'object' ? source.crypto : {}
      return {
        remote: {
          kind: remote.kind === 'github' ? 'github' : 'webdav',
          baseUrl: typeof remote.baseUrl === 'string' ? remote.baseUrl : '',
          username: typeof remote.username === 'string' ? remote.username : '',
          owner: typeof remote.owner === 'string' ? remote.owner : '',
          repo: typeof remote.repo === 'string' ? remote.repo : '',
          branch: typeof remote.branch === 'string' ? remote.branch : '',
          path: typeof remote.path === 'string' ? remote.path : '',
          hasPassword: remote.hasPassword === true,
          hasToken: remote.hasToken === true,
        },
        crypto: { enabled: crypto.enabled === true, hasPassphrase: crypto.hasPassphrase === true },
        scope: Array.isArray(source.scope) ? source.scope.filter((entry) => typeof entry === 'string') : [],
        direction: DIRECTION_IDS.includes(source.direction) ? source.direction : 'both',
      }
    }

    /**
     * Normalise a dry-run plan.
     * @param {any} payload - `POST /check` answer.
     * @returns {{direction: string, files: any[], summary: Record<string, number>}}
     */
    function readPlan(payload) {
      const plan = payload !== null && typeof payload === 'object' ? payload.plan : null
      const source = plan !== null && typeof plan === 'object' ? plan : {}
      return {
        direction: typeof source.direction === 'string' ? source.direction : '',
        files: Array.isArray(source.files) ? source.files : [],
        summary: source.summary !== null && typeof source.summary === 'object' ? source.summary : {},
      }
    }

    /**
     * Normalise a sync report.
     * @param {any} payload - `POST /sync` answer.
     * @returns {any} the fields the report view renders.
     */
    function readReport(payload) {
      const report = payload !== null && typeof payload === 'object' ? payload.report : null
      const source = report !== null && typeof report === 'object' ? report : {}
      const list = (value) => (Array.isArray(value) ? value : [])
      return {
        direction: typeof source.direction === 'string' ? source.direction : '',
        pushed: list(source.pushed),
        pulled: list(source.pulled),
        conflicts: list(source.conflicts),
        skipped: list(source.skipped),
        errors: list(source.errors),
        backupId: typeof source.backupId === 'string' ? source.backupId : '',
        restartRequired: source.restartRequired === true,
        pnpm: source.pnpm !== null && typeof source.pnpm === 'object' ? source.pnpm : null,
        manifestSyncAt: typeof source.manifestSyncAt === 'number' ? source.manifestSyncAt : null,
      }
    }

    /**
     * Normalise `GET /backups`.
     * @param {any} payload - route answer.
     * @returns {Array<{id: string, at: number|null, op: string, files: string[], remoteKind: string}>}
     */
    function readBackups(payload) {
      const list = payload !== null && typeof payload === 'object' && Array.isArray(payload.backups) ? payload.backups : []
      return list
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
        .map((entry) => ({
          id: entry.id,
          at: typeof entry.at === 'number' ? entry.at : null,
          op: typeof entry.op === 'string' ? entry.op : '',
          files: Array.isArray(entry.files) ? entry.files.filter((file) => typeof file === 'string') : [],
          remoteKind: typeof entry.remoteKind === 'string' ? entry.remoteKind : '',
        }))
    }

    /** Render one report/list entry that may be a string or a small object. */
    function describeEntry(entry) {
      if (typeof entry === 'string') return entry
      if (entry !== null && typeof entry === 'object') {
        const file = typeof entry.file === 'string' ? entry.file : ''
        const reason = typeof entry.message === 'string'
          ? entry.message
          : typeof entry.error === 'string' ? entry.error : ''
        if (file !== '' || reason !== '') return [file, reason].filter((part) => part !== '').join(' — ')
        try {
          return JSON.stringify(entry)
        } catch {
          return String(entry)
        }
      }
      return String(entry)
    }

    /**
     * Parse the NDJSON log export into rows the panel can render.
     * @param {string} text - raw `GET /logs` answer.
     * @returns {Array<{at: number|null, level: string, event: string, detail: string, raw: string}>}
     */
    function parseLogs(text) {
      const rows = []
      for (const line of String(text).split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let entry
        try {
          entry = JSON.parse(trimmed)
        } catch {
          rows.push({ at: null, level: '', event: '', detail: '', raw: trimmed })
          continue
        }
        if (entry === null || typeof entry !== 'object') {
          rows.push({ at: null, level: '', event: '', detail: '', raw: trimmed })
          continue
        }
        rows.push({
          at: typeof entry.at === 'number' ? entry.at : null,
          level: typeof entry.level === 'string' ? entry.level : '',
          event: typeof entry.event === 'string' ? entry.event : '',
          detail: typeof entry.detail === 'string' ? entry.detail : '',
          raw: trimmed,
        })
      }
      return rows
    }

    /** One rendered log line: time, level, event, detail. */
    function formatLogLine(entry) {
      const parts = []
      if (entry.at !== null) parts.push(formatTime(entry.at))
      if (entry.level !== '') parts.push(entry.level)
      if (entry.event !== '') parts.push(entry.event)
      if (entry.detail !== '') parts.push(entry.detail)
      return parts.length === 0 ? entry.raw : parts.join('  ')
    }

    /** Label for one plan action. */
    function planActionLabel(action, t) {
      switch (action) {
        case 'push': return t('actPush')
        case 'pull': return t('actPull')
        case 'conflict': return t('actConflict')
        case 'same': return t('actSame')
        case 'only-local': return t('actOnlyLocal')
        case 'only-remote': return t('actOnlyRemote')
        case 'skipped': return t('actSkipped')
        default: return typeof action === 'string' ? action : t('unknown')
      }
    }

    /** Colour class for one plan action. */
    function planActionClass(action) {
      if (action === 'conflict') return 'dcs-tag dcs-tag-err'
      if (action === 'push' || action === 'pull') return 'dcs-tag dcs-tag-warn'
      return 'dcs-tag'
    }

    /**
     * Check a draft before it is written.
     * @param {(key: string) => string} t - the panel's translate function.
     * @param {{remote: any, crypto: {enabled: boolean, hasPassphrase: boolean, newPassphrase: string}}} values
     * @returns {string|null} a bilingual message, or null when the draft is usable.
     */
    function validateSettings(t, values) {
      const remote = values.remote
      const path = typeof remote.path === 'string' ? remote.path : ''
      // An empty path means "use the host default"; anything else must stay a
      // relative POSIX path the host can normalise without escaping the root.
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => segment === '.' || segment === '..')) {
        return t('invalidPath')
      }
      if (remote.kind === 'webdav') {
        if (!/^https?:\/\//u.test(remote.baseUrl)) return t('invalidUrl')
        if (remote.username === '') return t('missingUsername')
      } else {
        if (remote.owner === '') return t('missingOwner')
        if (remote.repo === '') return t('missingRepo')
      }
      const crypto = values.crypto
      if (crypto.enabled && crypto.hasPassphrase === false && crypto.newPassphrase === '') return t('missingPassphrase')
      return null
    }

    /** Top card: device, profile, remote, connectivity and last sync. */
    function StatusCard({ status, loading, busy, t, onProbe, onRefresh }) {
      const chips = []
      if (busy !== '') chips.push(h('span', { className: 'dcs-chip dcs-chip-warn', key: 'busy' }, t('running')))
      if (status !== null && status.pendingRestart === true) chips.push(h('span', { className: 'dcs-chip dcs-chip-warn', key: 'restart' }, t('pendingRestart')))
      if (status !== null && status.busy === true) chips.push(h('span', { className: 'dcs-chip', key: 'server' }, t('serverBusy')))

      const head = h('div', { className: 'dcs-card-head' },
        h('h3', { className: 'dcs-card-title' }, t('statusTitle')),
        h('div', { className: 'dcs-chips' },
          chips,
          status === null ? null : h('button', {
            className: 'dcs-btn dcs-btn-small',
            type: 'button',
            disabled: busy !== '',
            onClick: onProbe,
          }, t('probeButton')),
          h('button', {
            className: 'dcs-btn dcs-btn-small',
            type: 'button',
            disabled: busy !== '',
            onClick: onRefresh,
          }, t('refreshStatus')),
        ),
      )

      if (status === null) {
        return h('section', { className: 'dcs-card' },
          head,
          h('p', { className: 'dcs-hint' }, loading ? t('loading') : t('unavailableHint')),
        )
      }

      const device = status.device !== null && typeof status.device === 'object' ? status.device : {}
      const profile = status.profile !== null && typeof status.profile === 'object' ? status.profile : {}
      const remote = status.remote !== null && typeof status.remote === 'object' ? status.remote : {}
      const probe = remote.probe !== null && typeof remote.probe === 'object' ? remote.probe : null
      const lastSync = status.lastSync !== null && typeof status.lastSync === 'object' ? status.lastSync : null

      const probeNode = probe === null
        ? h('span', { className: 'dcs-chip' }, t('probeNever'))
        : probe.ok === true
          ? h('span', { className: 'dcs-chip dcs-chip-ok' }, `${t('probeOk')} · ${t('latency')} ${Number(probe.latencyMs) || 0} ms`)
          : h('span', { className: 'dcs-chip dcs-chip-err' }, `${t('probeFail')}${textOf(probe.detail, '') !== '' ? `: ${probe.detail}` : ''}`)

      const lastSyncNode = lastSync === null
        ? h('span', { className: 'dcs-chip' }, t('lastSyncNever'))
        : h('span', { className: 'dcs-inline' },
            h('span', { className: 'dcs-mono' }, formatTime(lastSync.at)),
            h('span', { className: lastSync.ok === true ? 'dcs-chip dcs-chip-ok' : 'dcs-chip dcs-chip-err' }, lastSync.ok === true ? t('syncOk') : t('syncFail')),
          )

      const cell = (key, label, node) => h('div', { key }, h('dt', null, label), h('dd', null, node))

      return h('section', { className: 'dcs-card' },
        head,
        h('dl', { className: 'dcs-grid' },
          cell('device', t('device'), textOf(device.name, t('unknown'))),
          cell('deviceId', t('deviceId'), h('span', { className: 'dcs-mono' }, textOf(device.id, '—'))),
          cell('profile', t('profile'), textOf(profile.name, t('unknown'))),
          cell('profileDir', t('profileDir'), h('span', { className: 'dcs-mono' }, textOf(profile.dir, '—'))),
          cell('remote', t('remoteLabel'), h('span', { className: 'dcs-inline' },
            textOf(remote.label, textOf(remote.kind, t('unknown'))),
            remote.configured === false ? h('span', { className: 'dcs-chip dcs-chip-warn' }, t('notConfigured')) : null,
          )),
          cell('root', t('remoteRoot'), h('span', { className: 'dcs-mono' }, textOf(remote.root, '—'))),
          cell('probe', t('probe'), probeNode),
          cell('lastSync', t('lastSync'), lastSyncNode),
        ),
      )
    }

    /** Remote settings form: type-specific fields, encryption, direction, scope. */
    function RemoteSettings({ config, t, busy, saving, onSave, onError }) {
      const [draft, setDraft] = React.useState({})
      const remote = config.remote
      const stored = {
        kind: remote.kind,
        baseUrl: remote.baseUrl === '' ? DEFAULT_BASE_URL : remote.baseUrl,
        username: remote.username,
        owner: remote.owner,
        repo: remote.repo,
        branch: remote.branch === '' ? DEFAULT_BRANCH : remote.branch,
        path: remote.path === '' ? DEFAULT_PATH : remote.path,
        cryptoEnabled: config.crypto.enabled,
        direction: config.direction,
      }
      const value = (field) => (draft[field] === undefined ? stored[field] : draft[field])
      const set = (field, next) => setDraft((previous) => ({ ...previous, [field]: next }))
      const kind = value('kind')
      const disabled = busy === true
      const secrets = ['password', 'token', 'passphrase']
      const dirty = Object.keys(stored).some((field) => draft[field] !== undefined && draft[field] !== stored[field])
        || secrets.some((field) => (draft[field] ?? '') !== '')

      const textField = (field, label, extra) => h('label', { className: 'dcs-field', key: field },
        h('span', { className: 'dcs-label' }, label),
        h('input', {
          className: 'dcs-input',
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          disabled,
          value: value(field),
          onChange: (event) => set(field, event.target.value),
          ...extra,
        }),
      )

      const secretField = (field, label, saved, hint) => h('label', { className: 'dcs-field', key: field },
        h('span', { className: 'dcs-label' }, label),
        h('input', {
          className: 'dcs-input',
          type: 'password',
          autoComplete: 'new-password',
          spellCheck: false,
          disabled,
          placeholder: saved ? t('keepSaved') : t('newSecret'),
          value: draft[field] ?? '',
          onChange: (event) => set(field, event.target.value),
        }),
        h('span', { className: 'dcs-hint' }, hint),
      )

      const kindField = h('label', { className: 'dcs-field', key: 'kind' },
        h('span', { className: 'dcs-label' }, t('remoteKind')),
        h('select', {
          className: 'dcs-input dcs-select',
          value: kind,
          disabled,
          onChange: (event) => set('kind', event.target.value),
        }, KINDS.map((entry) => h('option', { key: entry.id, value: entry.id }, t(entry.labelKey)))),
      )

      const kindHead = h('div', { className: 'dcs-row' },
        kindField,
        kind === 'webdav'
          ? textField('baseUrl', t('baseUrl'), { placeholder: DEFAULT_BASE_URL })
          : textField('owner', t('owner')),
      )

      const kindBody = kind === 'webdav'
        ? [
            h('div', { className: 'dcs-row', key: 'webdav-auth' },
              textField('username', t('username')),
              secretField('password', t('password'), remote.hasPassword, t('secretHint')),
            ),
            h('div', { className: 'dcs-row', key: 'webdav-path' },
              textField('path', t('remotePath'), { placeholder: DEFAULT_PATH }),
            ),
          ]
        : [
            h('div', { className: 'dcs-row', key: 'github-repo' },
              textField('repo', t('repo')),
              textField('branch', t('branch'), { placeholder: DEFAULT_BRANCH }),
            ),
            h('div', { className: 'dcs-row', key: 'github-path' },
              textField('path', t('remotePath'), { placeholder: DEFAULT_PATH }),
              secretField('token', t('token'), remote.hasToken, t('secretHint')),
            ),
          ]

      const cryptoField = h('div', { className: 'dcs-field', key: 'crypto' },
        h('label', { className: 'dcs-check' },
          h('input', {
            type: 'checkbox',
            checked: value('cryptoEnabled') === true,
            disabled,
            onChange: (event) => set('cryptoEnabled', event.target.checked),
          }),
          h('span', { className: 'dcs-label' }, t('cryptoEnable')),
        ),
        value('cryptoEnabled') === true
          ? secretField('passphrase', t('passphrase'), config.crypto.hasPassphrase, t('cryptoHint'))
          : h('span', { className: 'dcs-hint' }, t('cryptoOffHint')),
      )

      const directionField = h('label', { className: 'dcs-field', key: 'direction' },
        h('span', { className: 'dcs-label' }, t('directionLabel')),
        h('select', {
          className: 'dcs-input dcs-select',
          value: value('direction'),
          disabled,
          onChange: (event) => set('direction', event.target.value),
        }, DIRECTIONS.map((entry) => h('option', { key: entry.id, value: entry.id }, t(entry.labelKey)))),
      )

      const scopeField = h('div', { className: 'dcs-field', key: 'scope' },
        h('span', { className: 'dcs-label' }, t('scopeLabel')),
        h('span', { className: 'dcs-scope' }, config.scope.length === 0
          ? h('span', { className: 'dcs-chip' }, t('scopeEmpty'))
          : config.scope.map((file) => h('span', { className: 'dcs-chip dcs-mono', key: file }, file))),
        h('p', { className: 'dcs-hint' }, t('scopeHint')),
      )

      const submit = () => {
        const remotePayload = kind === 'webdav'
          ? {
              kind: 'webdav',
              baseUrl: String(value('baseUrl')).trim(),
              username: String(value('username')).trim(),
              path: String(value('path')).trim(),
            }
          : {
              kind: 'github',
              owner: String(value('owner')).trim(),
              repo: String(value('repo')).trim(),
              branch: String(value('branch')).trim(),
              path: String(value('path')).trim(),
            }
        if (kind === 'webdav' && (draft.password ?? '') !== '') remotePayload.password = draft.password
        if (kind === 'github' && (draft.token ?? '') !== '') remotePayload.token = draft.token
        const cryptoPayload = { enabled: value('cryptoEnabled') === true }
        if ((draft.passphrase ?? '') !== '') cryptoPayload.passphrase = draft.passphrase
        const problem = validateSettings(t, {
          remote: remotePayload,
          crypto: {
            enabled: cryptoPayload.enabled,
            hasPassphrase: config.crypto.hasPassphrase,
            newPassphrase: draft.passphrase ?? '',
          },
        })
        if (problem !== null) {
          onError(problem)
          return
        }
        void (async () => {
          const accepted = await onSave({
            remote: remotePayload,
            crypto: cryptoPayload,
            scope: config.scope.slice(),
            direction: value('direction'),
          })
          if (accepted === true) setDraft({})
        })()
      }

      return h('section', { className: 'dcs-card' },
        h('div', { className: 'dcs-card-head' }, h('h3', { className: 'dcs-card-title' }, t('configTitle'))),
        kindHead,
        kindBody,
        h('div', { className: 'dcs-row' }, cryptoField, directionField),
        scopeField,
        h('div', { className: 'dcs-actions' },
          h('button', {
            className: 'dcs-btn dcs-btn-primary',
            type: 'button',
            disabled: disabled || !dirty,
            onClick: submit,
          }, saving ? t('runningOperation') : t('save')),
          h('button', {
            className: 'dcs-btn',
            type: 'button',
            disabled: disabled || !dirty,
            onClick: () => setDraft({}),
          }, t('discard')),
        ),
      )
    }

    /** Dry-run plan: one row per file plus the summary chips. */
    function PlanTable({ plan, t }) {
      const files = plan.files
      const summary = plan.summary
      const chips = PLAN_ACTIONS
        .filter((action) => typeof summary[action] === 'number' && summary[action] > 0)
        .map((action) => h('span', { className: 'dcs-chip', key: action }, `${planActionLabel(action, t)} ${summary[action]}`))
      const rows = files.map((entry) => {
        const file = typeof entry.file === 'string' ? entry.file : ''
        return h('tr', { key: file },
          h('td', { className: 'dcs-mono' }, file),
          h('td', null, h('span', { className: planActionClass(entry.action) }, planActionLabel(entry.action, t))),
          h('td', { className: 'dcs-mono' }, abbreviateSha(entry.localSha)),
          h('td', { className: 'dcs-mono' }, abbreviateSha(entry.remoteSha)),
        )
      })
      return h('div', { className: 'dcs-sub' },
        h('div', { className: 'dcs-card-head' },
          h('h4', { className: 'dcs-card-title' }, t('planTitle')),
          h('div', { className: 'dcs-chips' }, chips),
        ),
        files.length === 0
          ? h('p', { className: 'dcs-hint' }, t('planEmpty'))
          : h('table', { className: 'dcs-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('colFile')),
                h('th', null, t('colAction')),
                h('th', null, t('colLocal')),
                h('th', null, t('colRemote')),
              )),
              h('tbody', null, rows),
            ),
      )
    }

    /** Last sync report: transferred files, backup, restart flag, pnpm tail. */
    function ReportView({ report, t }) {
      const list = (title, entries, error) => h('div', { className: 'dcs-field', key: title },
        h('span', { className: 'dcs-label' }, title),
        entries.length === 0
          ? h('span', { className: 'dcs-hint' }, t('reportNone'))
          : h('span', { className: 'dcs-scope' }, entries.map((entry, index) => h('span', {
              className: error ? 'dcs-chip dcs-chip-err dcs-mono' : 'dcs-chip dcs-mono',
              key: `${title}-${index}`,
            }, describeEntry(entry)))),
      )

      const chips = []
      if (report.backupId !== '') chips.push(h('span', { className: 'dcs-chip dcs-mono', key: 'backup' }, `${t('reportBackup')} ${report.backupId}`))
      if (report.restartRequired) chips.push(h('span', { className: 'dcs-chip dcs-chip-warn', key: 'restart' }, t('reportRestart')))
      if (report.manifestSyncAt !== null) chips.push(h('span', { className: 'dcs-chip', key: 'manifest' }, `${t('reportManifest')} ${formatTime(report.manifestSyncAt)}`))

      const pnpm = report.pnpm
      const pnpmNode = pnpm === null ? null : h('div', { className: 'dcs-field', key: 'pnpm' },
        h('span', { className: 'dcs-label' }, t('reportPnpm')),
        h('span', { className: 'dcs-inline' },
          h('span', { className: 'dcs-chip' }, pnpm.ran === true ? t('pnpmRan') : t('pnpmSkipped')),
          h('span', { className: pnpm.ok === false ? 'dcs-chip dcs-chip-err' : 'dcs-chip dcs-chip-ok' }, pnpm.ok === false ? t('pnpmFail') : t('pnpmOk')),
        ),
        typeof pnpm.outputTail === 'string' && pnpm.outputTail !== ''
          ? h('pre', { className: 'dcs-logs' }, pnpm.outputTail)
          : null,
      )

      return h('div', { className: 'dcs-sub' },
        h('div', { className: 'dcs-card-head' },
          h('h4', { className: 'dcs-card-title' }, t('reportTitle')),
          h('div', { className: 'dcs-chips' }, chips),
        ),
        list(t('reportPushed'), report.pushed, false),
        list(t('reportPulled'), report.pulled, false),
        list(t('reportConflicts'), report.conflicts, true),
        list(t('reportSkipped'), report.skipped, false),
        list(t('reportErrors'), report.errors, true),
        pnpmNode,
      )
    }

    /** Operation buttons plus the plan table and the last sync report. */
    function ActionsCard({ plan, report, busy, t, onCheck, onSync }) {
      const disabled = busy !== ''
      const buttons = [
        { key: 'check', label: t('actionCheck'), run: onCheck, primary: false },
        { key: 'push', label: t('actionPush'), run: () => onSync('push'), primary: true },
        { key: 'pull', label: t('actionPull'), run: () => onSync('pull'), primary: false },
        { key: 'both', label: t('actionBoth'), run: () => onSync('both'), primary: false },
      ]
      return h('section', { className: 'dcs-card' },
        h('div', { className: 'dcs-card-head' },
          h('h3', { className: 'dcs-card-title' }, t('actionsTitle')),
          busy === '' ? null : h('span', { className: 'dcs-chip dcs-chip-warn' }, t('running')),
        ),
        h('div', { className: 'dcs-actions' }, buttons.map((button) => h('button', {
          key: button.key,
          className: button.primary ? 'dcs-btn dcs-btn-primary' : 'dcs-btn',
          type: 'button',
          disabled,
          onClick: button.run,
        }, button.label))),
        h('p', { className: 'dcs-hint' }, t('actionsHint')),
        plan === null ? null : h(PlanTable, { plan, t }),
        report === null ? null : h(ReportView, { report, t }),
      )
    }

    /** Conflict rows: keep the remote copy or the local one, per file. */
    function ConflictsCard({ conflicts, busy, t, onResolve }) {
      const rows = conflicts.map((entry) => {
        const file = typeof entry.file === 'string' ? entry.file : ''
        return h('li', { className: 'dcs-list-item', key: file },
          h('span', { className: 'dcs-sub' },
            h('span', { className: 'dcs-mono' }, file),
            h('span', { className: 'dcs-hint' }, `${t('conflictCopy')}: ${textOf(entry.remoteFile, '—')} · ${formatTime(entry.at)}`),
          ),
          h('span', { className: 'dcs-inline' },
            h('button', {
              className: 'dcs-btn dcs-btn-small dcs-btn-primary',
              type: 'button',
              disabled: busy !== '',
              onClick: () => onResolve(file, 'use-remote'),
            }, t('useRemote')),
            h('button', {
              className: 'dcs-btn dcs-btn-small',
              type: 'button',
              disabled: busy !== '',
              onClick: () => onResolve(file, 'use-local'),
            }, t('useLocal')),
          ),
        )
      })
      return h('section', { className: 'dcs-card' },
        h('div', { className: 'dcs-card-head' },
          h('h3', { className: 'dcs-card-title' }, t('conflictsTitle')),
          h('span', { className: 'dcs-chip dcs-chip-warn' }, String(conflicts.length)),
        ),
        h('p', { className: 'dcs-hint' }, t('conflictsHint')),
        h('ul', { className: 'dcs-list' }, rows),
      )
    }

    /** Local backups with a per-row restore. */
    function BackupsCard({ backups, busy, t, onRestore }) {
      const rows = backups.map((entry) => h('li', { className: 'dcs-list-item', key: entry.id },
        h('span', { className: 'dcs-sub' },
          h('span', { className: 'dcs-mono' }, entry.id),
          h('span', { className: 'dcs-hint' }, `${formatTime(entry.at)}${entry.op === '' ? '' : ` · ${entry.op}`} · ${entry.files.length} ${t('backupFiles')}`),
        ),
        h('button', {
          className: 'dcs-btn dcs-btn-small',
          type: 'button',
          disabled: busy !== '',
          onClick: () => onRestore(entry.id),
        }, t('restore')),
      ))
      return h('section', { className: 'dcs-card' },
        h('div', { className: 'dcs-card-head' }, h('h3', { className: 'dcs-card-title' }, t('backupsTitle'))),
        backups.length === 0
          ? h('p', { className: 'dcs-hint' }, t('backupsEmpty'))
          : h('ul', { className: 'dcs-list' }, rows),
      )
    }

    /** Collapsible log tail from `GET /logs?tail=100`. */
    function LogsCard({ logs, open, busy, t, onToggle, onRefresh }) {
      let body = null
      if (open) {
        body = logs === null
          ? h('p', { className: 'dcs-hint' }, t('loadingLogs'))
          : logs.length === 0
            ? h('p', { className: 'dcs-hint' }, t('logsEmpty'))
            : h('pre', { className: 'dcs-logs' }, logs.map((entry) => formatLogLine(entry)).join('\n'))
      }
      return h('section', { className: 'dcs-card' },
        h('div', { className: 'dcs-card-head' },
          h('h3', { className: 'dcs-card-title' }, t('logsTitle')),
          h('div', { className: 'dcs-chips' },
            h('button', { className: 'dcs-btn dcs-btn-small', type: 'button', onClick: onToggle }, open ? t('logsHide') : t('logsShow')),
            h('button', { className: 'dcs-btn dcs-btn-small', type: 'button', disabled: busy !== '', onClick: onRefresh }, t('logsRefresh')),
          ),
        ),
        body,
      )
    }

    /** Panel root: data loading, the shared busy flag and the result strip. */
    function SyncPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [status, setStatus] = React.useState(null)
      const [config, setConfig] = React.useState(null)
      const [backups, setBackups] = React.useState([])
      const [plan, setPlan] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [logs, setLogs] = React.useState(null)
      const [logsOpen, setLogsOpen] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [msg, setMsg] = React.useState(null)

      /** Reload the status card quietly: a failure keeps the older snapshot. */
      const refreshStatus = React.useCallback(async () => {
        try {
          setStatus(await request('/status'))
        } catch {
          // The strip already names the action that failed; a slightly stale
          // status card reads better than a second error banner.
        }
      }, [])

      /** Load the status card and the settings form together; throws on failure. */
      const reloadAll = React.useCallback(async () => {
        const [statusAnswer, configAnswer] = await Promise.all([request('/status'), request('/config')])
        setStatus(statusAnswer)
        setConfig(readConfig(configAnswer))
      }, [])

      /** Reload the backup list quietly. */
      const refreshBackups = React.useCallback(async () => {
        try {
          setBackups(readBackups(await request('/backups')))
        } catch {
          // Same rationale: keep the previous list.
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            await reloadAll()
          } catch (error) {
            if (alive) setMsg({ ok: false, text: `${t('loadFailed')} — ${describeError(error, t)}` })
          } finally {
            if (alive) setLoading(false)
          }
        })()
        void refreshBackups()
        return () => {
          alive = false
        }
      }, [t, reloadAll, refreshBackups])

      /**
       * Run one route call behind the shared busy flag.
       * @param {string} operation - operation name while it runs.
       * @param {string} failureKey - dictionary key of the failure prefix.
       * @param {() => Promise<any>} work - the call itself.
       * @returns {Promise<any>} the work's result, or undefined after a failure.
       */
      const run = React.useCallback(async (operation, failureKey, work) => {
        setBusy(operation)
        setMsg(null)
        try {
          return await work()
        } catch (error) {
          setMsg({ ok: false, text: `${t(failureKey)} — ${describeError(error, t)}` })
          return undefined
        } finally {
          setBusy('')
        }
      }, [t])

      /**
       * The status card's refresh button. It reloads the form as well, so a
       * first mount against a half-loaded host can recover without a page
       * reload once the host half is installed.
       */
      const reload = React.useCallback(() => {
        void run('reload', 'loadFailed', async () => {
          await reloadAll()
          setLoading(false)
          await refreshBackups()
        })
      }, [run, reloadAll, refreshBackups])

      const check = React.useCallback(() => {
        void run('check', 'errCheck', async () => {
          const answer = await request('/check', { method: 'POST', body: {} })
          setPlan(readPlan(answer))
          setReport(null)
        })
      }, [run])

      const sync = React.useCallback((direction) => {
        void run('sync', 'errSync', async () => {
          try {
            const answer = await request('/sync', { method: 'POST', body: { direction, dryRun: false } })
            setReport(readReport(answer))
            setPlan(null)
            setMsg({ ok: true, text: t('syncDone') })
          } catch (error) {
            // A refused sync still answers with the report of what it did not
            // write, so the conflicts/errors it hit stay readable.
            if (error instanceof RouteFailure && error.payload !== null && error.payload.report !== undefined) {
              setReport(readReport(error.payload))
              setPlan(null)
            }
            throw error
          }
          await Promise.all([refreshStatus(), refreshBackups()])
        })
      }, [run, t, refreshStatus, refreshBackups])

      const probe = React.useCallback(() => {
        void run('probe', 'errProbe', async () => {
          const answer = await request('/probe', { method: 'POST', body: {} })
          const result = answer.probe !== null && typeof answer.probe === 'object' ? answer.probe : null
          setStatus((previous) => (previous === null
            ? previous
            : { ...previous, remote: { ...previous.remote, probe: result } }))
          if (result === null) {
            setMsg({ ok: false, text: t('probeNever') })
            return
          }
          if (result.ok === true) {
            setMsg({ ok: true, text: `${t('probeOk')} · ${t('latency')} ${Number(result.latencyMs) || 0} ms` })
            return
          }
          setMsg({ ok: false, text: `${t('probeFail')}${textOf(result.detail, '') === '' ? '' : `: ${result.detail}`}` })
        })
      }, [run, t])

      const resolveConflict = React.useCallback((file, action) => {
        void run('conflict', 'errConflict', async () => {
          await request('/conflict', { method: 'POST', body: { file, action } })
          setMsg({ ok: true, text: t('conflictDone') })
          await Promise.all([refreshStatus(), refreshBackups()])
        })
      }, [run, t, refreshStatus, refreshBackups])

      const restore = React.useCallback((id) => {
        const question = `${t('restoreConfirm')}\n\n${id}`
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(question)
          : false
        if (confirmed !== true) return
        void run('restore', 'errRestore', async () => {
          const answer = await request('/backups/restore', { method: 'POST', body: { id } })
          // The host wraps the restore outcome in `report`; older answers put
          // the same fields at the top level.
          const outcome = answer.report !== null && typeof answer.report === 'object' ? answer.report : answer
          const restored = Array.isArray(outcome.restored) ? outcome.restored.length : 0
          const suffix = outcome.restartRequired === true ? ` · ${t('restartRequired')}` : ''
          setMsg({ ok: true, text: `${t('restored')} ${restored}${suffix}` })
          await Promise.all([refreshStatus(), refreshBackups()])
        })
      }, [run, t, refreshStatus, refreshBackups])

      const loadLogs = React.useCallback(() => {
        void run('logs', 'errLogs', async () => {
          setLogs(parseLogs(await request('/logs?tail=100', { text: true })))
        })
      }, [run])

      const toggleLogs = () => {
        const next = !logsOpen
        setLogsOpen(next)
        if (next && logs === null) loadLogs()
      }

      const saveConfig = React.useCallback((payload) => run('save', 'errSave', async () => {
        const answer = await request('/config', { method: 'POST', body: payload })
        setConfig(readConfig(answer))
        setMsg({ ok: true, text: t('saved') })
        await refreshStatus()
        return true
      }), [run, t, refreshStatus])

      const conflicts = status !== null && Array.isArray(status.conflicts) ? status.conflicts : []
      const children = []

      if (props.view !== 'page') children.push(h('h2', { className: 'dcs-title', key: 'title' }, t('title')))
      children.push(h('p', { className: 'dcs-intro', key: 'intro' }, t('intro')))
      if (msg !== null) {
        children.push(h('p', {
          className: msg.ok ? 'dcs-msg dcs-msg-ok' : 'dcs-msg dcs-msg-err',
          key: 'msg',
          role: 'status',
        }, msg.text))
      }
      children.push(h(StatusCard, {
        key: 'status',
        status,
        loading,
        busy,
        t,
        onProbe: probe,
        onRefresh: reload,
      }))
      if (config !== null) {
        children.push(h(RemoteSettings, {
          key: 'config',
          config,
          t,
          busy: busy !== '',
          saving: busy === 'save',
          onSave: saveConfig,
          onError: (text) => setMsg({ ok: false, text }),
        }))
      }
      children.push(h(ActionsCard, {
        key: 'actions',
        plan,
        report,
        busy,
        t,
        onCheck: check,
        onSync: sync,
      }))
      if (conflicts.length > 0) {
        children.push(h(ConflictsCard, {
          key: 'conflicts',
          conflicts,
          busy,
          t,
          onResolve: resolveConflict,
        }))
      }
      children.push(h(BackupsCard, {
        key: 'backups',
        backups,
        busy,
        t,
        onRestore: restore,
      }))
      children.push(h(LogsCard, {
        key: 'logs',
        logs,
        open: logsOpen,
        busy,
        t,
        onToggle: toggleLogs,
        onRefresh: loadLogs,
      }))

      return h('div', { className: 'dcs-panel' }, children)
    }

    /** The Plugins page item: a one-liner in the list, the full panel on its page. */
    function PluginsItem(props) {
      if (props.view === 'summary') return h('span', null, props.t('summary'))
      return h(SyncPanel, props)
    }

    /** Services this panel needs: slot registration and the dictionary store. */
    const inject = ['slots', 'locale']

    /**
     * Mount the settings panel.
     * @param {any} ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'config-sync: dictionaries')

      const face = () => ({ t })

      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'config-sync',
        order: 45,
        label: () => t('title'),
        locale: NS,
        inject: face,
      }, (props) => h(SyncPanel, { ...props, ...face() })))

      // The same panel beside the built-in "网页搜索" card on the Plugins page,
      // which is where users look for a plugin's configuration.
      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'config-sync',
        order: 30,
        label: () => t('title'),
        locale: NS,
        inject: face,
      }, (props) => h(PluginsItem, { ...props, ...face() })))
    }

    exports.name = 'dsh-config-sync'
    exports.inject = inject
    exports.apply = apply
    // Exposed for tooling and the smoke test; the host never reads it.
    exports.dictionaries = { zh, en }
    return module.exports
  },
})
