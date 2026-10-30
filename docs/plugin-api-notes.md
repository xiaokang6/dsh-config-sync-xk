# DSH 插件 API 参考笔记（针对 `dsh-config-sync`）

> 目标读者：需要立刻动手写 `dsh-config-sync` 的工程师。
> 结论全部来自本机真实产物核对，**每一节都标注了文件与行号**；无法确证的地方显式写「待验证」。
>
> - 核对宿主：DeepSeek Harness `0.2.1-rc.5`（Electron 桌面版，Windows x64）
> - 宿主代码位置：`D:\Programs\DeepSeek Harness\resources\app.asar`（asar 内根目录 `dsh/`）
> - 参考插件（只读）：`D:\AI\chajian\dsh-web-search-switch`、`C:\Users\kang\.dsh\profiles\desktop\node_modules\dshmarket`
> - 侦察产物（可丢弃）：`D:\AI\chajian\dsh-config-sync\.recon\`
>   其中 `.recon\hostlib\dsh\node_modules\@deepseek-ai\<包>\...` 是 asar 内同名路径的逐字节副本，
>   `.recon\asar.mjs` / `.recon\extract-subset.mjs` 是 asar 读取脚本，`.recon\skeleton\` 是第 9 节骨架的可运行副本（已通过语法与桩测试）。

**引用约定**：下文写 `@deepseek-ai/xxx/lib/index.js:326` 时，指
`<asar>\dsh\node_modules\@deepseek-ai\xxx\lib\index.js` 第 326 行；本机可直接读
`D:\AI\chajian\dsh-config-sync\.recon\hostlib\dsh\node_modules\@deepseek-ai\xxx\lib\index.js`。
Electron 主进程文件是 asar 根部的 `lib/main.js`（`.recon\main.js`）。前端打包产物是
`@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（`.recon\fe-index.js`）。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| 插件形态 | 标准 ESM 包，`package.json#dsh.bundle.patch` 指向自带的 `cordis.patch.yml`，由 profile 的 `dsh.profile.bundles` 列表激活 |
| 服务端 | Cordis 插件；`inject = ['webServer']` 后在宿主 HTTP 服务器上 `register({kind,path,handler})`；handler 是原生 `(req,res)` |
| 配置 | 导出 Schemastery `Config`；**只有 `.volatile()` 字段**能进设置表单并热更新；值落在 profile 的 `cordis.patch.yml`，按该插件行 `id` 定位 |
| 客户端 | `package.json#dsh.client = { platform:'web', inject:[...] }` + `exports["./client"]`；**可手写、无需构建**，格式是 `window.__ModuleLoader__.load({id, factory(require){...}})` |
| 客户端可用模块 | 宿主 platform seed 表只有 11 个：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（其余必须内置进 bundle） |
| profile 访问 | `ctx.get('profileContext')` → `{name,dir,patchPath,installAnchor,startedBundles,cwd,home,overlays,telemetryDisabledEnv,packageManager?}` |
| 改文件 | 一律 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`；`pnpm-lock.yaml` 只读不写 |
| 跑 pnpm | 桌面端**必须**用 `ctx.get('profileContext').packageManager`（Electron 自带 pnpm 11.28.5）；首选 `ctx.pluginManager.installBundle(spec)` 或 `@deepseek-ai/dsh-plugin-manager/operations` 的 `runProfilePnpm` |
| 重启 | 宿主**没有** restart 服务；桌面端 `allowRestart` 全部为 `false`（重启由 Electron 壳拥有）。插件只能标记「需要重启」并让用户重启 App |

---

## 0.5 速答：客户端注入 / webServer / profileContext / schemastery / cordis 形态

### Q1 `dsh.client.inject` 声明什么？只用 `slots`+`locale` 时写哪些包？

**它声明「包名」，不是服务名，也不是依赖版本**：这些包的客户端 bundle 必须在本包之前
完成模块注册（模块图顺序）。证据：

- 解析与类型校验：`@deepseek-ai/dsh-client-modules/lib/index.js:66-74`
  （`platform` / `inject` / `external` / `immediately` 四个键，全部做类型检查）；
- 消费端：`@deepseek-ai/dsh-client-modules/lib/client.js:786-789`
  —— `for (const packageName of row.inject) { const dependency = this.graphRows.get(packageName); if (dependency !== void 0) await this.arriveDependency(...) }`；
- **列了但该包没被启用 → 静默跳过（不报错）**；而 `external` 是硬契约：
  没有 supplier 会被组合期拒绝（`lib/index.js:433-441`）。所以 `inject` 宁多写不缺。

宿主内实际声明（从各包 `package.json#dsh.client` 读出的原文）：

| 包 | `dsh.client` |
|---|---|
| `@deepseek-ai/dsh-client-ui-renderer`（`slots` 服务提供者） | `{ platform:"web", immediately:true }` |
| `@deepseek-ai/dsh-client-locale`（`locale` 服务提供者） | `{ platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-api-remotes"] }` |
| `@deepseek-ai/dsh-client-ui-settings`（`configForms`/`settingsSchema`） | `{ platform:"web", inject:["@deepseek-ai/dsh-api-remotes"] }` |
| `@deepseek-ai/dsh-client-ui-settings-plugins`（声明 `settings.plugins.tab`） | `{ platform:"web", inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings"] }` |
| `@deepseek-ai/dsh-client-connection` | `{ platform:"web", immediately:true, inject:[] }` |
| `@deepseek-ai/dsh-client-hmr` | `{ platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-modules"] }` |

**推荐写法**（只用 `ctx.slots` + `ctx.locale`）：

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]
  }
}
```

```js
// lib/client.js
const inject = ['slots', 'locale']        // ← Cordis 客户端「服务」名，和上面不是一回事
```

- `slots` 服务由 **`@deepseek-ai/dsh-client-ui-renderer`** 提供（`super(ctx,'slots')`：
  `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1348`）；
  `@deepseek-ai/dsh-client-ui-slots` 只存在于前端 seed 表（是个库，不是 Loader 行）。
- `locale` 服务由 **`@deepseek-ai/dsh-client-locale`** 提供（`:2483` 附近有 `shortcuts`；locale 自身
  在 web-app bundle 的行 id 是 `locale`：`@deepseek-ai/dsh-web-app/cordis.patch.yml:257-258`）。
- 参考插件 `dsh-web-search-switch` 写的是
  `["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-locale"]`
  （`dsh-web-search-switch/package.json:25-32`）——它靠 locale 的传递 inject 拿到 renderer；
  dshmarket 写 `["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-theme"]`
  （`dshmarket/package.json:52-59`）。**两种都工作**；显式写 renderer 更不容易踩顺序坑。
- 如果设置页要用 `configForms`（读写 volatile 配置）：`dsh.client.inject` 加
  `@deepseek-ai/dsh-client-ui-settings`，`inject`（服务）加 `'configForms'`。
- 新增发现：`dsh.client.immediately`（boolean，默认 false）存在，表示「boot 时就加载，不等首次使用」：
  `client-modules/lib/index.js:69,74,745`。

### Q2 `webServer.register` 的精确定义 + 10 行可复制片段

```ts
// @deepseek-ai/dsh-host-webserver/lib/index.js:320-333
register(route: {
  kind: 'exact' | 'prefix'                  // 只有这两个值（:327 用 === 'exact' 分流）
  path: string                              // exact=完整 pathname；prefix=前缀
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
}): () => void                              // disposer：删除该注册项
```

- 同 `(kind,path)` 重复注册**抛错**（`:328`）→ 必须放在 `ctx.effect` 里，用返回的 disposer 清理。
- 匹配：全表 `exact` → 最长 `prefix` → fallback（`:494-504`）；prefix 命中条件
  `pathname === prefix || pathname.startsWith(prefix + '/')`（`:500`）。
- handler 里抛错不会杀进程：未发头时回 400 并 warn（`:395-406`）。

```js
export const inject = ['webServer']            // 等 HTTP 载体就绪再 apply

