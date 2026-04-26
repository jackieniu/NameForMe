import { generateText, Output } from "ai";
import { z } from "zod";
import { getChatModel, isLlmConfigured } from "@/lib/ai/provider";
import type { DomainRequirements, DomainResultItem } from "@/types/domain";
import { logRefine } from "@/lib/ai-logger";

/**
 * 最终评分阶段的质量阈值（与 prompt 里告知 AI 的"≥60 才返回"严格对齐）。
 * AI 评委是质量分的唯一来源，没有任何启发式后处理：低于此值的域名不会出现在结果中。
 * 修改时请同步更新 prompt 里的相应数字，避免 AI 与代码"约定"不一致。
 */
const MIN_AI_SCORE_TO_RETURN = 60;

/**
 * 优先使用 `generateText` + `output.json()` 解析后的 `result.output`（OpenAI 兼容层会发
 * `response_format: json_object`，与 DeepSeek 文档一致）；否则从纯文本中抠 JSON 对象。
 */
function tryParseObjectFromModelText(t: string): unknown | null {
  const s = t.trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s) as unknown;
    if (j !== null && typeof j === "object" && !Array.isArray(j)) return j;
  } catch {
    /* ignore */
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]!) as unknown;
      if (j !== null && typeof j === "object" && !Array.isArray(j)) return j;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function getJsonPayloadFromLlmResult(result: { output?: unknown; text: string }): unknown | null {
  const o = result.output;
  if (o !== null && typeof o === "object" && !Array.isArray(o)) return o;
  return tryParseObjectFromModelText(result.text ?? "");
}

/** 兼容 { data: { selected, invented } } 等一层包裹 */
function unwrapNestedRefinePayload(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const r = data as Record<string, unknown>;
  for (const key of ["data", "result", "payload", "output"] as const) {
    const inner = r[key];
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      ("selected" in inner || "invented" in inner)
    ) {
      return inner;
    }
  }
  return data;
}

function brief(req: DomainRequirements, locale: "en" | "zh") {
  const extra = req.extraContext?.trim();
  const scenarioLine =
    req.homeScenarioLabel?.trim() &&
    (locale === "zh"
      ? `产品类型: ${req.homeScenarioLabel.trim()}`
      : `Product type: ${req.homeScenarioLabel.trim()}`);
  const lines =
    locale === "zh"
      ? [
          scenarioLine ?? "",
          `项目: ${req.description}`,
          extra ? `补充: ${extra}` : "",
          `市场: ${req.market} | 调性: ${req.tone}`,
        ]
      : [
          scenarioLine ?? "",
          `Project: ${req.description}`,
          extra ? `Context: ${extra}` : "",
          `Market: ${req.market} | Tone: ${req.tone}`,
        ];
  return lines.filter(Boolean).join("\n");
}

/**
 * 空壳主名黑名单：这些词单独做 SLD（或只带 1-2 字母的毫无语义变体）几乎总是已被注册、
 * 也永远不会是「一眼讲得清业务」的好域名。AI 偶尔会把它们当成「有品牌感」误选，
 * 在打分阶段强制拦掉。
 */
const SHELL_LABEL_BLOCKLIST = new Set([
  "app", "apps", "apply", "appify", "appio", "applab", "apphub",
  "lab", "labs", "hub", "kit", "pro", "co", "io", "hq", "ai",
  "get", "got", "go", "now", "try", "run",
  "site", "shop", "store", "cloud", "tech", "online",
]);

/**
 * 判断一个主名是否是"空壳"——长度太短或是黑名单词。哪怕 AI 给了 80 分也要拒绝。
 */
