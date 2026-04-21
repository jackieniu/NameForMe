# Cloudflare 部署与限流绑定说明

## `wrangler.toml` 还要不要提交 GitHub？

1. **绝不能写进仓库、也不能写进 `wrangler.toml` 的**：Cloudflare **API Token**、大模型 **LLM_API_KEY**、Turnstile **Secret** 等一切**密钥**。这些走 Cloudflare **Environment variables** / `**wrangler secret put`**，或本机 `**.dev.vars`** / `**.env.local**`（已在 `.gitignore`）。
2. **KV 的 `id`、D1 的 `database_id` 是什么**：账号里某条资源的**标识符**，不是「谁拿到 id 就能冒充你调 API」的那种 key。官方社区里也常见在公开仓库里写这类 id；若仍不想在 GitHub 暴露账号资源 id，可以二选一：
  - **方案 A**：仓库里的 `wrangler.toml` **一直用占位** `REPLACE_WITH_*`；生产只在 **Pages → Settings → Functions → Bindings** 里绑定同名 `BLOCKLIST` / `DB`，真实 id **只存在于控制台**。
  - **方案 B**：本机复制一份 `**wrangler.local.toml`**（已在仓库 `.gitignore`，不会 push），把真实 id 只写在这个文件里；Wrangler 命令加 `**--config wrangler.local.toml`**。
3. **结论**：当前这种**仅占位 id、不含任何 Token** 的 `wrangler.toml` **适合继续提交**；敏感配置用 Secrets / 环境变量，与是否提交 `wrangler.toml` 是两件事。

---

## 插件 ≠ 免 Git、≠ 自动开资源

- **Cursor 里的 Cloudflare 插件**：帮你查文档、写/审 Wrangler 配置、在本地跑 `wrangler` 命令更顺手；**不会**替你在 Cloudflare 账号下创建 KV / D1，也**不会**把代码自动推上生产。
- **和 GitHub 的关系**：二选一或组合使用均可。
  - **Git 集成**：Cloudflare Dashboard → Pages → 连接本仓库，每次 push 构建部署（常见 CI 流程）。
  - **纯本地**：`wrangler login` 后，用 `wrangler pages deploy`（或你选用的 Next 适配器提供的命令）从本机上传构建产物；**不必**先推到 GitHub，但团队协同时仍建议用 Git 做版本管理。

将 **Next.js 15 全栈应用** 部署到 Cloudflare Pages，通常还需要选用 **OpenNext for Cloudflare** 等适配方案以生成 Workers 兼容产物；本仓库根目录的 `wrangler.toml` 主要描述 **Pages Functions / Worker 侧需要的 KV + D1 绑定名**，与是否用 Git 连接无冲突。

---

## 应用依赖的 Cloudflare 资源（限流持久化）

代码见 `src/lib/rate-storage/cloudflare.ts`：仅在运行时能拿到以下**同名绑定**时，才会启用跨实例一致的 KV + D1 限流；否则回退内存（见 `getRateStorage()`）。


| 绑定名（必须一致）   | 类型           | 用途                                 |
| ----------- | ------------ | ---------------------------------- |
| `BLOCKLIST` | KV Namespace | IP 短期黑名单键 `bl:<ip>`                |
| `DB`        | D1 Database  | 表 `rate_counters`（全站 / IP 小时与全天计数） |


**不要求**把 KV/D1 的 ID 写进 `.env`；生产上在 **Cloudflare Pages 项目 → Settings → Functions → Bindings** 里绑定即可。本地用 `wrangler dev` / `wrangler pages dev` 时，则依赖仓库根目录 `wrangler.toml` 里的 `[[kv_namespaces]]` / `[[d1_databases]]`。

---

## 一次性：创建资源并填写 ID（`wrangler.toml` 或 `wrangler.local.toml`）

在已安装 Node 的机器上（本仓库根目录即应用根目录）。**先安装依赖**（会把 `wrangler` 装进 `devDependencies`，避免 `npx wrangler` 指向空的 `node_modules`）：

```bash
npm install
npx wrangler login
```

### 1. KV（黑名单）

```bash
npx wrangler kv namespace create BLOCKLIST
```

输出中的 **id**（非 `preview_id`）复制到 `**wrangler.toml`**（可提交占位版）或 `**wrangler.local.toml`**（本机私有，见上文）：

```toml
[[kv_namespaces]]
binding = "BLOCKLIST"
id = "<粘贴此处>"
```

### 2. D1（计数）

```bash
npx wrangler d1 create nameforme_rate
```