export function apply(ctx, config) {
  ctx.effect(() => {                            // ← 生命周期绑定：HMR 重载先销毁旧路由
    const dispose = ctx.webServer.register({
      kind: 'prefix',                           // 'exact' 也可；prefix 允许 /dsh-config-sync/**
      path: '/dsh-config-sync',
      handler: (request, response) => dispatch(ctx, config, request, response),
    })
    return () => dispose()                      // ← 返回 disposer，别忘
  }, 'config-sync: http routes')
}
```

`ctx.inject(['webServer'], cb)` 等价但更显式（dshmarket 用这种）：
`@deepseek-ai/dsh-client-connection` 等包都在 `apply` 里
`ctx.inject(['webServer'], registerWebCarrier)`（`@deepseek-ai/dsh-client-modules/lib/index.js:570`）。

### Q3 `profileContext` 的形状与来源 / 桌面端 `pluginManager` 是否可用

- 来源：**launcher 的纯数据服务**，由 `@deepseek-ai/dsh` 的 profile 启动器
  `hostCtx.provide('profileContext', profileContext)` 注入（任何配置树行挂载之前）：
  `@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-304`。
- 类型：`@deepseek-ai/dsh/lib/types/profile-boot.d.ts`（包内 `./profile-boot` 子导出），
  运行时字段（逐字）：`name`、`dir`、`patchPath`、`installAnchor`、`startedBundles`、`cwd`、`home`、
  `overlays`、`telemetryDisabledEnv`，以及**可选**的 `packageManager`。
- 桌面端 `pluginManager`：**提供**。`@deepseek-ai/dsh-base/cordis.patch.yml:20-22` 的行
  `disabled: !!js "!ctx.get('profileContext')"`，桌面 launcher 一定提供 profileContext
  （`@deepseek-ai/dsh-desktop-host/lib/index.js:226-250`）。
- `packageManager` 是否可用于 pnpm install：**可以，而且桌面端必须用它**。它就是
  「Electron 可执行文件 + 打包 pnpm.mjs + 环境」三元组：
  `@deepseek-ai/dsh-desktop-host/lib/index.js:241-249`（本机 pnpm =
  `...\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`，版本 11.28.5）。
  用法见第 6.3 节的 `runProfilePnpm(context, args, { ...packageManager, execution:'service' })`。
  注意：普通 `dsh web` 不带该字段，代码里要做回落。

### Q4 宿主 schemastery 的能力边界（**实测**，版本 3.18.5）

用 asar 里抽出的 `@deepseek-ai/schemastery@3.18.5` 跑脚本验证
（`.recon/skeleton/schemastery-probe.mjs`，可复跑）：

| API | 结果 |
|---|---|
| `z.object({...})` | ✅ |
| `z.array(z.string())`、`z.array(z.string()).default([])` | ✅ 都可用 |
| `z.string().default(x)`、`z.boolean().default(true)`、`z.number().default(3)` | ✅ |
| **`.description('...')`** | ✅ **存在**（`z.string().description()` / `z.object().description()` 均可，落进 `schema.toJSON().meta.description`） |
| `.role('credential-ref')` | ✅ |
| `.volatile()`（可链式接在 `.default()` / `.description()` 之后） | ✅ |
| `.step()/.min()/.max()`、`z.union([z.const(..)])`、`z.transform()`、`z.natural()`、`z.any()`、`z.dict()` | ✅ |
| `z.object(...).toJSON()` | ✅ 返回 `{uid, refs:{...}}`，`meta.volatile` 可见 |

**结论：`.description()` 存在，`lib/index.js` 的 `Config` 不用改。**

一个注意点：**不要直接调用 `Config({})` 取默认值** —— volatile 字段会解析成引用对象
（实测 `Config({})` → `{ enabled: {}, allowPnpmApply: {} }`）。默认值由 cordis 的
`resolveConfig(runtime, config)` 在挂载期物化（`@deepseek-ai/dsh-config-editor/lib/index.js:83`），
你自己读值时按第 3.1 节的 `ref?.get?.() ?? fallback` 写。

### Q5 cordis 4：`ctx.inject(deps, cb)` 里怎么拿服务 / apply 签名 / 导出形态

- `ctx.inject(deps, callback)` 的回调收到一个**派生 Context**，deps 里的服务在该回调执行时保证存在。
  两种取法都行，宿主里都在用：
  ```js
  ctx.inject(['webServer'], (hostCtx) => {
    const server = hostCtx.webServer        // ① 属性访问（dshmarket: host.webServer.register(...)）
    const also = hostCtx.get('webServer')   // ② get()（可选读取时用这个）
  })
  ```
  证据：`dshmarket/src/index.ts:220`（`ctx.inject(['webServer','loader'], (hostCtx) => …)` 内
  `host = hostCtx as …`，随后 `host.webServer.register`）、
  `@deepseek-ai/dsh-client-modules/lib/index.js:570`、`@deepseek-ai/dsh-hmr/lib/index.js:830`
  （`ownerContext.get('profileContext')`）。
- 插件 apply 形态（宿主 Loader 认的就是 cordis 插件的标准形态）：
  模块导出 **`name` / `inject` / `Config` / `apply`**，并额外 `export default { name, inject, Config, apply }`。
  两个真实样例都是这个形态：`dsh-web-search-switch/lib/index.js:31-34,609-616`、
  `dshmarket/src/index.ts:16`（`export const name = 'dsh-market'`）+ `export function apply(ctx, config?)`。
  cordis 会解包 ESM 命名空间（`default` 与具名导出等价）；`Config` 由 Loader 读来做 schema 校验。
- `apply(ctx, config)` 的 `config`：非 volatile 字段是**普通值**，volatile 字段是**引用**
  （第 3.1 节）。`apply` 可以是 async。

---

## 1. A. 插件包形态

### 1.1 `package.json` 的 `dsh` 字段（逐字段含义）

| 字段 | 必需 | 含义与校验点 |
|---|---|---|
| `name` | 是 | 包名；`cordis.patch.yml` 的 `insert[].name` 通常写它 |
| `version` | 是 | 与 `name` 一起构成兼容性豁免键 `name@version` |
| `type: "module"` | 是（本仓库两个样例都是） | 宿主按 ESM 解析；`apply` 可 async |
| `main` / `exports["."]` | 是 | 服务端入口；Loader 行解析到的模块 |
| `exports["./client"]` | 有客户端时必需 | 浏览器半成品入口；**必须是字符串或 `{default: string}`**，否则加载期直接报错 |
| `exports["./cordis.patch.yml"]`、`["./package.json"]` | 建议 | 便于工具读取 |
| `dsh.manifestVersion` | 可选 | 当前格式号 `1`，只是声明，不被强制 |
| `dsh.bundle.patch` | 有 bundle 时必需 | 一个 patch 文件路径，或**有序数组**（依次合并为同一层）；相对包根 |
| `dsh.client.platform` | 有客户端时必需 | 必须是字符串；web 端只加载等于 `"web"` 的声明 |
| `dsh.client.inject` | 可选 | `string[]`：**本 bundle 之前必须先注册的「包名」**（模块注册顺序，不是 Cordis 服务注入）；列了但未启用的包会被静默跳过 |
| `dsh.client.external` | 可选 | `string[]`：非 baseline 的模块请求，每个请求必须由某个动态包行或 seed 表精确回答（缺 supplier 会在组合期被拒绝） |
| `dsh.client.immediately` | 可选 | `boolean`：boot 时就加载该客户端 bundle（默认懒加载） |
| `engines.dsh` / `peerDependencies["@deepseek-ai/dsh*"]` | 强烈建议 | 兼容性准入，见 1.4 |

证据：

- `dsh.client` 解析与校验：`@deepseek-ai/dsh-client-modules/lib/index.js:66-73`
  （`platform` 非字符串即抛错；`inject` / `external` 走 `optionalStringArray`）；
  `:733` 只加载 `platform === "web"` 的行；`:743-744` 把 `inject`/`external` 写进 boot 行。
- `exports["./client"]`：`:171-181`（解析 string 与一层 conditional）、`:738`
  （`declares dsh.client but exports no "./client" bundle` 直接抛）。
- `dsh.bundle.patch` 单文件或有序数组：`@deepseek-ai/dsh-package-manifest/README.md:46`、
  `@deepseek-ai/dsh-app-boot/README.md:50`。
- `dsh.client.inject` 的真实语义（先注册这些包）：`@deepseek-ai/dsh-client-modules/lib/index.js:789`
  （`for (const packageName of row.inject) { ... }` 在消费者之前注册）。

### 1.2 从 profile 加载的机制（bundles 列表 + 补丁层）

一个 profile 就是目录 `$DSH_HOME/profiles/<name>`，里面只有 4 个有意义的东西：

| 文件 | 作用 | 证据 |
|---|---|---|
| `package.json` | 出树插件依赖 `dependencies` + profile 清单 `dsh.profile.bundles`（**有序**） | 本机 `C:\Users\kang\.dsh\profiles\desktop\package.json:4-24` |
| `cordis.patch.yml` | 用户补丁层（顶层 YAML 数组；按 `id` 覆盖/禁用一个行，或 `insert` 新行） | 同上 `cordis.patch.yml:1-8` |
| `cordis.yml` | 空数组 `[]` 的根，**每次启动被重写**，只是给 Loader 一个 baseUrl 锚点；不要手改 | `@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:120-127,216-222` |
| `pnpm-workspace.yaml` | `packages: ['.']`、`nodeLinker: hoisted`、`autoInstallPeers: false` | `@deepseek-ai/dsh-app-boot/lib/index.js:598-603` |

组合顺序（后者覆盖前者，均为「行级替换/插入」，**不是深合并**）：

```
profile 根（空数组）
  ← 每个 bundle 的 dsh.bundle.patch（按 dsh.profile.bundles 顺序，依次叠加）
  ← <profile>/cordis.patch.yml                （用户自己的层）
  ← $DSH_HOME/cordis.patch.yml                （机器级层，优先级更高）
  ← --patch 命令行 overlay（按 argv 顺序）
```

证据：`@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:223-247`（`composeProfile` 的 JSDoc 与实现）、
`@deepseek-ai/dsh/README.md:41-46`、`@deepseek-ai/dsh-app-boot/README.md:50,63`。

要点：

- **bundle 本身不是行**：把一个包加进 `dsh.profile.bundles` 只是让它的 patch 层参与组合；真正让代码运行的是该层 `insert` 出来的行（`id` + `name`）。
- 用户 patch 命中同一 `id` 时会**整体替换 config**（不深合并），所以要保留的字段必须重述：`@deepseek-ai/dsh-app-boot/README.md:204`。
- 行 `name` 可以是包名、绝对路径、`file://` URL；patch 内的 `./`、`../` 会按 patch 文件位置转成 file URL：`@deepseek-ai/dsh-app-boot/README.md:65`。
- profile 里的 `desktop` 名字被 Electron 独占：`dsh plugin --profile desktop` 只在桌面自带的 CLI carrier 下可用（`@deepseek-ai/dsh/README.md:20`、`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:10-12,64-69`）。

### 1.3 ESM / exports / 运行时解析

- 宿主为每次启动安装一张**运行时解析表**（installation 优先 + 有序 bundle 的依赖图），因此插件里的
  `import '@deepseek-ai/schemastery'`、`import '@deepseek-ai/dsh-atomic-write'` 这类「宿主安装自带的包」
  可以按包名解析，无需自己声明 dependencies：`@deepseek-ai/dsh-app-boot/README.md:67,133,138`。
- `link:` 链接目录的导入者仍可参与 peer 感知查找（linked directory 规则）：
  `@deepseek-ai/dsh-app-boot/README.md:134`。这正是 `link:` 安装方式的可行依据。

### 1.4 兼容性准入（决定 peer 范围怎么写）

规则（`@deepseek-ai/dsh-app-boot/lib/index.js:276-299,311`）：

1. 若清单有 `engines.dsh`：只用它决定，**忽略** peerDependencies；
2. 否则**每一个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都必须满足运行时版本；
3. 比较用 `semver.satisfies(runtime, range, { includePrerelease: true })`（`:277`）——所以
   `^0.2.1-rc.5`、`>=0.1.0-rc.8 <0.4.0` 都能匹配 `0.2.1-rc.5`；
4. 不满足时：安装被拒；bundle 被「跳过」并记入 `skippedBundles`（启动时 stderr 打印一次）。

非 `@deepseek-ai/dsh*` 前缀的 peer（如 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不参与准入检查。

