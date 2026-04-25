<p align="center">
  <img src="./public/logo.png" alt="NameForMe" width="96" />
</p>

<h1 align="center">NameForMe</h1>

<p align="center"><b>AI-powered bilingual domain discovery that understands your brand — and only shows names you can actually register.</b></p>

<p align="center">
  <a href="https://nameforme.com">Website</a> ·
  <a href="https://github.com/jackieniu/NameForMe">GitHub</a> ·
  <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?logo=react" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript" />
  <img alt="Tailwind" src="https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-22c55e" />
</p>

![NameForMe homepage](./public/homepage.png)

---

## Why NameForMe

Most AI domain generators share one frustrating pattern: **great-sounding names that are already taken**. We took a different path.

- **What you see is registrable** — every name we show has been checked in real time via Alibaba Cloud and/or Cloudflare Registrar availability APIs.
- **Conversational brand understanding** — multi-turn clarification on your product, market, tone, and exclusions; the model picks naming strategies instead of blind keyword stitching.
- **Bilingual by design** — English and Chinese are first-class, including founders who need an English domain from a Chinese brief.
- **One-click registrar links** — Alibaba Cloud, Cloudflare, and GoDaddy side by side on each card, with affiliate parameters where configured.
- **Open source & free** — MIT License; self-host or use the hosted version at [nameforme.com](https://nameforme.com).

---

## Product tour

**1. Start from a scenario** — pick a path that matches what you are building; no heavy setup.

![Scenario entry](./public/homepage.png)

**2. Tell us about your brand** — a short questionnaire captures market, tone, preferred TLDs, and budget so generation stays on brief.

![Brand questionnaire](./public/Surveypage.png)

**3. Chat, generate, and verify together** — conversation and progress on the left; **actually available** candidates on the right with AI scores, rationale, first-year and renewal pricing, and three registrar buttons.

![Chat and domain results](./public/chatpage.png)

---

## Core features

| | |
| --- | --- |
| **AI clarification** | Multi-turn Q&A; you can say “start generating” anytime to skip ahead |
| **Multi-strategy generation** | Ten-plus strategies: blends, metaphors, affix branding, pinyin syllables, cross-language borrowings, and more |
| **Live availability** | Alibaba Cloud / Cloudflare Registrar APIs; special TLDs like `.ai` use Porkbun public pricing where needed |
| **AI scoring & rationale** | 0–100 score plus a one-line reason to help you decide fast |
| **Transparent pricing** | First-year and renewal, premium labels; currency follows locale |
| **Affiliate-ready links** | Alibaba Cloud / GoDaddy / Cloudflare with optional affiliate IDs |
| **Favorites & history** | Stored in `localStorage`; no accounts |
| **Bilingual routing** | Dedicated `zh/` and `en/` routes, SEO-friendly |
| **Abuse protection** | IP limits, optional Turnstile, optional Upstash Redis for rate limits |

---

## Tech stack

- **Framework**: Next.js 15 (App Router) · React 19 · TypeScript 5
- **Styling**: Tailwind CSS v4 · semantic tokens around brand **`#53d690`**
- **AI**: Vercel AI SDK 6 · OpenAI-compatible HTTP (DeepSeek, OpenAI, Azure, local vLLM, etc.)
- **i18n**: next-intl 4
- **Validation**: Zod 4
- **Testing**: Playwright
- **Optional persistence**: Upstash Redis (rate limits & blocklist)

---

## Quick start

```bash
git clone https://github.com/jackieniu/NameForMe.git
cd NameForMe
cp .env.example .env.local   # fill LLM_* trio + domain checker credentials
npm install
npm run dev                  # http://localhost:3000
```

Production:

```bash
npm run build && npm run start
```

---

## Environment variables

See [`.env.example`](./.env.example) for the full list.

```env
# OpenAI-compatible chat API — all three required
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

# Domain availability — Cloudflare Registrar and/or Alibaba Cloud
# CF_REGISTRAR_TOKEN=
# CF_ACCOUNT_ID=
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
```

> **Note:** If any LLM variable or registrar credentials are missing, related APIs return errors — we **do not** use mock availability data.

Switch providers by editing env only:

```env
# OpenAI
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# Local vLLM / Ollama, etc.
LLM_BASE_URL=http://127.0.0.1:8000/v1
LLM_MODEL=qwen2.5-14b-instruct
```

---

## Deploy

### Vercel (one-click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjackieniu%2FNameForMe)

Connect GitHub in the wizard to create a project from this repo and run the first deployment. **After deploy**, open **Settings → Environment Variables** and add everything required from [`.env.example`](./.env.example) (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, registrar keys, etc.), then redeploy so the new values apply.

### Node (self-hosted)

`npm run build && npm run start -- --port 3000`

---

## Feedback

NameForMe is under active development — we would love to hear from you. Feature ideas, UX notes, or bug reports are all welcome:

- **[Open an issue](https://github.com/jackieniu/NameForMe/issues)** — steps to reproduce, expected behavior, or product suggestions.
- **Email**: [nameforme@thesuper.me](mailto:nameforme@thesuper.me) — if you prefer not to discuss something in public.

Every message is read; your input shapes what we build next. Thank you for helping NameForMe improve.

---

## Contributing

Issues and PRs are welcome. Before you submit:

1. `npm run build` passes with no errors
2. Use short commit prefixes (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`)
3. For UI changes, attach screenshots or a short screen recording
4. Update both `messages/zh.json` and `messages/en.json` for any user-visible copy

---

## License

[MIT](./LICENSE) © 2026 [jackieniu](https://github.com/jackieniu)

---

<p align="center"><sub>If this project helped you, a ⭐ on the repo means a lot.</sub></p>
