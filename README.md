# dsh-config-sync

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

```powershell
cd D:\AI\chajian\dsh-config-sync

# 1) 写 profile 清单（自动备份原文件），link: 到本仓库
node scripts/install.mjs

# 2) 安装依赖（只需一次；之后插件改动用 link: 直接生效）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install

# 3) 让宿主重新加载插件
#    - 重启 DeepSeek Harness，或
#    - 给 cordis.patch.yml 加一行注释触发 loader 热重组（推荐，见 docs/design.md）
```

装好后打开 **设置 → 内置插件 → 配置同步**。

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
| 设置页显示 404 | 宿主半没加载：确认 `package.json` 的 bundles 里有 `dsh-config-sync`，并触发一次热重组或重启 |
| `pnpm install` 失败 | 看结果里的输出尾部；在 profile 目录手动跑 `pnpm install`，或检查 `pnpm` 是否在 PATH |
| 远端数据已加密但本机没口令 | 打开加密并录入相同口令，再同步 |
| 拉取被拒（零依赖） | 确认远端 `package.json` 是否来自坏备份；必要时在设置里临时允许空依赖，或先修远端 |
| 冲突文件堆积 | 在设置页逐个「采用远端 / 采用本地」，处理后会删除 `.remote-*` 副本 |
| 设置页保存时返回 401 / 请求被拒 | 旧版本守卫在桌面端也会调用宿主鉴权；新版已改为桌面端跳过（桌面代理自己负责鉴权），重启宿主后生效 |
| 改了代码但行为没变 | 宿主内 ESM 模块已缓存，热重组只重挂 fiber；**重启 DeepSeek Harness** 才会加载新的 `lib/` 代码 |

## 开发

```powershell
npm test                  # node --test：单元 + 适配器 mock + engine↔adapter 集成测试（105 个用例）
node scripts/install.mjs --dry-run
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