---

## 2. B. 服务端：本版本可用的服务与用法

### 2.1 服务名 / API 对照表（节选，全部经代码核对）

完整清单有 130+ 个服务（脚本扫 `super(ctx, "name")`），下表是与本插件相关的一批。
路径均相对 `@deepseek-ai/<包>/lib/index.js`。

| 服务名 | 提供者包 | 关键方法/字段（行号） | 说明 |
|---|---|---|---|
| `webServer` | `dsh-host-webserver` | `register({kind,path,handler})`:326 · `registerUpgrade`:340 · `registerFallback`:355 · `tapIndex`:369 · `match`:495 · `collectIndexInjections`:522 · `renderIndex`:533 · `port`:293 · `host`:297 · `protocol`:305 · `getOrigin`:314 | 宿主 HTTP 载体（HTTP/HTTPS 同一套路由表） |
| `connection` | `dsh-client-connection` | `requestRejection(req)→401\|403\|undefined`:737 · `admit(req)`:742 · `trustedHosts`:693 · `browserPeer`:696 · `authenticatedUrl(base)`:440 | Host/Origin 围栏 + 浏览器会话鉴权；**裸 webServer 路由不经过它，要自己调** |
| `settings` | `dsh-settings` | `describe(options)`:413 · `update(ns,patch,rev)`:470 · `replace(ns,section,rev)`:479 · `mutate(ns,ops,rev)`:488 · `prepareDocument()`:406 · `documentPath`:400 | 把 volatile 配置写成 profile patch；revision 冲突检测 |
| `configEditor` | `dsh-config-editor` | `entries()`:30 · `configuration()`:39 · `inherited(entry,loaded)`:54 · `edit(entry,change)`:69 · `documentPath`:24 | **官方 YAML 编辑器**：校验→加锁→原子写→`reconcileProfilePatches` 回滚保护 |
| `pluginManager` | `dsh-plugin-manager` | `installBundle(spec,options)`:1970 · `listBundles()`:1681 · `listPlugins()`:1656 · `setBundleEnabled(name,enabled)`:1949 · `setPluginEnabled(id,enabled)`:1930 · `removeBundle(name)`:2137 · `cancelInstall`/`waitForInstall`:1534-1545 · `registries()`:1479 · `inspect()`:1490 · `listVersionExemptions()`:1629 · `setVersionExemption(...)`:1643 | 与 `dsh plugin` 共用 pnpm 实现、写锁、快照回滚 |
| `credentials` | `dsh-credentials` | `resolve(ref)` · `describe(ref)` · `set(ref,value)` · `unset(ref)`（README:48-59，实现 `:111` 起） | 密钥只在这里，不进配置文档 |
| `profileContext` | `dsh`（launcher `provide()`） | `@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-301` | 纯数据服务（非 Service 类） |
| `hmr` | `dsh-hmr` | `runExclusive(operation)`:748（configEditor 用法见 `dsh-config-editor/lib/index.js:133-134`） | 串行化「配置重载 / 文件监听 / 管理写入」 |
| `loader` | `cordis-plugin-loader` | `entries()` · `create()` · `exit()`（`:665`） | Cordis Loader；`exit()` 是「退出进程」，不是重启 |
| `web` | `dsh-web` | `registerSearchProvider(provider)`:69 · `Config.searchProvider` volatile:48-50 | 搜索/抓取接缝（本插件用不到，列作参考） |
| `launchEnvironment` | `dsh-launch-environment` | `launchEnvironmentOf(ctx)`:63 · `DSH_LAUNCH_ENVIRONMENT_KEY`:82 | 启动环境快照（取值优先于 process.env 的兜底） |
| `pluginInventory` | `dsh-host-plugin-inventory` | `:97` | 只读插件清单（Settings 插件列表用它） |
| `agents` | `dsh-agent` | `list()` 等（`:332`） | Agent 名册（dshmarket 用它做安装前后的守卫） |
| `jobs` | `dsh-jobs` | `list(agentId)`（`:118`） | 后台任务名册 |
| `storage` / `fs` / `subprocess` | `dsh-storage`、`dsh-fs`、`dsh-subprocess` | `:109` / `:60` / `:88` | 需要落盘/开子进程时的官方接缝 |

本版本**不存在** `restart`、`desktopProfiles`、`desktopPnpm`、`app` 之类的服务：

- `restart`：全量服务名清单中没有（见第 7 节）；
- `desktopProfiles` / `desktopPnpm`：那是**第三方 Electron 壳**的契约，官方桌面端不提供
  （dshmarket 的判断逻辑：`dshmarket/src/index.ts:222-224,353-358`）；
- `pluginManager` 在桌面 profile 中**是启用的**：`@deepseek-ai/dsh-base/cordis.patch.yml:20-22`
  （`disabled: !!js "!ctx.get('profileContext')"`，桌面端 launcher 提供了 profileContext）。

### 2.2 `webServer.register` 的确切签名

```ts
// @deepseek-ai/dsh-host-webserver/lib/index.js:320-333
register(route: {
  kind: 'exact' | 'prefix'
  path: string                     // exact: 完整 pathname；prefix: 前缀（见下方匹配规则）
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
}): () => void                     // 返回 disposer
```

要点（全部来自 `@deepseek-ai/dsh-host-webserver/lib/index.js`）：

- 同一 `(kind,path)` 重复注册**直接抛错**（`:328`）。HMR 重载插件时旧行会先销毁，所以注册必须挂在
  `ctx.effect` 里，用返回的 disposer 清理。
- 匹配顺序：先全表 `exact`，再 `prefix` 里最长者，最后 fallback（`:494-504`）。
  prefix 命中条件是 `pathname === prefix || pathname.startsWith(prefix + '/')`（`:500`）。
- handler 抛错/拒绝不会杀进程：已被 `handle()` 的 `.catch` 兜住，未发头时回 400 并 warn（`:395-406`）。
- 路由注册顺序对请求无影响；HTTP 升级用 `registerUpgrade`（`:340`）；fallback 只有一个座位（`:355`）。
- `getOrigin()` 只在端口绑定后可用，抛错时机见 `:314-319`。

dshmarket 里的包装写法（**可直接照抄**，`dshmarket/src/routes.ts:2141-2151`）：

```ts
const registerRoute = (route: Parameters<WebServerService['register']>[0]): (() => void) => {
  const handler = route.handler
  return host.webServer.register({
    ...route,
    handler: (request: IncomingMessage, response: ServerResponse) => {
      if (refuseUnadmitted(request, response)) return
      return handler(request, response)
    },
  })
}
```

### 2.3 新插件注册 `GET/POST /dsh-config-sync/...` 的最小片段

```js
export const inject = ['webServer']

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-config-sync',
      handler: (request, response) => dispatch(ctx, config, request, response),
    })
    return () => dispose()
  }, 'config-sync: http routes')
}

async function dispatch(ctx, config, request, response) {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const method = request.method ?? 'GET'
  if (pathname === '/dsh-config-sync/api/state') {
    if (method !== 'GET') return sendJson(response, 405, { allow: 'GET' })
    return sendJson(response, 200, await readProfileSnapshot(ctx))
  }
  if (pathname === '/dsh-config-sync/api/settings') {
    if (method !== 'POST') return sendJson(response, 405, { allow: 'POST' })
    /* 读 body → ctx.get('settings').update(...) */
  }
  sendJson(response, 404, { error: 'no such endpoint' })
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}
```

**鉴权**：裸 `webServer` 路由不经过宿主的 `/api` 围栏，必须自己判：

```js
const connection = ctx.get('connection')
const rejection = connection?.requestRejection?.(request) // 401 | 403 | undefined
if (rejection !== undefined) { sendJson(response, rejection, { error: 'refused' }); return }
```

语义：`401` = 受信但未登录（打开 `dsh web` 打印的带 token 的 URL 换取 cookie）；
`403` = Host/Origin 不受信；`undefined` = 放行（`:737-749`、README:47）。

### 2.4 插件生命周期写法要点

| 写法 | 语义 | 出处 |
|---|---|---|
| `export const inject = ['webServer']` | 该行等 `webServer` 可用后才 apply；服务消失时自动 stop | cordis 插件契约；样例 `dsh-web-search-switch/lib/index.js:34` |
| `ctx.inject([...], cb)` | 在子作用域里等一组服务就绪再挂（dshmarket 主用） | `dshmarket/src/index.ts:220` |
| `ctx.effect(fn, label)` | 注册可清理副作用；返回 disposer | `dsh-host-webserver/lib/index.js:411,492`、`dshmarket/src/index.ts:294-310` |
| `ctx.get('name')` | 可选读取服务（不触发等待） | `dsh-web-search-switch/lib/index.js:460`、`dshmarket/src/index.ts:159` |
| `ctx.provide('name', value)` | 提供纯数据服务 | `@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:304` |
| 事件 `settings/document-updated` | 配置文档 revision 变化 | `dsh-settings/lib/index.js:435,461` |
| 事件 `plugin-manager/install-state` | 安装阶段进度 | `dsh-plugin-manager/lib/index.js:1980` |
| 事件 `webserver/index-inject` | 往 index.html 注入行（客户端插件系统用它） | `dsh-host-webserver/lib/index.js:524` |
| 瀑布 `connection/request` | 已鉴权请求的准入钩子（桌面用它锁安装期间的 API） | `dsh-desktop-host/lib/index.js:116-130`、README:53 |

---

## 3. C. 配置 schema

### 3.1 声明方式

用 `@deepseek-ai/schemastery`（默认导出 `z`）：

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  allowPnpmApply: z.boolean().default(false).volatile(),
  patchEntryId: z.string().default('config-sync'),  // 非 volatile：改动会重挂载
})
```

- 官方同类写法：`@deepseek-ai/dsh-web/lib/index.js:48-50`
  （`static Config = z.object({ searchProvider: z.string().volatile(), ... })`）、
  `dsh-web-search-switch/lib/index.js:326-342`（`.default().volatile()`、`.role('credential-ref')`）。
- 在 `apply(ctx, config)` 里，**volatile 字段拿到的是引用对象**，要 `.get()` 读当前值：
  `dsh-web/lib/index.js:100`（`this.config.searchProvider.get()`）、
  `dsh-web-search-switch/lib/index.js:345-353`（`ref?.get?.()`）。

### 3.2 配置落在 `cordis.patch.yml` 的哪里

按**该插件行的 `id`** 定位，写成一个顶层数组元素：

```yaml
# <profile>/cordis.patch.yml
- id: config-sync          # ← Loader 行 id（bundle patch 里 insert 的那个 id）
  config:
    enabled: false         # 整块替换，不深合并
