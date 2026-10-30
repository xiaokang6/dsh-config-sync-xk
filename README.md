# @xiaokang6/dsh-config-sync

把一台 DSH（DeepSeek Harness）的**配置**同步到多台设备：坚果云 WebDAV 或 GitHub，
逐文件内容哈希判断变更，冲突时两份都保留，可选口令加密，全部操作在设置页完成。

> 只同步「配置」，不同步会话、附件和 `node_modules`；插件永远不直接改
> `node_modules`，改完 `package.json` 只会执行 `pnpm install` 并提示重启。

## 同步什么

默认 scope（可在设置里改）：

| 文件 | 内容 |
| --- | --- |
| `package.json` | 插件依赖 + `dsh.profile.bundles` |
| `cordis.patch.yml` | 你的补丁层（模型 provider、MCP、开关） |
| `cordis.yml` | profile 根入口（通常是 `[]`） |
| `pnpm-lock.yaml` | 插件版本锁定 |

**不同步**：`node_modules/`、`.dsh-market/snapshots/`、会话、附件、`.credentials.yaml`、`.env`。
注意 `cordis.patch.yml` 里可能本来就写着 MCP/模型的明文密钥 —— 这正是提供口令加密的原因（见下）。

## 安装

### 开发机：`link:` 到本仓库（改代码即生效）

```powershell
cd D:\AI\chajian\dsh-config-sync

# 1) 写 profile 清单（自动备份原文件），link: 到本仓库
node scripts/install.mjs

# 2) 安装依赖（只需一次；之后插件改动用 link: 直接生效）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install

# 3) 让宿主重新加载插件
#    - 重启 DeepSeek Harness，或
#    - 点窗口右上角的刷新按钮换掉宿主侧插件代码
```

### 其他机器：`github:` 快照（不需要克隆，也不依赖路径）

```powershell
# 推荐：宿主自带的插件管理，会同时把 @xiaokang6/dsh-config-sync 加进 dsh.profile.bundles
dsh plugin --profile desktop add github:xiaokang6/dsh-config-sync-xk

# 没有 dsh 命令时用 pnpm —— 但必须自己把 bundle 行补上，否则插件不会挂载
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:xiaokang6/dsh-config-sync-xk
# 然后把 "@xiaokang6/dsh-config-sync" 加进 package.json 的 dsh.profile.bundles
```

多机同步时**推荐这个写法**：`link:` 写的是本机绝对路径，会跟着 `package.json` 一起同步到别的
机器，路径不同那台就装不起来；`github:` 只有仓库名，任何机器都成立，`@deepseek-ai/*` peer
依赖也能从 profile 正常解析（不需要额外链接）。装完重启 App 或点刷新按钮。

**换新机器的顺序**（插件没法把自己装到一台空机器上，所以先装再同步）：

1. 装**同一版本**的 DSH（profile 的 bundles 里有 `@deepseek-ai/dsh-experimental-*` 这类随发行版
   附带的层，DSH 版本不同会解析不到，开机就会失败）；
2. 用上面那条命令装插件（`dsh plugin … add`），重启 App；
3. 打开 **设置 → 内置插件 → 配置同步**，填同一个远端 + 同一个口令；
4. 「双向同步」——新机器没有合并基线，会自动采用远端配置，本机旧版本另存为 `.local-*` 备份；
   拉到 `package.json` / `pnpm-lock.yaml` 变化时插件会自己跑 `pnpm install`。

有三样东西**不会**跟着同步，每台机器各自准备：

| 不同步的 | 为什么 |
| --- | --- |
| `~/.dsh/config-sync/remote.json`（WebDAV/GitHub 凭据、加密口令） | 本机机密，写进同步文件等于泄露 |
| `~/.dsh/.credentials.yaml`、`.env` | 同上；`cordis.patch.yml` 里的 `{{SECRET_…}}` 占位符要在新机器的凭据库里能解析，否则那个 MCP/模型条目会失效 |
| `node_modules/`、会话、附件 | 由 `pnpm install` 重建 / 本来就不该同步 |

装好后打开 **设置 → 内置插件 → 配置同步**。

## 更新

### 面板里点两下（任何机器都行，不需要克隆）

**设置 → 内置插件 → 配置同步 → 「插件升级」卡片**：

- **检查更新**：读 profile 里的依赖写法（`github:` / `link:` / registry），把锁文件里的提交与
  GitHub 上的分支头比一下，直接告你「已是最新」还是「有新版本」；
- **一键升级**：`github:` 安装在 profile 里跑 `pnpm update @xiaokang6/dsh-config-sync`，`link:` 安装对那份
  检出做 fast-forward（有未提交改动会拒绝、不动你的工作区）；做完提示你点刷新按钮。

