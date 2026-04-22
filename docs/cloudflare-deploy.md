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

本仓库使用官方 [**OpenNext for Cloudflare**](https://opennext.js.org/cloudflare)（`@opennextjs/cloudflare`）：`npm run cf:build` 会生成 **`.open-next/worker.js`** 与静态资源目录，再由 **`wrangler deploy`** 发布到 **Cloudflare Workers** 运行时。

---

## Pages 和 Workers 还要不要「两个一起用」？

对**这一个 Next 全栈项目**，你只需要 **一条部署线**，不必再单独建一个「Pages 项目 + Worker 项目」各管一半。

| 概念 | 说明 |
|------|------|
| **Workers** | Cloudflare 上跑 SSR / API 的**运行时**（`workerd`）。OpenNext 打出来的站点**就是**一个 Worker + 静态资源。 |
| **Pages（产品名）** | 常用来托管前端 + Functions；也可用 **Workers Builds + Git** 连同一仓库，本质仍是「构建后发布 Worker」。 |
| **密钥放哪** | **`LLM_API_KEY`**、**`TURNSTILE_SECRET_KEY`**、阿里云 Secret 等只放在 Cloudflare **Variables and secrets**（或 Build 用的 **Build variables and secrets**），**不要**加 `NEXT_PUBLIC_` 前缀。服务端 Route Handler 读 `process.env.*`，**不会**打进浏览器包；这与「单独再建一个 Worker 项目」无关。 |

结论：**不用**为了保密再叠一个 Workers；在**当前 Worker 项目**里配好环境变量即可。

---

## Workers Builds（Git 连接）：Build / Deploy 该怎么填

**Workers & Pages** → 你的项目 → **Build** → **Build configuration** → **Edit**：

| 项 | 填写内容 |
|----|----------|
| **Root directory** | 若 `package.json` 在子目录 **`code/`**，填 **`code`**；若在仓库根则 `/` 或留空。 |
| **Build command** | **`npm run cf:build`**（内部会执行 `next build` 并生成 `.open-next`）。 |
| **Deploy command** | **`npx wrangler deploy`**（读取仓库根 `wrangler.toml` 的 `main`、`[assets]`、KV、D1）。 |
| **Version command** | 若不需要 Workers Versions 流水线，可留空或与 Cloudflare 文档一致。 |

保存后重新部署；日志中应出现 **OpenNext build complete**，且 **`wrangler deploy`** 上传成功。此后 **Deployments / Version history** 会出现新版本。

本地等价：`npm run cf:deploy`（`cf:build` + `opennextjs-cloudflare deploy`）。

**说明**：日常开发仍用 **`npm run dev`**（Node 下 Next）；与线上完全一致可用 **`npm run cf:preview`**（较慢，见 OpenNext 文档）。

### 构建期环境变量（Workers Builds）

若 SSG 等步骤要在 **build** 时读取非 `NEXT_PUBLIC_*` 的变量，请在 Cloudflare **Build variables and secrets** 中配置（见 [OpenNext 环境变量说明](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)）。运行时密钥仍在 **Variables and secrets**。

---

## 应用依赖的 Cloudflare 资源（限流持久化）

代码见 `src/lib/rate-storage/cloudflare.ts`：仅在运行时能拿到以下**同名绑定**时，才会启用跨实例一致的 KV + D1 限流；否则回退内存（见 `getRateStorage()`）。


| 绑定名（必须一致）   | 类型           | 用途                                 |
| ----------- | ------------ | ---------------------------------- |
| `BLOCKLIST` | KV Namespace | IP 短期黑名单键 `bl:<ip>`                |
| `DB`        | D1 Database  | 表 `rate_counters`（全站 / IP 小时与全天计数） |


**不要求**把 KV/D1 的 ID 写进 `.env`；生产上在 **Worker 项目 → Settings → Bindings**（或 **Bindings** 标签）里绑定与 `wrangler.toml` **同名**的 `BLOCKLIST`、`DB` 即可（若控制台与 `wrangler.toml` 重复配置，以 Cloudflare 文档为准，避免冲突）。本地预览用 **`npm run cf:preview`** 或 `wrangler dev` 时，依赖仓库根目录 `wrangler.toml` 里的 `[[kv_namespaces]]` / `[[d1_databases]]`。

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

## 控制台绑定 KV + D1（Git 或 CLI 部署后都要做）

在 **Worker 项目**（或 Pages 项目，若你改用 Pages）里添加：

1. **KV namespace binding** → Variable name：**`BLOCKLIST`** → 选择已创建的 KV。
2. **D1 database binding** → Variable name：**`DB`** → 选择 D1 数据库（逻辑名可为 `nameforme_rate`）。

绑定名必须是 **`BLOCKLIST`** 和 **`DB`**（与 `src/lib/rate-storage/cloudflare.ts` 一致）。

---

## 与 `.env` 的关系

- **Turnstile**（可选）：`NEXT_PUBLIC_TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` 放在 **Variables and secrets**（及构建需要的 **Build variables and secrets**），见根目录 `.env.example`。
- **KV / D1**：由 **Bindings** 注入运行时 `env`；`wrangler.toml` 里的 `id` / `database_id` 是资源标识符，**不要**把 API Token 写进仓库。

---

## `wrangler.toml` 里的 id

仓库内可保留 **真实或占位** KV/D1 id；不想暴露资源 id 时，用 **`wrangler.local.toml`**（已 `.gitignore`）覆盖，Wrangler 命令加 **`--config wrangler.local.toml`**。控制台 **Bindings** 与 `wrangler.toml` 二选一或并用时，以 Cloudflare 当前文档为准。

---

## 故障排查

- 限流始终像单机：检查生产环境是否同时存在 `BLOCKLIST` 与 `DB` 绑定；`hasCloudflareRateLimitBindings()` 为 false 时会只用内存。
- D1 报错表不存在：确认已对**同一** `database_id` 执行过 `wrangler d1 migrations apply ... --remote`。
- 绑定名写错：必须是 `BLOCKLIST` / `DB`，大小写敏感。
- `**npm ci` / `Missing @swc/helpers@0.5.21 from lock file`**：常见有两个诱因，通常叠加出现：
  1. **本地 npm 版本与 Cloudflare 不一致**：Cloudflare Pages 构建环境常用 **npm 10.9.x**，而 npm **11.x** 生成的 `package-lock.json` 可能与 `npm ci` 严格校验不兼容。**请勿**在 `package.json` 里写 `engines.npm` 为**范围**（如 `>=10 <11`）：Pages 会把整段字符串当成「工具版本名」解析，导致 **Installing tools** 阶段直接失败。本地生成 lock 时请用 **`npx npm@10.9.2 install`**（见下文命令）。
  2. **锁文件与 npm 大版本**：本地若用 npm 11 生成 lock，Cloudflare（npm 10.9.x）`npm ci` 可能报不同步；本地刷新 lock 建议 **`npx npm@10.9.2 install`**。当前 Next 为 **15.5.x**（满足 OpenNext peer）。
  在 **Windows / 本地开发机**上，请按下面命令重建 lock 后再提交：
  ```powershell
  Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
  npx --yes npm@10.9.2 install
  Remove-Item -Recurse -Force node_modules
  npx --yes npm@10.9.2 ci    # 冒烟，复现 Cloudflare 的校验
  ```
- **清 Cloudflare 构建缓存**：若仍有「Missing … from lock file」，进入 Pages 项目 **Settings → Builds → Clear build cache**，再触发 Retry deployment，避免缓存里旧 lock/`node_modules` 造成的残留。
- **`Missing entry-point to Worker script`**：先执行 **`npm run cf:build`** 生成 `.open-next`，且 `wrangler.toml` 已含 `main` 与 `[assets]`；Deploy 使用 **`npx wrangler deploy`**。若未跑 OpenNext 仍执行 `wrangler deploy` 会报错。
- `**npm ci` / 其他 `Missing … from lock file`（Linux）**：同上，**必须用 npm 10.x** 生成 lock；也可以跑 `**npm run lock:sync`** 刷新 lock，再 `git add package-lock.json`。