```

本机实证：`C:\Users\kang\.dsh\profiles\desktop\cordis.patch.yml:4-8`
（`- id: agent-default-model` / `config:`）与 `:139-143`（`- id: web` + `config.searchProvider`）。

默认值放哪：**放 bundle patch 的 `config`**（第 9 节骨架即是），这样用户 patch 只需写差异字段；
但用户 patch 会整体替换该 `config` 对象，缺省字段回落到 schema 的 `.default()`。

### 3.3 校验、热更新与写回

| 环节 | 行为 | 出处 |
|---|---|---|
| schema 校验 | 加载/重载时按 `Config` 校验；失败 → 新行保持 inactive，旧行保留原实例与配置 | `@deepseek-ai/dsh-app-boot/README.md:102` |
| volatile 热更 | 只改 volatile 且其它有效值不变时**就地提交**运行引用，发 `loader/volatile-update`，不重挂载 | `@deepseek-ai/cordis-plugin-loader/README.md:51` |
| 非 volatile 变更 | 走普通 remount（插件重建） | 同上 |
| 写回文件 | `ctx.settings.update(ns, patch, expectedRevision)` → 改写该行的 `config`，revision 不匹配则拒绝 | `dsh-settings/lib/index.js:465-473` |
| 表单投影 | `settings.describe()` 只暴露 **volatile** 字段，返回 `{autoGenerate, ns, schema, revision, applies, value, base, user}`（`redactSecrets` 时还有 `secrets` 存在标记） | `dsh-settings/lib/index.js:413-464` |
| 官方 YAML 编辑 | `ctx.configEditor.edit(entry, change)`：取锁 → 重新组合校验 → 用 `yaml` 文档 API 保留 `!!js` 与缩进 → 原子写 → `reconcileProfilePatches` 失败回滚 | `dsh-config-editor/lib/index.js:69-135` |
| 家庭/命令行层覆盖 | 写表单会被 home patch 或 `--patch` 覆盖时**拒绝写入** | `dsh-config-editor/lib/index.js:122` |

结论：**新插件不要自己拼 YAML 写 config**。要写就用 `settings.update()`（字段级）或
`configEditor.edit()`（整块），它们已经处理了 revision、锁、原子写、回滚和 `!!js` 保真。

---

## 4. D. 客户端

### 4.1 注入与打包机制

1. `package.json#dsh.client = { platform: 'web', inject: [...], external: [...] }`
2. `exports["./client"]` 指向浏览器半成品文件（构建产物或手写文件都行）。
3. 宿主 Node 半（`ctx.clientModules`）扫描**已启用的 Loader 行**，把每个包的 `client.js`
   组合成 `/plugins/??...&rev=...` 的 combo 脚本，并通过 `webserver/index-inject` 把
   `window.__ModuleLoader__` 队列门面 + boot graph（`window.__DSH_BOOT__`）注入 index.html：
   `@deepseek-ai/dsh-client-modules/README.md:12,38,82-84`。
4. 浏览器半（`ctx.modules`）懒加载：执行 bundle 只注册工厂，副作用在 materialize 时运行：
   同上 `:70-72`。
5. 资源版本 = `mtimeMs/ctimeMs/size`（非内容哈希），所以**改了 client.js 会被 HMR 换掉**：
   同上 `:78`。缺文件会在启用期直接报错并给出 build 提示：`@deepseek-ai/dsh-client-modules/README.md:54`。

`dsh.client.inject` ≠ Cordis 的 `inject`：前者是「这些**包**的客户端模块先注册」（模块图顺序），
后者（bundle 里 `exports.inject = [...]`）是「等这些**服务**就绪」。两者都要写：

```js
// lib/client.js 末尾
const inject = ['slots', 'locale']   // ← Cordis 客户端服务名
exports.apply = apply
exports.inject = inject
```

### 4.2 宿主提供的 externals（platform seed 表，精确 11 个）

来自前端产物 `@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 的 `OZ()`
（`.recon/fe-index.js` 内约字节偏移 917901）：

```js
{
  'react': …, 'react/jsx-runtime': …, 'react-dom': …, 'react-dom/client': …,
  '@deepseek-ai/cordis': …, 'zod': …,
  '@tanstack/react-virtual': …,
  '@deepseek-ai/dsh-client-store': …,
  '@deepseek-ai/dsh-client-ui-slots': …,
  '@deepseek-ai/dsh-client-ui-primitives': …,
  '@deepseek-ai/dsh-client-ui-dockkit': …
}
```

- 这 11 个之外的任何 import 都必须被你的 bundle 内置；`dsh.client.external` 只用来声明
  「非 baseline 的跨包请求」，且必须有 supplier 包行来回答（`dsh-client-modules/lib/index.js:433-435`）。
- 因此**手写客户端时只用 `require('react')` 最稳**（`dsh-web-search-switch/lib/client.js:25` 就是这么做的）。
- 想用 `@deepseek-ai/dsh-client-ui-primitives` 的组件也可以（它在 seed 表里），但**不要**在
  `dsh.client.external` 里声明它。

### 4.3 手写、无需构建的客户端入口（逐字可用的形态）

宿主模块系统按 **lazy-CJS 工厂**登记（`window.__ModuleLoader__.load({ id, factory })`），
`factory(require)` 返回 exports，exports 被当作普通 Cordis 浏览器插件。
两个真实样例：`dsh-web-search-switch/lib/client.js:18-25,714-719`（32KB 纯手写）与
`dshmarket/client/client.js:1-6` + 文件末尾（tsdown 产物，形态完全相同）。

```js
window.__ModuleLoader__.load({
  id: 'dsh-config-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    function Panel() { /* … */ }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'config-sync',
        order: 60,
        label: () => '配置同步',
        locale: 'config-sync',
      }, () => h(Panel, null))), 'config-sync: settings tab')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

硬约束：

- `id` 必须等于包名（模块系统按包名解析 `<id>/client` 与裸 id：`dsh-client-modules/README.md:38`）。
- 工厂里 `require` 解析顺序 = seed 表 → 已缓存模块 → boot graph 行 → 已注册工厂，否则抛错
  （`dsh-client-modules/lib/client.js:840`）。所以 require 名字写错会立刻炸，容易定位。
- 不要写 ESM `import`：这是脚本（非 module）上下文。

### 4.4 设置页 / 设置卡：可用的 slot 与 API

| Slot | 由谁声明 | 用途 | 证据 |
|---|---|---|---|
| `settings.plugins.tab` | `dsh-client-ui-settings-plugins`（Settings → 内置插件 的标签页行） | 加一个设置页 tab | `@deepseek-ai/dsh-client-ui-settings-plugins/README.md:30`；本机 profile 该行存在（`@deepseek-ai/dsh-web-app/cordis.patch.yml:437-438`） |
| `plugins.item` | `dsh-client-ui-plugin-manager`（侧边栏 Plugins 页） | 在 Plugins 页加卡片/整页 | `dsh-web-search-switch/lib/client.js:704-711`；行存在（`web-app/cordis.patch.yml:318-319`） |
| `settings.section` | `dsh-client-ui-settings` | 一级设置分区 | `@deepseek-ai/dsh-client-ui-settings/README.md:44` |
| `settings.onboarding` | 同上 | 引导步骤 | 同上 |

注册 API：

```js
ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
  { name: 'settings.plugins.tab', id, order, label: () => 文案, locale: NS /*, inject: () => extraProps */ },
  (props) => h(Component, props),
))
```

`slots.register(rawOptions, component)` 返回 disposer，且内部已用 `ctx.effect` 包好
（`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1813-1816`）；
`ctx.slots.inject(name, cb)` 用于「该 slot 存在时再注册」。
`label` 用函数是已被验证的形态（`dsh-web-search-switch/lib/client.js:697`）；
其余字段（`inject` 透传语义）在 README 未定义 —— 见「待验证」。

配置表单（读/写 volatile 字段，走宿主 Settings RPC）：

```js
const form = ctx.configForms.get('config-sync')          // 与服务共享同一实例
const snapshot = form.getSnapshot()                       // {status,value,base,user,revision,writable}
await form.set('enabled', true)                            // → boolean 是否被接受
await form.unset('field')                                  // 恢复继承值
await form.mutate([{ op: 'set', path: ['x'], value: 1 }])  // 原子多条
```

证据：`@deepseek-ai/dsh-client-ui-settings/lib/client.js:1103-1180`（快照字段与 set/unset/mutate）、
`dsh-web-search-switch/lib/client.js:626-629,686-691`（真实用法）。
表单需要 `configForms` 服务 → 浏览器插件 `inject` 里写 `'configForms'`，且 bundle 的
`dsh.client.inject` 里带上 `@deepseek-ai/dsh-client-ui-settings`（样例同款）。

### 4.5 客户端**不能**注册服务端路由

客户端只能往 slot 里塞 UI；管理页的 HTML/接口必须由 Node 半用 `webServer.register` 提供
（也就是第 2.3 节）。若要做「独立整页」，两条路：

1. 服务端路由直接返回自包含 HTML（第 9 节骨架的 `/dsh-config-sync/`），用户用浏览器访问即可；
2. 走 `plugins.item` slot，在宿主 SPA 里渲染整页（dshmarket 就这么做）。

---

## 5. E. profile 访问

### 5.1 `profileContext` 的精确结构

`@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-301` 逐字段：

```js
const profileContext = {
  name,                         // profile 名（桌面端恒为 'desktop'）
  ...(packageManager === undefined ? {} : { packageManager }),  // 见 6.2
  dir,                          // profile 目录绝对路径
  patchPath,                    // <dir>/cordis.patch.yml 绝对路径
  installAnchor,                // dsh 安装的 package.json 绝对路径
  startedBundles,               // 本次启动实际加载的 bundle 包名（有序）
  cwd,                          // process.cwd()
  home,                         // resolveDshHome()
  overlays,                     // --patch overlay 解析结果
  telemetryDisabledEnv,         // process.env.DSH_TELEMETRY_DISABLED
}
```