「检查更新」的取数顺序和插件市场同一套思路——**先走 HTTPS，最后才碰 `git`**：

1. `https://github.com/<owner>/<repo>/info/refs?service=git-upload-pack`（`git ls-remote` 读的
   就是这份 advertisement，没有 API 限流），先校验 `# service=git-upload-pack` 与 40 位 ref 行；
2. 失败再退到 `https://api.github.com/repos/<owner>/<repo>/commits/<ref>`；
3. 都不行才 `git ls-remote`（需要 PATH 里有 git、且 git 自己的 `http.proxy` 配好）。

所以宿主 PATH 里没有 git、或 git 没配代理，都不影响检查。走代理时用 undici 的
`EnvHttpProxyAgent`（Node 全局 `fetch` 不读 `HTTP_PROXY`/`HTTPS_PROXY`），代理变量写进
`~/.dsh/.env` 即可生效。另外**读不到 pin 不当成「有新版本」**：锁文件里的提交解析不出来时面板
只说「未知」，详情里带上每一条失败原因（`info/refs: …; api: …; git: …`），不会瞎报。

两种情况都以「重载宿主」收尾：点一下窗口右上角的刷新按钮（或重启 App），宿主里缓存的 ESM
模块才会换掉——这条没法自动化，插件自己也重启不了宿主。

### 命令行 / 双击

```powershell
cd D:\AI\chajian\dsh-config-sync
npm run update          # 等价于双击仓库根目录的 update.cmd
npm run update:check    # 只看有没有新版本，什么都不改
```

脚本与面板按钮走同一套判断：`link:` 就拉本仓库（本地未提交改动先 stash、更新后还原，只有
`package.json` / `pnpm-lock.yaml` 变了才跑 `pnpm install`，并补上 `link:` 导入需要的
`@deepseek-ai/*` peer 链接）；`github:` 就 `pnpm update @xiaokang6/dsh-config-sync` 并报告新 pin。

没有克隆的机器想从命令行升级，直接在 profile 里跑：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm update @xiaokang6/dsh-config-sync
```


## 配置远端

### 坚果云 WebDAV（推荐）

1. 坚果云网页 → 账户信息 → 安全选项 → **添加应用密码**（不要用登录密码）。
2. 设置页填：
   - Base URL：`https://dav.jianguoyun.com/dav/`
   - 用户名：坚果云账号邮箱
   - 应用密码：上一步生成的那串
   - 远端路径：`dsh-config-sync/desktop`（多台设备要用同一个）
3. 「检测差异」→「双向同步」。

### GitHub

1. 建一个私有仓库；生成 **fine-grained PAT**，权限只需
   `Contents: Read and write`（或 classic token 的 `repo` 权限）。
2. 设置页填 owner / repo / branch（默认 `main`）/ 远端路径 / Token。

凭据只保存在本机 `~/.dsh/config-sync/remote.json`（0600），**不会**写进
`cordis.patch.yml`，因此不会跟着同步走；每台设备各自填一次。

## 冲突与方向

- 逐文件比较内容哈希，用「上次同步成功的哈希」当合并基：
  - 只有本机改 → 上传；只有远端改 → 下载；两边改的一样 → 跳过。
  - 两边都改且不同 → **冲突**：本机文件原样保留，远端版本另存为
    `<文件名>.remote-<设备名>-<时间戳>`，设置页里可以「采用远端 / 采用本地」。
  - **新设备第一次同步**：没有合并基，`双向` 时自动采用远端，同时把本机旧版本
    另存为 `<文件名>.local-<设备名>-<时间戳>`（什么都不丢）；只想上传本机配置就用「上传」。
- 方向支持「上传 / 下载 / 双向」；只上传或只下载时，另一方向的变更会被标为 skipped。
- 删除不传播：一边没有的文件不会被另一边删掉，只会在结果里说明。

## 启动时自动同步

默认**每次打开 DSH 都会自动同步一次**：插件启动约 15 秒后执行一次 `sync`（方向跟随面板里的选择）。
拉取到变更时照旧只提示重启、不自动重启；远端没配好、或加密开了但没有口令时自动跳过。

- 面板「远端设置」里的「启动时自动同步」开关可随时关闭（保存在本机 `remote.json`）。
- 想改延迟或改默认值，在 profile 的 `cordis.patch.yml` 里按行 id `config-sync` 覆盖：
  ```yaml
  - id: config-sync
    config: { autoSyncOnStart: true, autoSyncDelayMs: 15000 }   # 0–300000 ms
  ```
