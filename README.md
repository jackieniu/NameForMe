# NameForMe（Next.js）

双语域名生成与检测 Web 应用。本目录即为 **Git 仓库根目录**（推送到 GitHub 时只包含本目录内容）。

- 环境变量说明：**[.env.example](./.env.example)**（大模型 `LLM_*`、域名检测、Turnstile、Cloudflare 等）

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local 后：
npm run dev
```

大模型使用 **OpenAI 兼容** API（`LLM_API_KEY` + 可选 `LLM_BASE_URL` / `LLM_MODEL`），默认 DeepSeek；可换其他兼容供应商。