它由 launcher 在挂载任何配置树行之前 `provide('profileContext', …)`（`:302-304`），
所以插件 apply 时一定能拿到（桌面端同样走 `runProfile`：`@deepseek-ai/dsh-desktop-host/lib/index.js:226-250`）。

### 5.2 profile 目录 / DSH_HOME 解析

| 事实 | 值 | 证据 |
|---|---|---|
| 环境变量 | `DSH_HOME`（空白视作未设置） | `@deepseek-ai/dsh-home-paths/lib/index.js:15,101-110` |
| 默认 home | `~/.dsh` | 同上 `:11,56` |
| profile 目录 | `<home>/profiles/<name>` | `@deepseek-ai/dsh-app-boot/lib/index.js:546`（`resolveProfileDir`）、README:50 |
| 本机实测 | `C:\Users\kang\.dsh\profiles\desktop` | `desktop/package.json`、`desktop/pnpm-lock.yaml` 存在 |
| 桌面端项目目录 | 由 Electron 传入（`DesktopHostProcess` 的 `projectDir`），**不要自己拼** | `lib/main.js:3789-3800`、`@deepseek-ai/dsh-desktop-host/lib/index.js:220-224` |

不要通过 `process.argv` 猜 profile：桌面端没有 `--profile` 参数（launcher 内部固定 `profile: "desktop"`，
`dsh-desktop-host/lib/index.js:228`）。**只用 `profileContext`。**

### 5.3 安全读写 profile 文件

推荐的官方原语（宿主自己也在用）：

```js
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

const profile = ctx.get('profileContext')

// 读
const manifest = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'))
const patch = await readFile(profile.patchPath, 'utf8')
const lockfile = await readFile(join(profile.dir, 'pnpm-lock.yaml'), 'utf8').catch(() => undefined)

// 跨进程写：锁 + 原子替换
await withFileLock(join(profile.dir, 'package.json'), async () => {
  const text = await readFile(join(profile.dir, 'package.json'), 'utf8')
  const next = JSON.parse(text)
  next.dsh ??= {}; next.dsh.profile ??= {}; next.dsh.profile.bundles ??= []
  await writeFileAtomic(join(profile.dir, 'package.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
})
```

依据与坑：

- `writeFileAtomic(path, text, { mode })`：`wx` 建临时兄弟文件再 rename；Windows 对
  `EACCES/EBUSY/EPERM` 有界重试；**`mode` 必填**（`@deepseek-ai/dsh-atomic-write/README.md:28-39,83-91`）。
- `withFileLock(path, fn, { waitMs })`：创建 `<file>.lock`，跨进程串行；默认 2s 超时会失败，
  长操作要显式给 `waitMs`（同上 `:41-57`）；锁的父目录必须已存在（`:63`）。
- **profile 写锁的既定名字就是 `package.json`**：Config Editor 用
  `withFileLock(join(profileContext.dir, "package.json"), …)`（`dsh-config-editor/lib/index.js:72`），
  Plugin Manager 也一样（`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:39,90`）。你自己写任何 profile 文件时
  也用这个锁，才能和它们互斥。
- **JSON 千万不要带 BOM**：BOM 会让 app-boot 拒绝 profile 清单
  （`dsh-web-search-switch/scripts/install.mjs:63` 的注释；`saveManifest` 也只写纯 UTF-8：
  `@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:92-94`）。
- **`pnpm-lock.yaml` 永远不要手写**：它是 pnpm 的产物；手改会让下一次 `pnpm add/install` 重新解析
  且可能锁死错误版本。只读它用于展示（本插件 `GET /state` 就是这么做的）。
- 备份：官方 CLI 安装脚本的做法是 `package.json` 旁边写 `<name>.bak-<ISO时间>` 再覆盖
  （`dsh-web-search-switch/scripts/install.mjs:61-65`）；`sanitizeProfile()` 会把
  `cordis.patch.yml` 改名为 `.bak-<毫秒时间戳>`（`@deepseek-ai/dsh-app-boot/README.md:69`）。

### 5.4 改完之后：谁会触发重组 / 插件能否主动请求

**会自动触发重组的文件**（HMR 启用时；桌面 profile 的 `hmr` 行是启用的：
`@deepseek-ai/dsh-base/cordis.patch.yml:28-32`）：

1. profile 的 `package.json` —— **只有 `dsh.profile.bundles` 有序列表变化**才重载；
   纯依赖项变化不触发（`@deepseek-ai/dsh-hmr/README.md:59`、`:118`）；
2. profile 的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`（机器级层）。

其它事实：

- 监听使用 `awaitWriteFinish: true`（默认 2s 稳定性窗口），所以**写完立刻断言重载完成会失败**；
  直接调 Plugin Manager 的操作不经过文件事件（`@deepseek-ai/dsh-hmr/README.md:47`）。
- 无 HMR 时：一切改动「重启后生效」（同上 `:27`）。
- **插件主动请求重组**的两条官方途径：
  - `ctx.get('hmr').runExclusive(fn)` —— 把你的重载/写入塞进 HMR 的串行队列（Config Editor 用法：
    `dsh-config-editor/lib/index.js:133-134`；README:59 说明调用方必须持队列）；
  - `reconcileProfilePatches(ctx.root, patches, 'dsh', requiredIds)` —— app-boot 的直接重组入口，
    不发布运行时解析、不重试失败 import（`@deepseek-ai/dsh-app-boot/lib/index.js:3794`，README:94）。
- 改动「新增/删除包」这类需要重新发布运行时解析的操作，**不要自己搞**：用 `pluginManager`（6.3）。

---

## 6. F. 安全执行 pnpm

### 6.1 宿主发布的包管理器调用（`profileContext.packageManager`）

桌面端（唯一会跑本插件的环境）注入的形态，逐字来自
`@deepseek-ai/dsh-desktop-host/lib/index.js:241-249`：

```js
packageManager: {
  command: process.execPath,                       // Electron 可执行文件
  args: ['--expose-internals', process.argv[5]],   // argv[5] = 打包的 pnpm.mjs
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
    PATH: `${process.argv[6] ?? ''};${process.env.PATH ?? ''}`,
  },
}
```

本机对应实体：

- `command` = `D:\Programs\DeepSeek Harness\DeepSeek Harness.exe`（以 `ELECTRON_RUN_AS_NODE=1` 当 node 用）
- pnpm 包体 = `D:\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
  （同目录 `pnpm.cjs`、`dist/`、`package.json`；版本 `11.28.5`：
  `resources\runtime\primary-runtime\runtime.json`）
- `PATH` 前置 `resources\runtime\bin`

`dsh` CLI 侧同款注入：`@deepseek-ai/dsh-desktop-host/lib/cli.js:96-107`。
非桌面/普通 `dsh` 安装没有这个字段（`profileContext.packageManager` 不存在）→ 那时才回落到 PATH 上的 `pnpm`。

**结论**：桌面端插件跑 pnpm 必须用 `profileContext.packageManager` 的 `{command,args,env}` 组合，
`spawn(command, [...args, 'add', spec], { cwd: profileContext.dir, env })`；直接用 `'pnpm'`
在桌面端很可能解析不到（或者解析到用户全局 pnpm 的另一个版本）。

### 6.2 官方插件安装服务：`pluginManager`

本版本桌面 profile **启用了** `pluginManager`（1.2 节）。公开方法（装饰器登记的名字，
`@deepseek-ai/dsh-plugin-manager/lib/index.js:1435-1556`）：

```
listVersionExemptions()            setVersionExemption(pkgVersion, runtimeVersion, enabled, acceptRisk)
listPlugins()                      listBundles()            registries()      inspect(spec?)
setPluginEnabled(id, enabled)      setBundleEnabled(name, enabled)
installBundle(spec, options)       waitForInstall(...)      cancelInstall(...)   removeBundle(name, ...)
```

`installBundle(spec, options)` 的内幕（`:1970-2100` 起）：

- 参数：`spec` 一个 pnpm spec（**本地路径必须是绝对路径**，可写 `link:`/`file:` 前缀）；
  `options = { activate?, requestId?, approvedBuilds?, saveExact?, registry? }`（JSDoc `:1965-1968`）。
- 行为：`pnpm add <spec> [--save-exact] [--registry=…]`（`:2033-2038`）；
  开始时快照 `package.json` + `pnpm-lock.yaml`，失败/取消/加进来的包没有 bundle patch 就**回滚**
  （`:1944-1964`、`operations.js:318,331-338`）；
  成功后写 `dsh.profile.bundles` 选择并通过 HMR 激活（无 HMR 时报告 `restart-required`）。
- 开着 HMR 时，若该包已在依赖里会先抛 `already-installed`（`:1991`）。
- spec 解析：`parseInstallSpec`（`lib/types/install-spec.js:58-87`）——支持 registry 名、git、
  tarball、`link:`/`file:` 绝对路径；**相对路径会被拒绝**。
- 需要 pnpm 的地方都会走 `this.profile.packageManager`（`:2005` 读它的 `env`）。

### 6.3 直接跑 pnpm 的官方实现（当你需要 `pnpm install`/`remove` 等自由命令时）

`@deepseek-ai/dsh-plugin-manager/operations`（子路径导出，`package.json#exports["./operations"]`）提供：

```js
import { runProfilePnpm, runPluginCommand, anchorPathSpec } from '@deepseek-ai/dsh-plugin-manager/operations'

const context = {
  profile: profileContext.name,
  dir: profileContext.dir,
  installAnchor: profileContext.installAnchor,
  cwd: process.cwd(),
}
const options = {
  ...profileContext.packageManager,   // { command, args, env } —— 桌面端必需
  execution: 'service',               // 'service' 捕获输出并杀掉整棵子进程树；'cli' 继承终端
  outputBytes: 16384,
  lockWaitMs: 120000,
  lookupTimeoutMs: 120000,
  onOutput: (text, stream) => { /* stream: 'stdout' | 'stderr' */ },
}
const result = await runProfilePnpm(context, ['install'], options)
// → { exitCode, output, truncated, logPath, incompatible? }
```