- 跳过条件：远端未配置/不完整、加密已开但本机没有口令、同一宿主进程里已经安排过一次（插件被热重挂时不会重复同步）。

## 加密（可选）

打开「加密」并设置口令后，每个文件在远端都以 AES-256-GCM 信封保存
（scrypt 派生密钥、每文件独立 salt/iv/tag）。manifest 只存**明文哈希**，
所以计划阶段不需要口令；跨设备请使用同一个口令。

## 安全设计（为什么它不会再把插件搞没）

1. 同步前把要改的文件备份到 `~/.dsh/config-sync/backups/<时间>-<操作>/`，
   设置页可一键恢复。
2. 写入是「临时文件 + rename」原子替换，UTF-8 无 BOM。
3. 永远不会直接动 `node_modules`；拉取到 `package.json`/`pnpm-lock.yaml` 后
   只执行 `pnpm install`（优先用宿主自带的包管理器），然后提示重启。
4. **空依赖保护**：如果远端 `package.json` 一个依赖都没有而本机有，默认
   拒绝覆盖（这是插件市场 restore 事故的形态）；确需覆盖可在设置里允许。
5. 路径校验：拒绝 `..`、绝对路径、`node_modules`/`.dsh-market`/`.git`。
6. 路由与市场同一套同源守卫：只接受本机 loopback / 宿主声明的 authority、
   拒绝 `sec-fetch-site: cross-site` 与跨源 Origin。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置页显示 404 | 宿主半没加载：确认 `package.json` 的 bundles 里有 `@xiaokang6/dsh-config-sync`，并触发一次热重组或重启 |
| `pnpm install` 失败 | 看结果里的输出尾部；在 profile 目录手动跑 `pnpm install`，或检查 `pnpm` 是否在 PATH |
| 远端数据已加密但本机没口令 | 打开加密并录入相同口令，再同步 |
| 拉取被拒（零依赖） | 确认远端 `package.json` 是否来自坏备份；必要时在设置里临时允许空依赖，或先修远端 |
| 冲突文件堆积 | 在设置页逐个「采用远端 / 采用本地」，处理后会删除 `.remote-*` 副本 |
| 拉取后 `pnpm install` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | 另一台设备装的包在宿主「新版本等待期」内（默认 24h），本机复现同一份 lockfile 时被策略拦下。新版会自动用 `minimumReleaseAge=0` 重试一次并在报告里标 `policyRelaxed: true`；也可以手动 `pnpm install --config.minimumReleaseAge=0` |
| 上传已有文件报 412 `ETag doesn't match` | 坚果云返回的 ETag 不带引号、且按字符串原文比较 `If-Match`；旧版给它补了 RFC 的引号，于是每个已存在的文件都写不进去。新版原样透传（`lib/sync/remotes/webdav.js` 的 `ifMatchValue`），更新后重启即好 |
| 同步到另一台机器后插件不见了 / `pnpm install` 报链接目标不存在 | `package.json` 里是 `link:D:/…` 这种本机绝对路径，跟着配置同步过去就失效。改用 `github:xiaokang6/dsh-config-sync-xk`（不带路径，多机通用）；`dsh-pentest-gate` 之类同样用 `link:` 的插件有同一问题 |
| 设置页保存时返回 401 / 请求被拒 | 旧版本守卫在桌面端也会调用宿主鉴权；新版已改为桌面端跳过（桌面代理自己负责鉴权），重启宿主后生效 |
| 改了代码但行为没变 | 宿主内 ESM 模块已缓存，热重组只重挂 fiber；**重启 DeepSeek Harness** 才会加载新的 `lib/` 代码 |

## 开发

```powershell
npm test                  # node --test：单元 + 适配器 mock + engine↔adapter 集成测试（138 个用例）
node scripts/install.mjs --dry-run
npm run update:check      # 有没有上游新版本
```

改了 `lib/`、`client/` 或 `package.json` 后需要**重启宿主**再验证：DSH 的 loader 热重组只重挂插件 fiber，已经 import 过的 ESM 模块不会重新执行。

结构：

```
lib/index.js              # 插件入口：Config、profile 解析、挂载路由
lib/routes.js             # /dsh-config-sync/* HTTP API
lib/http.js               # JSON 响应、同源守卫
lib/sync/engine.js        # 计划 → 应用 → 冲突 → 合并基
lib/sync/remotes/         # 坚果云 WebDAV / GitHub 适配器 + mock
client/client.js          # 设置页（手写 CJS，仅依赖 react）
docs/                     # 设计、HTTP API、远端契约
```

## License

MIT