把输出里的 **database_id** 复制到 `**wrangler.toml`** 或 `**wrangler.local.toml`**：

```toml
[[d1_databases]]
binding = "DB"
database_name = "nameforme_rate"
database_id = "<粘贴此处>"
migrations_dir = "migrations"
```

### 3. 远端建表

```bash
npx wrangler d1 migrations apply nameforme_rate --remote
```

（`migrations/0001_init.sql` 会创建 `rate_counters`。）

---

## Cloudflare Pages 控制台绑定（Git 或 CLI 部署后都要做）

若通过 **Dashboard 连接 Git** 部署，且未使用仓库内 `wrangler.toml` 自动同步绑定，请在 Pages 项目里手动添加：

1. **Functions** → **KV namespace bindings** → Variable name：`BLOCKLIST` → 选择上面创建的 KV。
2. **Functions** → **D1 database bindings** → Variable name：`DB` → 选择 `nameforme_rate`。

绑定名必须是 `BLOCKLIST` 和 `DB`（与代码探测一致）。

---

## 与 `.env` 的关系

- **Turnstile**（可选）：`NEXT_PUBLIC_TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` 仍放在 **环境变量**（Pages → Settings → Environment variables），见根目录 `.env.example`。
- **KV / D1**：由 **Bindings** 注入运行时 `env`，**不要**把 `database_id` 当密钥写进前端；`wrangler.toml` 中的 id 可提交仓库（团队共享），或仅放在 CI 机密里由流水线写入。

---

## 当前仓库里的占位

根目录 `wrangler.toml` 中为：

- `REPLACE_WITH_KV_NAMESPACE_ID` → 应替换为 KV `BLOCKLIST` 的 **id**
- `REPLACE_WITH_D1_DATABASE_ID` → 应替换为 D1 `nameforme_rate` 的 **database_id**

若采用 **方案 B**（不写真实 id 进 Git）：保留仓库内占位不变；在本机 `wrangler.local.toml` 写入完整真实配置，并用 `--config wrangler.local.toml` 执行 Wrangler。若采用 **方案 A**（仅控制台绑定）：占位可长期保留，部署后只在 Pages 控制台检查绑定名是否为 `BLOCKLIST` / `DB`。

---

## 故障排查

- 限流始终像单机：检查生产环境是否同时存在 `BLOCKLIST` 与 `DB` 绑定；`hasCloudflareRateLimitBindings()` 为 false 时会只用内存。
- D1 报错表不存在：确认已对**同一** `database_id` 执行过 `wrangler d1 migrations apply ... --remote`。
- 绑定名写错：必须是 `BLOCKLIST` / `DB`，大小写敏感。
- `**npm ci` / `Missing @swc/helpers@0.5.21 from lock file`**：常见有两个诱因，通常叠加出现：
  1. **本地 npm 版本与 Cloudflare 不一致**：Cloudflare Pages 构建环境常用 **npm 10.9.x**，而 npm **11.x** 生成的 `package-lock.json` 可能与 `npm ci` 严格校验不兼容。**请勿**在 `package.json` 里写 `engines.npm` 为**范围**（如 `>=10 <11`）：Pages 会把整段字符串当成「工具版本名」解析，导致 **Installing tools** 阶段直接失败。本地生成 lock 时请用 **`npx npm@10.9.2 install`**（见下文命令）。
  2. `**overrides` 在 npm 10 下的行为差异**：早期我们用 `overrides` 强制 `@swc/helpers@0.5.21`，导致 lock 校验出现「需要却找不到」的误报。当前方案已**移除 `overrides` 和根 `dependencies["@swc/helpers"]`**，由 `next@15.2.4` 自带的 **0.5.15** 接管；`next-intl` 的 `@swc/core` 是 **optional peer**，不会导致安装失败。
  在 **Windows / 本地开发机**上，请按下面命令重建 lock 后再提交：
  ```powershell
  Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
  npx --yes npm@10.9.2 install
  Remove-Item -Recurse -Force node_modules
  npx --yes npm@10.9.2 ci    # 冒烟，复现 Cloudflare 的校验
  ```
- **清 Cloudflare 构建缓存**：若仍有「Missing … from lock file」，进入 Pages 项目 **Settings → Builds → Clear build cache**，再触发 Retry deployment，避免缓存里旧 lock/`node_modules` 造成的残留。
- `**npm ci` / 其他 `Missing … from lock file`（Linux）**：同上，**必须用 npm 10.x** 生成 lock；也可以跑 `**npm run lock:sync`** 刷新 lock，再 `git add package-lock.json`。