逐字依据：`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:74-93`（官方 CLI 自己的调用形态）、
`@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:288-299`（`runProfilePnpm` 的 JSDoc 与签名）。
它同样会：抢 profile 写锁（调用方持有）、快照 `package.json`/`pnpm-lock.yaml`、失败回滚、
把日志写到 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`、检测「仍在进行的 run」并拒绝并发
（`operations.js:299-338`、`:208-251`）。

### 6.4 `dsh plugin --profile …` CLI

```sh
dsh plugin --profile <name> <pnpm args...>     # 在 profile 目录里把参数转发给 pnpm
dsh plugin --profile <name> allow-version <pkg@version> --dsh-version <exact> --accept-risk
dsh plugin --profile <name> revoke-version …
dsh plugin --profile <name> version-exemptions
```

证据：`@deepseek-ai/dsh/README.md:18,20`、`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:14-98`。

**桌面 profile 的限制**：CLI 拒绝对名为 `desktop` 的 profile 做插件管理（npm 版 CLI）；
只有桌面安装自带的 CLI carrier（`dsh-desktop-host/lib/cli.js`，`manageDesktopProfile: true`）可以，
且必须在桌面 App 完全退出后运行（`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:10-12`、
`@deepseek-ai/dsh/README.md:20`、dshmarket 的注释 `src/index.ts:231-247`）。
⇒ **从 App 内部的插件里不要走 CLI**，用 `ctx.pluginManager` 或 `runProfilePnpm`。

### 6.5 profile 需要哪些 pnpm 参数

`<profile>/pnpm-workspace.yaml`（profile 初始化时写入，`@deepseek-ai/dsh-app-boot/lib/index.js:598-603,625-626`）：

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

- `nodeLinker: hoisted`：依赖平铺在 `<profile>/node_modules`，宿主运行时解析与 link 感知都按这个布局工作。
  **不要**改成 isolated（会打乱宿主的 profile 解析假设）。
- `autoInstallPeers: false`：peer 由 dsh 安装本体提供，不由 profile 补装。
- `storeDir`：profile 里**没有**设置；按 pnpm 默认（用户级 store）。（是否有 launcher 注入
  store 环境变量 → 待验证；代码里未见。）
- git 托管的插件有 build 脚本时，pnpm 会拦截并提示把 key 加进该文件的 `allowBuilds`
  （`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:97`）。不要绕过，按提示加 key。

### 6.6 风险：**绝不要**「清空 dependencies 再逐个 add」

危险做法（会剪掉 node_modules）：

```js
manifest.dependencies = {}            // ← 千万别
await runProfilePnpm(context, ['install'], options)
```

原因：`pnpm install` 以 manifest 为准做 reconciliation，**manifest 里没有的包会被从
`node_modules` 移走**。hoisted linker 下这一步会把 profile 里所有其它插件（dshmarket、
dsh-web-search-switch、用户装的一切）统统剪掉，宿主下次启动直接缺包。而 `pnpm remove` 单个包
只影响那一个包及其独占依赖。

安全做法（按推荐度）：

1. **增删都走 `ctx.pluginManager.installBundle(spec)` / `removeBundle(name)`**：它自动维护
   `dependencies` + `dsh.profile.bundles`，并且失败回滚（6.2）；
2. 需要自由命令时用 `runProfilePnpm(context, ['add', spec], options)` / `['remove', name]`；
3. 若确实要重写 `dependencies`（例如批量迁移），必须：
   - 先备份 `package.json` + `pnpm-lock.yaml`（复制成 `.bak-<时间戳>`）；
   - **保留**所有现有 key，只做增量修改，绝不置空；
   - 用 `withFileLock(<dir>/package.json)` 串行化；
   - 只跑 `pnpm install --prefer-offline`（不要 `--force`、不要删 `node_modules`、不要删 lockfile）；
   - 失败时用备份还原两个文件；
4. 永远不要手写 `pnpm-lock.yaml`；不要 `rm -rf node_modules`（桌面端下一次启动会失败）。

另外两个并发/时序坑：

- HMR 的队列**不管**包操作（`@deepseek-ai/dsh-hmr/README.md:59`），别指望它给你串行；
  真正的互斥是 `<dir>/package.json` 的写锁；
- 安装/删除期间不要同时改 `cordis.patch.yml`：先包操作后配置，或者反过来，别并行。

---

## 7. G. 重启

### 7.1 本版本没有「重启服务」

- 全量服务名扫描（`super(ctx, "name")`）**没有** `restart`；
- `loader.exit()` 存在（`@deepseek-ai/cordis-plugin-loader` 的 `index.js:665`），语义是让宿主退出进程，
  HMR 在框架依赖变化时调用它（`@deepseek-ai/dsh-hmr/README.md:108`）——它是「退出」，不是「重启」。

### 7.2 桌面端：重启由 Electron 壳拥有，插件**不能**自杀式重启

- Electron 主进程只 spawn **一个** Node 子进程跑宿主：`lib/main.js:3794`
  （`DesktopHostProcess.start()`，`spawn(node, ['--expose-internals', <desktop-host/lib/index.js>, runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin], { stdio: ['ignore','pipe','pipe','ipc'] })`，
  构造点 `lib/main.js:12182`）；
- 子进程一旦 `close`，无论退出码是多少，都会走 `fail(...)`（`lib/main.js:3842` 起的
  `child.once("close", …)`），即 UI 报「宿主已停止」，**不会自动重启**；
- dshmarket 在三个桌面分支上都写死 `allowRestart: false`（`dshmarket/src/index.ts:283,379`），
  并把「重启」交给壳（`src/restart.ts:12` 注释：`the whole feature with allowRestart: false — the
  supervisor owns restarts`）。

⇒ `dsh-config-sync` **不要**调用 `process.exit()`、不要 `app.relaunch()`、不要 spawn 替代宿主。
桌面端的正确做法：在 UI 上显示「需要重启 DeepSeek Harness 才能生效」，并给出受影响的文件/插件清单。

### 7.3 参考：dshmarket 在 `dsh web`（非桌面）上的自重启实现

若将来要在 `dsh web` 上做，它是这么做的（可作为「不要重造」的反面参考）：

- 路由 `POST /dsh-market/restart`（`dshmarket/src/routes.ts:5767` 起）：先 `restartAllowed(config)`
  判定（`src/restart.ts:171-177`，`allowRestart` 未配置时按检测到的 supervisor/debugger 决定），
  再 `detectedDebugger()`、`trustedRestartRequest(request)`（同源 loopback）、
  以及「有写操作/安装进行中」时 409；
- 真正重启是**另起一个 detached helper 脚本**，等旧进程退出后再 spawn 新宿主
  （`src/restart.ts:392-560`，含 Windows 上不能用 `detached` 的原因说明）。

### 7.4 表达「需要重启」的官方词汇

`pluginManager` 的结果对象用 `application` / `restartReason` 表达（如 `'restart-required'`、
`'package-moved'`）——参见 `@deepseek-ai/dsh-plugin-manager/README.md:100,157-158`、
`@deepseek-ai/dsh-hmr/README.md:71`。本插件的 `GET /state`、`POST /install` 原样把
`result.application` 透出即可，让 UI 决定提示什么。

---

## 8. H. 密钥

| 事实 | 内容 | 证据 |
|---|---|---|
| 凭据文件 | `<harness home>/.credentials.yaml`，默认 `<DSH_HOME>/.credentials.yaml`；本机实测 `C:\Users\kang\.dsh\.credentials.yaml` 存在 | `@deepseek-ai/dsh-credentials-local/README.md:42-45` |
| 权限 | 产品以 owner-only 创建；POSIX 上拒绝加载「他人可读」的文件（Windows 跳过该检查） | 同上 `:115,121` |
| 组合来源 | managed 文件 → 继承环境 → 项目 `.env` → 用户 `.env` | `@deepseek-ai/dsh-base/cordis.patch.yml:113-126` |
| `.env` 规则 | 调用目录的 `.env` 优先于 home 的；两者都低于继承环境；`PATH`/`DSH_*`/`XDG_*` 不允许从文件设置；四个代理变量只接受 home `.env` | `@deepseek-ai/dsh-app-boot/README.md:60` |
| 服务 API | `credentialRef('NAME')`、`resolve`（拿值）、`describe`（只报 configured/source/writable）、`set`、`unset`；另有 `credentialKey` + 记录型凭据 | `@deepseek-ai/dsh-credentials/README.md:48-70,111` |
| 表单脱敏 | `settings.describe({ redactSecrets: true })` 把 secret role 字段替换成存在标记 | `@deepseek-ai/dsh-settings/lib/index.js:440-451`、README:49 |

避免泄露的实践（照做即可）：

1. **配置里只放「引用名」不放值**：`z.string().role('credential-ref')`
   （`dsh-web-search-switch/lib/index.js:309-313` 的写法），值存 `ctx.credentials.set(ref, value)`；
2. 管理页**永不回显**密钥；列表用 `credentials.describe(refs)` 只报「已配置/未配置/是否可写」
   （客户端用法见 `dsh-web-search-switch/lib/client.js:363,417`）；
3. 把值往网络/日志送之前一律打马赛克；`ctx.logger` 里不要打印 `env`、`packageManager.env`、
   `authorization` 头；
4. 自己的 HTTP 路由必须调 `ctx.connection.requestRejection(req)`（第 2.3 节），
   否则任何能访问该端口的页面都能读写 profile；
5. 不要把 `.credentials.yaml` 路径塞进返回体或 tool 输入——凭据文件的「保护」是**不给路径**，
   不是权限边界（同 README `:115`）。

---

## 9. 可直接复制的最小骨架

四个文件 + 一条安装命令。已在本机用桩服务跑通（`.recon/skeleton/smoke.mjs`、`smoke2.mjs`）：
`node --check` 通过，`GET /state` 真读文件、`GET /` 出页面、401/404/405/501 分支符合预期、
`settings.update` 与 `installBundle` 的调用参数经桩验证。

> 与宿主版本吻合性：`peerDependencies` 用 `^0.2.1-rc.5`，在 `includePrerelease: true` 下匹配本机
> `0.2.1-rc.5`（第 1.4 节）。若宿主升级到 0.2.x 新版，这些范围仍然成立；升到 0.3 需改。

### 9.1 `package.json`

```json
{
  "name": "dsh-config-sync",
  "version": "0.1.0",
  "private": true,
  "description": "Sync this DSH profile's files (package.json / cordis.patch.yml / pnpm-lock.yaml) from a management page inside the host.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "docs", "README.md"],
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/dsh-atomic-write": "^0.2.1-rc.5",
    "@deepseek-ai/dsh-host-webserver": "^0.2.1-rc.5",
    "@deepseek-ai/dsh-plugin-manager": "^0.2.1-rc.5",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "engines": { "node": ">=22" }
}
```

### 9.2 `cordis.patch.yml`

```yaml
# dsh-config-sync — bundle patch: mounts this package's own Loader row.
#
# A bundle contributes nothing but the rows its patch inserts, so this file is
# what actually puts `dsh-config-sync` into the profile tree. The `config` here
# is the DEFAULT layer; the user's own <profile>/cordis.patch.yml row with the
# same id replaces this whole config object (DSH patches are not deep-merged).
- insert:
    - id: config-sync
      name: dsh-config-sync
      config:
        enabled: true
        allowPnpmApply: false