function isShellLabel(label: string): boolean {
  const lower = label.toLowerCase();
  if (lower.length < 4) return true;
  if (SHELL_LABEL_BLOCKLIST.has(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Post-check: score & filter already-registrable FQDNs (one pass per generate)
// ---------------------------------------------------------------------------

const postScoreRowSchema = z.object({
  domain: z.string().min(3).max(120),
  note: z.string().max(220).optional().default(""),
  // score 故意不给 default：缺省时按 0 处理 → 一定被后端阈值过滤掉，
  // 这样能强迫 AI 显式打分，而不是省略字段被默认 60 蒙混过关。
  score: z.number().min(0).max(100).optional(),
});

const postScoreSchema = z.object({
  // 不限制数量上限：让 AI 把所有合格项全部返回，由后端按分数硬阈值过滤。
  // 之前的 .max(52) 会让 AI 误以为"系统期望大约 50 条"而硬凑数。
  selected: z.array(postScoreRowSchema).default([]),
});

const MAX_FINAL_SCORE_CALLS = 3;

function normalizePostScoreJsonPayload(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const o = data as Record<string, unknown>;
  const toRow = (x: unknown) => {
    if (typeof x === "string") {
      // AI 把整行写成纯字符串（漏了 score/note）——按 0 分处理，必被阈值过滤掉，
      // 强迫 AI 在 prompt 要求下显式打分，而不是省略字段被默认分蒙混过关。
      const domain = x.trim();
      return domain ? { domain, note: "", score: 0 } : null;
    }
    if (x && typeof x === "object" && "domain" in x) {
      const domain = String((x as { domain: unknown }).domain ?? "").trim();
      const noteRaw = (x as { note?: unknown }).note;
      const note = typeof noteRaw === "string" ? noteRaw : "";
      const scoreRaw = (x as { score?: unknown }).score;
      let score = 0;
      if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) {
        score = Math.max(0, Math.min(100, scoreRaw));
      } else if (typeof scoreRaw === "string") {
        const n = Number(scoreRaw);
        if (Number.isFinite(n)) score = Math.max(0, Math.min(100, n));
      }
      return domain ? { domain, note, score } : null;
    }
    return null;
  };
  const next: Record<string, unknown> = { ...o };
  next.selected = Array.isArray(o.selected)
    ? o.selected
        .map(toRow)
        .filter((r): r is { domain: string; note: string; score: number } => r !== null)
    : [];
  return next;
}

/**
 * 对「已通过注册商检测且在预算内」的完整域名列表做一次 AI 质量打分与筛选。
 * 若模型返回空或解析失败，则按已有启发式分数排序退回前若干条。
 */
export async function scoreAndSelectRegisteredDomainsWithAi(
  items: DomainResultItem[],
  req: DomainRequirements,
  locale: "en" | "zh",
): Promise<DomainResultItem[]> {
  if (!isLlmConfigured()) {
    console.error("[ai-refine] LLM not configured, skipping post-score");
    throw new Error("大模型配置不完整（需 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL），无法进行 AI 域名打分。");
  }
  if (!items.length) return [];
  console.log("[ai-refine] post-score starting, items:", items.length, "locale:", locale);

  const allowed = new Set(items.map((i) => i.domain.toLowerCase()));
  const byDomain = new Map(items.map((i) => [i.domain.toLowerCase(), i] as const));
  const list = [...new Set(items.map((i) => i.domain.trim().toLowerCase()))].slice(0, 100);

  const userBrief = brief(req, locale);
  const promptZh =
    `你是「起好名」的首席品牌域名评委。下列域名**均已通过注册商验证为可注册**——但"可注册"只代表"没人抢"，不代表"是好名字"。列表里很多是规则引擎随机拼出来的字母串/音节噪声。你的工作是**做严格质量评估**，对每条**值得评价**的域名给一个 0-100 的诚实打分，并写出有信息量的词源说明。\n\n` +
    `## 唯一的数量约束\n` +
    `**没有数量上下限。** 不要凑数，也不要刻意压缩。质量分≥60 的域名**全部都要返回**；质量分<60 的**一条都不要返回**。\n` +
    `- 列表里若 80 条都≥60 分，就返回 80 条。\n` +
    `- 列表里若只有 3 条≥60 分，就返回 3 条。\n` +
    `- 一条≥60 分都没有，就返回空数组 \`[]\`——这是合法且鼓励的输出。\n` +
    `- 后端会再次按分数过滤一遍，所以你**只需要诚实打分**，不要替系统"控制数量"。\n\n` +
    `## 评分细则（请严格、有区分度地打分，不要全部打 70）\n` +
    `**90-100 · 顶级（ship-ready 品牌）**\n` +
    `- 4-9 字符，纯字母，发音顺口，一念即记。\n` +
    `- 词源清晰：能用一句话说清"由 X + Y 组合，意为…"，且 X 和 Y 都和用户业务/调性强相关。\n` +
    `- 例：\`duolingo\`、\`figma\`、\`bilibili\`、\`meituan\`、\`notion\`、\`stripe\`。\n\n` +
    `**75-89 · 强（值得力推）**\n` +
    `- 词源清晰、与业务相关，但稍长（10-12 字符）或独特性略弱。\n` +
    `- 例：针对英语教学的 \`wangenglish\`、\`englishhub\`；针对 AI 域名的 \`namecraft\`、\`brandloom\`。\n\n` +
    `**60-74 · 可接受**\n` +
    `- 有清晰联想锚点，但有一个明显短板：略长（13-14 字符）/ 记忆点偏弱 / 联想需要绕一下。\n` +
    `- 用户在没有更好选择时仍会考虑使用。\n\n` +
    `**40-59 · 勉强（不返回）**\n` +
    `- 有一定结构但联想模糊、拼写偏怪、或与用户业务关联很弱。\n` +
    `- 例：\`teachscript\`（业务相关但拗口）、\`codeyard\`（没毛病但平庸）。\n\n` +
    `**0-39 · 垃圾（不返回）**\n` +
    `- 纯随机音节/字母堆砌，说不出词源，发音拗口。\n` +
    `- 例：\`fajuf\`、\`sojaj\`、\`daoging\`、\`dingging\`、\`yayrlunyo\`、\`swayksnullue\`、\`thooteangbea\`、\`gondgayndle\`、\`zokblaldna\`。看到就剔除，**绝对不要**塞进 selected。\n` +
    `- 含连字符（应该不会有，规则引擎已禁）、空壳词（\`app/lab/hub/kit/pro/get/go/now\` 单独做 SLD 或 SLD<4 字符）。\n\n` +
    `## 评估每条域名时按这 5 个维度自检（按权重）\n` +
    `1. **可读性**（25%）：发音顺口吗？电话里能一次说清吗？\n` +
    `2. **记忆性**（25%）：有具体联想对象，还是一串无意义字母？\n` +
    `3. **业务相关性**（20%）：与用户的产品类型/调性/项目描述匹配吗？\n` +
    `4. **品牌感**（15%）：像一个真正的品牌，而不是占位符？\n` +
    `5. **长度**（15%）：4-9 字符满分，10-12 略扣，13+ 大扣。\n\n` +
    `## note 要求（这是用户看到的域名介绍，必须有信息量）\n` +
    `每条 note 必须**明确交代域名的构词来源与含义**。格式：\n` +
    `- \`wangenglish.com\`：由"Wang"（姓氏汪）+ "English"（英语）组合，直指"汪老师的英语教学"品牌。\n` +
    `- \`loudflame.com\`：由 "loud"（响亮）+ "flame"（火焰）组合，寓意"引爆关注的创意火花"。\n` +
    `- \`duolingo.com\`：由 "duo"（拉丁语"二"）+ "lingo"（语言）构成，指"多语言学习"。\n` +
    `**禁止**写"音节和谐""品牌感强""适合科技品牌""易记易传播"这类空话——这些都不是词源说明。\n` +
    `如果一个域名你**写不出词源**（纯随机字母串），那它就不该出现在 selected——直接打 <60 分剔除。\n\n` +
    `## 输出\n` +
    `\`domain\` 字符串必须与列表中的字符串**完全一致**（含后缀），禁止改写/发明。\n` +
    `只输出一个 JSON 对象，不要 Markdown 围栏：\n` +
    `\`{ "selected": [ { "domain":"完整域名", "note":"由 X + Y 组合，意为…", "score": 0-100 }, … ] }\`\n\n` +
    `## 用户需求\n${userBrief}\n\n` +
    `## 可注册域名（共 ${list.length} 条，大多数是噪声）\n${list.join("\n")}`;

  const promptEn =
    `You are NameForMe's chief brand-domain judge. All domains below are **already verified registrable** — but "registrable" only means "nobody grabbed it", not "good name". Many entries are random gibberish from the rule engine. Your job is a **strict quality evaluation**: assign every worth-rating domain an honest 0-100 score and write an informative etymology note.\n\n` +
    `## The ONLY rule about quantity\n` +
    `**No upper or lower limit.** Do not pad, do not artificially trim. Return **every** domain you score ≥60; return **none** of those <60.\n` +
    `- 80 of 80 cleared 60? Return 80.\n` +
    `- Only 3 cleared 60? Return 3.\n` +
    `- None cleared 60? Return an empty array \`[]\` — this is a legal and encouraged output.\n` +
    `- The backend filters again by score, so just **score honestly**; do not try to "control quantity" for the system.\n\n` +
    `## Scoring rubric (be strict and spread your scores; do not give everything 70)\n` +
    `**90-100 · top tier (ship-ready brand)**\n` +
    `- 4-9 chars, pure letters, smooth to pronounce, instantly memorable.\n` +
    `- Clear etymology: you can say in one sentence "X + Y — means …" and both X and Y strongly tie to the user's business/tone.\n` +
    `- e.g. \`duolingo\`, \`figma\`, \`bilibili\`, \`notion\`, \`stripe\`.\n\n` +
    `**75-89 · strong (worth pushing)**\n` +
    `- Clear etymology and business fit, but slightly long (10-12 chars) or marginally less unique.\n` +
    `- e.g. \`wangenglish\`, \`englishhub\` for an English-teaching brand; \`namecraft\`, \`brandloom\` for an AI naming tool.\n\n` +
    `**60-74 · acceptable**\n` +
    `- Clear anchor but one obvious weakness: longish (13-14 chars), weaker memory hook, or association needs a small leap.\n` +
    `- A user might still pick this in absence of better options.\n\n` +
    `**40-59 · weak (DO NOT return)**\n` +
    `- Some structure but blurry association, awkward spelling, or only loosely tied to the brief.\n\n` +
    `**0-39 · garbage (DO NOT return)**\n` +
    `- Pure random syllables / letter soup, no articulable etymology, awkward to pronounce.\n` +
    `- e.g. \`fajuf\`, \`sojaj\`, \`daoging\`, \`dingging\`, \`yayrlunyo\`, \`swayksnullue\`, \`thooteangbea\`, \`gondgayndle\`, \`zokblaldna\`. Cut on sight; **never** put them in selected.\n` +
    `- Hyphens (rule engine already forbids), shell labels (\`app/lab/hub/kit/pro/get/go/now\` standalone or SLD <4 chars).\n\n` +
    `## Self-check each domain along these 5 weighted dimensions\n` +
    `1. **Readability** (25%): smooth to pronounce? clear over the phone in one go?\n` +
    `2. **Memorability** (25%): concrete mental image, or a meaningless letter stew?\n` +
    `3. **Business fit** (20%): matches the user's product type / tone / brief?\n` +
    `4. **Brand feel** (15%): looks like a real brand, not a placeholder?\n` +
    `5. **Length** (15%): 4-9 chars full marks; 10-12 small penalty; 13+ heavy penalty.\n\n` +
    `## Note requirements (shown to user — must be informative)\n` +
    `Each note MUST **explain the etymology / component breakdown & meaning**. Format:\n` +
    `- \`duolingo.com\`: "duo" (Latin "two") + "lingo" (language) — "multi-language learning".\n` +
    `- \`loudflame.com\`: "loud" + "flame" — "the loud creative spark", fits marketing tools.\n` +
    `**Banned**: empty platitudes like "harmonious syllables", "strong brand feel", "fits tech brand", "easy to remember". Those are not etymology.\n` +
    `If you **cannot articulate an etymology** (pure random letters), the domain does not belong in selected — score it <60 and cut.\n\n` +
    `## Output\n` +
    `\`domain\` strings must match the list **exactly** (incl. TLD); never invent or rewrite.\n` +
    `Output one JSON object only, no markdown fences:\n` +
    `\`{ "selected": [ { "domain":"fqdn", "note":"X + Y — meaning…", "score": 0-100 }, … ] }\`\n\n` +
    `## Brief\n${userBrief}\n\n` +
    `## Registrable list (${list.length} items, mostly noise)\n${list.join("\n")}`;

  const basePrompt = locale === "zh" ? promptZh : promptEn;
  const startTs = Date.now();
  let lastError = "";

  for (let attempt = 0; attempt < MAX_FINAL_SCORE_CALLS; attempt++) {
    const fullPrompt =
      basePrompt +
      (attempt > 0
        ? locale === "zh"
          ? `\n\n【第 ${attempt + 1} 次】上次 JSON 不合法。请只输出一个 JSON 对象，根键仅为 selected。`
          : `\n\n【Attempt ${attempt + 1}】Invalid JSON before. Output one JSON object with root key selected only.`
        : "");

    try {
      const result = await generateText({
        model: getChatModel(),
        prompt: fullPrompt,
        maxOutputTokens: 8192,
        output: Output.json({ name: "domainPostScore" }),
      });

      let rawJson = getJsonPayloadFromLlmResult(result);
      rawJson = unwrapNestedRefinePayload(rawJson);
      const normalized = normalizePostScoreJsonPayload(rawJson);
      const parsed = postScoreSchema.safeParse(normalized);
      if (!parsed.success) {
        console.error("[ai-refine] post-score parse failed attempt", attempt, JSON.stringify(normalized)?.slice(0, 300));
        continue;
      }

      // 后端硬过滤：质量分**完全由 AI 给出**，本层只做单一阈值过滤，**没有任何数量上下限**。
      // 1) AI 没显式打分 → schema 解析时按 0 分处理，会被阈值过滤
      // 2) AI 自评 < MIN_AI_SCORE_TO_RETURN → 直接丢
      // 3) 空壳词（app/lab/hub/...）→ 直接丢
      // 经过这一层后，剩余的就是真正可以放心展示的域名，按 AI 分倒序返回全部。
      const out: DomainResultItem[] = [];
      const seen = new Set<string>();
      let droppedShell = 0;
      let droppedAiScore = 0;
      for (const row of parsed.data.selected) {
        const d = row.domain.trim().toLowerCase();
        if (!allowed.has(d) || seen.has(d)) continue;
        const sld = d.includes(".") ? (d.split(".")[0] ?? d) : d;
        if (isShellLabel(sld)) {
          droppedShell += 1;
          continue;
        }
        const aiScore = typeof row.score === "number" ? row.score : 0;
        if (aiScore < MIN_AI_SCORE_TO_RETURN) {
          droppedAiScore += 1;
          continue;
        }
        const baseItem = byDomain.get(d);
        if (!baseItem) continue;
        const noteTrim = (row.note ?? "").trim();
        seen.add(d);
        out.push({
          ...baseItem,
          score: aiScore,
          reason: noteTrim.length > 0 ? noteTrim : baseItem.reason,
        });
      }

      logRefine({
        locale,
        brief: userBrief,
        prompt: fullPrompt,
        inputCount: list.length,
        input: list,
        output: {
          selected: parsed.data.selected.map((r) => ({
            domain: r.domain,
            note: r.note ?? "",
            score: r.score,
          })),
          invented: [],
        },
        resultCount: out.length,
        durationMs: Date.now() - startTs,
        notes: {
          aiReturned: parsed.data.selected.length,
          droppedShell,
          droppedAiScore,
          finalReturned: out.length,
          minAiScore: MIN_AI_SCORE_TO_RETURN,
        },
      });

      // AI 调用 + 解析成功就算工作完成。即便过滤后是 0 条也直接返回——
      // "0 条" 是合法且重要的信号，表示候选池整体不合格，前端应展示提示而不是
      // 退化到原始候选（那样会把垃圾域名展示给用户，违背质量把关初衷）。
      out.sort((a, b) => b.score - a.score);
      return out;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("[ai-refine] post-score attempt", attempt, "threw:", lastError);
    }
  }

  // 走到这里说明 AI 三次打分调用全部失败。降级为未打分列表，避免白屏。
  const fallbackReason = "post-score AI failed after all attempts — returning unscored fallback";

  logRefine({
    locale,
    brief: userBrief,
    prompt: basePrompt,
    inputCount: list.length,
    input: list,
    error: lastError ? `${fallbackReason} | lastError: ${lastError}` : fallbackReason,
    durationMs: Date.now() - startTs,
  });

  // 降级：按主名长度升序排（短名更具品牌感），给一个合理的基础分
  const fallbackOut: DomainResultItem[] = items
    .filter((it) => {
      const sld = it.domain.includes(".") ? (it.domain.split(".")[0] ?? it.domain) : it.domain;
      return !isShellLabel(sld);
    })
    .map((it) => {
      const sld = it.domain.includes(".") ? (it.domain.split(".")[0] ?? it.domain) : it.domain;
      const lengthScore = sld.length <= 6 ? 70 : sld.length <= 9 ? 65 : 60;
      return { ...it, score: lengthScore };
    })
    .sort((a, b) => {
      const aLen = (a.domain.split(".")[0] ?? a.domain).length;
      const bLen = (b.domain.split(".")[0] ?? b.domain).length;
      return aLen - bLen;
    });

  return fallbackOut;
}