```

### 9.3 `lib/index.js`（服务端：路由 + 管理页 + 读 profile + 写配置 + 装包）

```js
/**
 * dsh-config-sync — host half.
 *
 * Verified against DSH 0.2.1-rc.5 (Desktop) — see docs/plugin-api-notes.md.
 *
 * @module dsh-config-sync
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Loader row name; keep it equal to package.json#name. */
export const name = 'config-sync'

/** Wait for the host HTTP carrier before registering routes. */
export const inject = ['webServer']

/** The Loader row id this package owns — also the settings namespace in the patch. */
const ROW_ID = 'config-sync'

/** URL prefix owned by this plugin. */
const PREFIX = '/dsh-config-sync'

/** Profile files this plugin reports on. pnpm-lock.yaml is read-only: only pnpm writes it. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']

/**
 * Plugin configuration. Only `.volatile()` fields reach the Settings forms and
 * hot-apply in place (the loader commits volatile values without a remount).
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** Gate for the pnpm endpoint; keep false until the user opts in. */
  allowPnpmApply: z.boolean().default(false).volatile(),
})

/* ------------------------------------------------------------------ helpers */

/** Write one JSON answer. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Read a JSON request body with a hard size cap. */
async function readJsonBody(request, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * Apply the host's own request gate (Host/Origin fence + browser session) to a
 * route this plugin registered on the bare webServer. Routes registered there
 * never pass through the host's `/api` fence, so a mutating route must check it
 * itself.
 * @returns true when the request was refused and already answered.
 */
function refuseUnadmitted(ctx, request, response) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  let status
  try {
    status = connection.requestRejection(request)
  } catch {
    status = 403
  }
  if (status === undefined) return false
  sendJson(response, status, {
    error: status === 401
      ? 'DSH login required: reopen the URL "dsh web" printed at startup / 需要先登录'
      : 'refused: untrusted origin / 请求来自不受信任的地址',
  })
  return true
}

/** The launcher-published profile facts; absent outside a profile launch. */
function profileOf(ctx) {
  const profile = ctx.get('profileContext')
  if (profile === undefined) {
    throw new Error('dsh-config-sync: profileContext is unavailable — this host was not launched from a dsh profile')
  }
  return profile
}

/** Read one live plugin config value; volatile fields arrive as references. */
function configValue(runtime, field) {
  const raw = runtime.config?.[field]
  return typeof raw?.get === 'function' ? raw.get() : raw
}

/** Stable, cheap content fingerprint for change detection (not a security hash). */
function fingerprint(text) {
  let value = 0
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0
  return (value >>> 0).toString(16).padStart(8, '0')
}

/** Read the profile files this plugin reports on. */
async function readProfileSnapshot(runtime) {
  const profile = profileOf(runtime.ctx)
  const manifest = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'))
  const patchText = await readFile(profile.patchPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]\n'
    throw error
  })
  const files = {}
  for (const file of PROFILE_FILES) {
    const text = await readFile(join(profile.dir, file), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    files[file] = text === undefined
      ? { present: false }
      : { present: true, bytes: Buffer.byteLength(text), fingerprint: fingerprint(text) }
  }
  return {
    profile: {
      name: profile.name,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: profile.installAnchor,
      startedBundles: profile.startedBundles,
    },
    files,
    dependencies: manifest.dependencies ?? {},
    bundleSelection: manifest.dsh?.profile?.bundles ?? [],
    patchRowIds: [...patchText.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gmu)].map((match) => match[1]),
    config: {
      enabled: configValue(runtime, 'enabled'),
      allowPnpmApply: configValue(runtime, 'allowPnpmApply'),
    },
  }
}

/* ----------------------------------------------------------------- handlers */

/** GET /dsh-config-sync/api/state */
async function handleState(runtime, request, response) {
  if (refuseUnadmitted(runtime.ctx, request, response)) return
  sendJson(response, 200, await readProfileSnapshot(runtime))
}

/**
 * POST /dsh-config-sync/api/settings { field, value }
 * Persists through the host Settings service, which rewrites this plugin's row
 * in the profile's cordis.patch.yml (revision-checked, atomic, HMR-applied).
 */
async function handleSettings(runtime, request, response) {
  const ctx = runtime.ctx
  if (refuseUnadmitted(ctx, request, response)) return
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.update !== 'function') {
    sendJson(response, 501, { error: 'the settings service is not available in this composition' })
    return
  }
  const body = await readJsonBody(request)
  const field = body.field
  if (field !== 'enabled' && field !== 'allowPnpmApply') {
    sendJson(response, 400, { error: 'unknown field' })
    return
  }
  const form = settings.describe().find((entry) => entry.ns === ROW_ID)
  if (form === undefined) {
    sendJson(response, 409, { error: 'this plugin exposes no editable form — are the fields volatile?' })
    return
  }
  await settings.update(ROW_ID, { [field]: body.value === true }, form.revision)
  sendJson(response, 200, { ok: true })
}

/**
 * POST /dsh-config-sync/api/install { spec }
 * Adds one dependency and selects it as a bundle through the host's own plugin
 * manager: same pnpm implementation as `dsh plugin`, profile write lock,
 * package.json + pnpm-lock.yaml snapshot/restore, HMR-based activation (or a
 * restart-required report).
 */
async function handleInstall(runtime, request, response) {
  if (refuseUnadmitted(runtime.ctx, request, response)) return
  const manager = runtime.ctx.get('pluginManager')
  if (manager === undefined || typeof manager.installBundle !== 'function') {
    sendJson(response, 501, { error: 'the pluginManager service is not available in this composition' })
    return
  }
  const body = await readJsonBody(request)
  if (typeof body.spec !== 'string' || body.spec.trim() === '') {
    sendJson(response, 400, { error: 'spec must be a non-empty pnpm spec' })
    return
  }
  const result = await manager.installBundle(body.spec.trim(), { activate: body.activate !== false })
  sendJson(response, 200, { ok: true, result })
}

/** GET /dsh-config-sync/ — the management page (plain HTML, no build step). */
function handlePage(runtime, request, response) {
  if (refuseUnadmitted(runtime.ctx, request, response)) return
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 配置同步</title>
<style>
 body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#111418;color:#e6e6e6}
 h1{font-size:18px;margin:0 0 16px}
 table{border-collapse:collapse;width:100%;margin:8px 0 20px}
 td,th{border-bottom:1px solid #262b33;padding:6px 8px;text-align:left}
 button{background:#2a6df5;border:0;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer}
 pre{background:#1d2127;padding:12px;border-radius:8px;overflow:auto;max-height:320px}
 .muted{color:#8b949e}
</style></head>
<body>
<h1>DSH 配置同步</h1>
<p class="muted" id="who">读取中…</p>
<table id="files"></table>
<p><button id="refresh">刷新</button> <button id="toggle">切换 enabled</button></p>
<pre id="raw" class="muted"></pre>
<script>
const api = '/dsh-config-sync/api'
const state = async () => (await fetch(api + '/state')).json()
const report = (error) => { document.getElementById('raw').textContent = String(error) }
const render = (data) => {
  document.getElementById('who').textContent =
    data.profile.name + ' → ' + data.profile.dir + '（' + data.profile.startedBundles.length + ' 个 bundle 层）'
  document.getElementById('files').innerHTML = Object.entries(data.files).map(([name, info]) =>
    '<tr><th>' + name + '</th><td>' + (info.present ? info.bytes + ' B · ' + info.fingerprint : '不存在') + '</td></tr>').join('')
  document.getElementById('toggle').textContent = '切换 enabled（当前 ' + String(data.config.enabled) + '）'
  document.getElementById('raw').textContent = JSON.stringify(data.dependencies, null, 2)
}
const reload = () => state().then(render).catch(report)
document.getElementById('refresh').onclick = reload
document.getElementById('toggle').onclick = async () => {
  const data = await state()
  const response = await fetch(api + '/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field: 'enabled', value: !data.config.enabled })
  })
  if (!response.ok) report(new Error(await response.text()))
  else reload()
}
reload()
</script>
</body></html>`
  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

/** One dispatcher behind the registered prefix route. */
async function dispatch(runtime, request, response) {
  const ctx = runtime.ctx
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const method = request.method ?? 'GET'
  try {
    if (pathname === PREFIX || pathname === `${PREFIX}/`) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(response, 405, { allow: 'GET' })
      return handlePage(runtime, request, response)
    }
    if (pathname === `${PREFIX}/api/state`) {
      if (method !== 'GET') return sendJson(response, 405, { allow: 'GET' })
      return await handleState(runtime, request, response)
    }
    if (pathname === `${PREFIX}/api/settings`) {
      if (method !== 'POST') return sendJson(response, 405, { allow: 'POST' })
      return await handleSettings(runtime, request, response)
    }
    if (pathname === `${PREFIX}/api/install`) {
      if (method !== 'POST') return sendJson(response, 405, { allow: 'POST' })
      return await handleInstall(runtime, request, response)
    }
    sendJson(response, 404, { error: 'no such endpoint' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(error instanceof Error ? error : new Error(message))
    if (response.headersSent) {
      response.destroy()
      return
    }
    sendJson(response, 500, { error: message })
  }
}

/* -------------------------------------------------------------------- apply */

/**
 * Mount the plugin.
 * @param ctx - the profile scope this row runs in.
 * @param config - resolved config; volatile fields arrive as references.
 */
export function apply(ctx, config) {
  const runtime = { ctx, config }

  // Registering inside an effect ties the routes to this plugin's lifetime: HMR
  // disposal removes them before the module is replaced (a second registration
  // of the same path would otherwise throw and fail the reload).
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (request, response) => dispatch(runtime, request, response),
    })
    return () => dispose()
  }, 'config-sync: http routes')

  ctx.logger?.info?.(`dsh-config-sync: routes mounted at ${PREFIX}`)
}

export default { name, inject, Config, apply }
```

### 9.4 `lib/client.js`（可选：设置 → 内置插件 里的一个 tab，手写无构建）

```js
/**
 * dsh-config-sync — browser half (hand-written, no build step).
 *
 * The shell's module loader records this factory during boot and materializes
 * it on first use. Only `react` is required from the platform seed table.
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
    /** Same id as the host half's Loader row and settings namespace. */
    const ENTRY_ID = 'config-sync'
    /** Base path of the host half's HTTP routes. */
    const API = '/dsh-config-sync/api'

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 12 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: { padding: '4px 12px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      muted: { opacity: 0.7, fontSize: 12, margin: 0 },
      pre: { background: 'rgba(127,127,127,.12)', padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: 260, fontSize: 12, margin: 0 },
      error: { color: '#e5534b', fontSize: 12, margin: 0 },
    }

    /** Read the host half's state endpoint (same-origin, cookie travels along). */
    async function fetchState() {
      const response = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
      return response.json()
    }

    /** Toggle one volatile field through the host Settings service. */
    async function writeField(field, value) {
      const response = await fetch(`${API}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field, value }),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
      return response.json()
    }

    /** The tab body: profile facts plus the two write buttons. */
    function ConfigSyncPanel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(() => {
        setBusy(true)
        fetchState()
          .then((next) => {
            setState(next)
            setError(null)
          })
          .catch((failure) => setError(String(failure)))
          .finally(() => setBusy(false))
      }, [])

      React.useEffect(() => {
        reload()
      }, [reload])

      const toggle = () => {
        if (state === null) return
        setBusy(true)
        writeField('enabled', !state.config.enabled)
          .then(reload)
          .catch((failure) => {
            setError(String(failure))
            setBusy(false)
          })
      }

      if (state === null) {
        return h('div', { style: styles.root },
          h('p', { style: styles.muted }, error ?? (busy ? '读取中…' : '无数据')))
      }

      const files = Object.entries(state.files).map(([file, info]) =>
        h('div', { key: file, style: styles.row },
          h('strong', null, file),
          h('span', { style: styles.muted }, info.present ? `${info.bytes} B · ${info.fingerprint}` : '不存在')))

      return h('div', { style: styles.root },
        h('p', { style: styles.muted }, `profile ${state.profile.name} → ${state.profile.dir}`),
        h('p', { style: styles.muted }, `bundle 层 ${state.profile.startedBundles.length} 个 · patch 行 ${state.patchRowIds.length} 个 · 依赖 ${Object.keys(state.dependencies).length} 个`),
        files,
        h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: toggle },
            `enabled: ${String(state.config.enabled)}`),
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: reload }, '刷新')),
        h('pre', { style: styles.pre }, JSON.stringify(state.dependencies, null, 2)),
        error === null ? null : h('p', { style: styles.error }, error))
    }

    /** Services this browser plugin waits for (client-side Cordis services). */
    const inject = ['slots', 'locale']

    /**
     * Mount the settings tab.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: ENTRY_ID,
        order: 60,
        label: () => '配置同步',
        locale: NS,
      }, () => h(ConfigSyncPanel, null))), 'config-sync: settings tab')
    }

    exports.apply = apply
    exports.inject = inject
    exports.ConfigSyncPanel = ConfigSyncPanel
    return module.exports
  },
})
```

### 9.5 装进 desktop profile（**本次未执行**，仅记录步骤）

在 App 完全退出后，用桌面自带 CLI carrier 或（App 内）`ctx.pluginManager`：

```powershell
# 1) 依赖（link: + 绝对路径；相对路径会被 parseInstallSpec 拒绝）
cd C:\Users\kang\.dsh\profiles\desktop
pnpm add link:D:/AI/chajian/dsh-config-sync

# 2) 把包名加入 profile 清单的 bundle 列表（顺序敏感）
#    <profile>/package.json → dsh.profile.bundles 末尾加 "dsh-config-sync"

# 3) 重启 DeepSeek Harness（桌面端只能人工重启，见第 7 节）
```

或者让宿主自己做（等价、且有回滚）：`ctx.pluginManager.installBundle('link:D:/AI/chajian/dsh-config-sync')`
——它会写 `dependencies`、把包名加进 `dsh.profile.bundles`、跑 pnpm、并通过 HMR 激活
（第 6.2 节）。

装好后验证：

1. `http://127.0.0.1:<port>/dsh-config-sync/` 能出管理页（端口见 `ctx.webServer.port`，桌面端随机）；
2. `GET /dsh-config-sync/api/state` 返回真实 profile 路径与三个文件指纹；
3. Settings → 内置插件 出现「配置同步」tab；
4. `POST /api/settings` 后，`<profile>/cordis.patch.yml` 出现
   `- id: config-sync` + `config.enabled`，且页面无需刷新即生效（volatile 热更）。

---

## 10. 待验证清单（写代码前请先确认）

1. **`ctx.logger` 的调用形态**：宿主里既有 `ctx.logger.warn(err)`（`dsh-host-webserver/lib/index.js:398`）
   也有 `ctx.logger('name').warn(...)`（`dsh-desktop-host/lib/index.js:203`）。骨架用可选链 + 单参数，
   但如果要按命名空间用日志，需要确认 `ctx.logger` 在插件作用域下的确切类型。
2. **`slots.register` 的 spec 字段全集**：`label` 用函数是实测形态（`dsh-web-search-switch/lib/client.js:697`），
   `inject` 透传语义未在文档中定义（样例里既传 `inject: face` 又手动展开 `...face()`）。
3. **`@deepseek-ai/dsh-client-ui-renderer`（`slots` 服务提供者）是否要写进 `dsh.client.inject`**：
   样例 `dsh-web-search-switch` 没写却能工作（依赖模块图顺序），但若 tab 不出现，第一件事就是把它加进去。
4. **`settings.describe()` 不传 `redactSecrets` 时的可见范围**：文档说该选项是给 remote 调用者的
   （`dsh-settings/lib/index.js:410-413`），但本插件只取自己 namespace 的字段，不转发，应该安全；
   若将来转发整份 describe，必须传 `{ redactSecrets: true }`。
5. **`installBundle` 返回对象的确切公开字段**：README 只说「包含最后尝试的阶段、目标、保存状态变化、
   应用状态与错误码」（`dsh-plugin-manager/README.md:104`），具体键名请以运行时实测为准，不要写死类型。
6. **桌面端是否注入 pnpm store 相关环境变量**（`storeDir`/`PNPM_HOME`）：`dsh-desktop-host/lib/index.js:241-249`
   与 `lib/cli.js:96-107` 里没有；如果企业内网需要独立 store，要自己通过 `packageManager.env` 追加并
   确认 pnpm 会读。
7. **`resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion` 是 `0.2.1-rc.3`**，而
   `app.asar` 内 `dsh/package.json` 是 `0.2.1-rc.5`：payload 与 app 版本可以不同步。
   写版本判断时以 `@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion()`（运行时真实版本）为准，
   不要读 runtime.json。
8. **`profileContext.packageManager` 在非桌面安装下是否存在**：`runProfile` 的形参里有可选的
   `packageManager`（`@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:292`），普通 `dsh web` 没传，
   所以插件必须对「没有这个字段」做回落（PATH 上的 pnpm）。
9. **`slots` 的 `settings.plugins.tab` 是否只在 `ui-settings-plugins` 行存在时可见**：本机 profile
   确实有该行（`@deepseek-ai/dsh-web-app/cordis.patch.yml:437-438`），但第三方 profile 可能没有 ——
   用 `ctx.slots.inject(...)`（骨架已用）即可优雅降级。
10. **客户端 bundle 的 `mtimeMs` 版本策略**：改动后 HMR 会换掉浏览器端模块（`dsh-client-modules/README.md:78`），
    但页面里已 materialize 的旧实例不会热替换，交互复杂时建议提示用户刷新页面（待实测确认）。

---

## 11. 侦察产物与复现命令

```powershell
# 列 asar 内容（18234 个文件）
node D:\AI\chajian\dsh-config-sync\.recon\asar.mjs list "dsh/node_modules/@deepseek-ai/dsh-host-webserver/"

# 按需提取（前缀, 输出目录, 正则）
node D:\AI\chajian\dsh-config-sync\.recon\extract-subset.mjs "dsh/node_modules/@deepseek-ai/" out ".*\.js$"

# 骨架自测（用桩服务驱动路由，不需要宿主）
cd D:\AI\chajian\dsh-config-sync\.recon\skeleton
node --check lib/index.js; node --check lib/client.js
node smoke.mjs      # GET /state、GET /、401/404 分支
node smoke2.mjs     # POST /settings、POST /install 的参数
```

关键路径速查：

| 内容 | 路径 |
|---|---|
| 服务名全表来源 | `.recon\hostlib\dsh\node_modules\@deepseek-ai\*\lib\index.js`（扫 `super(ctx, "…")`） |
| profileContext 定义 | `.recon\hostlib\dsh\node_modules\@deepseek-ai\dsh\lib\profile-boot-C14i-8IN.js:290-301` |
| 桌面宿主入口 | `.recon\desktop-host-index.js`（= `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`） |
| Electron 主子进程 | `.recon\main.js`（`DesktopHostProcess` 约 3740-3860 行） |
| 前端 seed 表 | `.recon\fe-index.js`（约偏移 917901，函数 `OZ()`） |
| bundle 层内容 | `.recon\base-patch.yml`、`.recon\webapp-patch.yml` |
