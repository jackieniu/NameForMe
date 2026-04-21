import type { DomainRequirements, NamingStyle } from "@/types/domain";
import {
  AFFIX_BRAND_BANK,
  CURATED_POSITIVE_BANK,
  CURATED_PREFIX_BANK,
  MARKOV_NUCLEI,
  MARKOV_ONSETS,
  PINYIN_FINALS,
  PINYIN_INITIALS,
  affixTierForTone,
  curatedPoolsForTone,
  prefixTiersForTone,
  type AffixTier,
  type CuratedPositiveCategory,
  type CuratedPrefixTier,
} from "@/lib/domains/word-banks";
export type Candidate = { host: string; strategy: string };

/** 注册用后缀，统一为 `.com` 形式 */
export function normalizeRegistrableSuffix(s: string) {
  const t = s.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainLabel(h: string): boolean {
  const k = h.toLowerCase();
  // 优质品牌域名绝不用连字符，这里直接要求纯字母数字
  return (
    k.length >= 2 &&
    k.length <= 20 &&
    !k.includes(".") &&
    !k.includes("-") &&
    /^[a-z0-9]+$/.test(k)
  );
}

function isLockedFqdn(h: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h);
}

function fqdnEndsWithUserSuffix(fqdn: string, normSuffixes: readonly string[]): boolean {
  const lower = fqdn.toLowerCase();
  return normSuffixes.some((sfx) => lower.endsWith(sfx) && lower.length > sfx.length);
}

/**
 * 把单词末尾的一个真正的辅音（不含 y）复制一遍，用于 creative_spelling 的「双辅音」变体。
 * `y` 被视为元音变体，不参与加倍，避免 `ready → readyy` / `party → partyy` 这类低识别度产物。
 * 找不到合格辅音或太短时返回 null，交由调用方跳过。
 */
function doubleLastConsonant(s: string): string | null {
  if (s.length < 3) return null;
  const vowelish = "aeiouy";
  for (let i = s.length - 1; i >= 0; i--) {
    if (!vowelish.includes(s[i]!)) {
      return s.slice(0, i + 1) + s[i] + s.slice(i + 1);
    }
  }
  return null;
}

/**
 * excludes 匹配：避免 substring 过度命中（如 `ai` 误伤 `maiproject`）。
 * 命中条件（任一）：整词相等、以 `-` 边界前后、以整词开头/结尾。
 * 这里主名是纯字母数字（已过 `isPlainLabel`），所以退化为「开头/结尾/完全相等」三条。
 */
function hitsExclude(label: string, excludes: readonly string[]): boolean {
  const h = label.toLowerCase();
  for (const raw of excludes) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (h === e) return true;
    if (h.startsWith(e) || h.endsWith(e)) return true;
  }
  return false;
}

/** 仅主标签（SLD），不含点；后续由生成管线与用户后缀组合再检测 */
function pushLabel(
  out: Candidate[],
  seen: Set<string>,
  excludes: string[],
  label: string,
  strategy: string,
  max: number,
) {
  const h = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (out.length >= max) return;
  if (!isPlainLabel(h)) return;
  if (seen.has(h)) return;
  if (hitsExclude(h, excludes)) return;
  seen.add(h);
  out.push({ host: h, strategy });
}

/** TLD hack 等已锁定完整 FQDN，仅当后缀落在用户所选列表时才加入 */
function pushLockedFqdn(
  out: Candidate[],
  seen: Set<string>,
  excludes: string[],
  fqdn: string,
  strategy: string,
  max: number,
  normSuffixes: readonly string[],
) {
  const h = fqdn.toLowerCase();
  if (out.length >= max) return;
  if (!isLockedFqdn(h)) return;
  if (!fqdnEndsWithUserSuffix(h, normSuffixes)) return;
  if (seen.has(h)) return;
  // 对 FQDN 只检查 SLD 部分，避免 .ai / .io / .us 这类后缀被用户 excludes 误伤
  const sldOnly = h.replace(/\..*$/, "");
  if (hitsExclude(sldOnly, excludes)) return;
  seen.add(h);
  out.push({ host: h, strategy });
}

/**
 * Parse AI strategy params string into a key-value map.
 * Format: "key1=val1+key2=val2"  or  "word1+word2"
 */
function parseParams(params: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!params) return map;
  for (const part of params.split("+")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      const v = part.trim();
      if (!v) continue;
      map["_word"] = map["_word"] ? `${map["_word"]},${v}` : v;
    } else {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (!k) continue;
      // 同名 key 追加合并（如 `keyword=a,b+keyword=c` → `a,b,c`），避免后者覆盖前者丢语义
      map[k] = map[k] ? `${map[k]},${v}` : v;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildCandidates(
  req: DomainRequirements,
  _seed: number,
  max = 260,
  /** 单策略名，来自 AI 的 [[STRATEGIES:...]]（必填） */
  strategyHint: string,
  /** optional params string from AI strategy */
  paramsHint?: string,
): Candidate[] {
  // seed 仍在签名里保留（向后兼容），但现在所有策略都是参数驱动的确定性枚举，
  // 不再依赖伪随机，避免「同一批参数两次跑出不同候选」。
  void _seed;
  const styles = new Set([strategyHint as NamingStyle]);
  const excludes = req.excludes.map((e) => e.toLowerCase()).filter(Boolean);
  // 所有候选生成都要求 AI 通过 paramsHint 显式给出语义锚（word / keyword / root / base / num / seed_word ...）
  // 彻底抛弃 slugify(req.description) 这种「从不确定数据源随机取字」的旧做法。
  const normSuffixes = (req.suffixes?.length ? req.suffixes : [".com", ".ai", ".io"]).map(
    normalizeRegistrableSuffix,
  );
  const params = parseParams(paramsHint ?? "");

  const out: Candidate[] = [];
  const seen = new Set<string>();

  // ---- 1. word_combo: moved to buildWordComboCandidates ----
  // word_combo 已迁移到独立的 `buildWordComboCandidates` 新管线：
  //   - 必填 `word`（1–5 个），不带则本轮零产出；
  //   - 与 CURATED_POSITIVE_BANK（按 tone / pool 选分类）双向遍历；
  //   - 由 domain-generation 编排层「边查边停」（累计 80 条可注册且预算内即停）。
  // 这里保留分支名占位，避免 strategies 里写了 `word_combo:...` 却被当成未知 style 报错。
  if (styles.has("word_combo")) {
    /* intentionally empty: handled by buildWordComboCandidates */
  }

  // ---- 2. affix_brand: moved to buildAffixBrandCandidates ----
  // affix_brand 走独立的 `buildAffixBrandCandidates` 管线：必填 keyword，
  // 由 tone → tier 选词集，编排层「边查边停」，与 word_combo 同一套心智。
  // 这里保留占位，避免 strategies 里写了 `affix_brand:...` 却被当成未知 style 报错。
  if (styles.has("affix_brand")) {
    /* intentionally empty: handled by buildAffixBrandCandidates */
  }

  // ---- 3. creative_spelling: 必填 `word=`；仅做有品牌识别度的尾缀变体 ----
  // 去除 stripVowels（产出 `tch/lrn` 这类无识别度的辅音串）与旧 doubleConsonant（实际产物
  // 是「复制第 2 位字符」，多为伪装变体）。改为：按 tone 挑选尾缀子集 + 尾辅音加倍。
  if (styles.has("creative_spelling")) {
    const rawWords = (params["word"] ?? params["_word"] ?? "").trim();
    const words = rawWords
      .split(",")
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length >= 2 && w.length <= 10)
      .slice(0, 5);
    const toneKey = (req.tone ?? "any").toLowerCase();
    // 按调性给尾缀子集，避免把 `520teach`-级别的花哨组合塞给严肃品牌
    const suffixSet =
      toneKey === "elegant" || toneKey === "luxury"
        ? ["io", "o"]
        : toneKey === "professional"
          ? ["io", "ly", "hq"]
          : toneKey === "tech"
            ? ["io", "ly", "ify", "r"]
            : ["ly", "ify", "io", "o", "a"];
    for (const w of words) {
      for (const tail of suffixSet) {
        if (out.length >= max) break;
        if (w.endsWith(tail)) continue; // 不重复追加
        const v = `${w}${tail}`;
        if (!passesReadability(v, req.tone)) continue;
        pushLabel(out, seen, excludes, v, "creative_spelling", max);
      }
      const dbl = doubleLastConsonant(w);
      if (dbl && passesReadability(dbl, req.tone) && dbl !== w) {
        pushLabel(out, seen, excludes, dbl, "creative_spelling", max);
      }
    }
  }

  // ---- 4. metaphor: 必填 `token=` + `word=`；仅正序、笛卡尔积上限 10 ----
  // 只保留 `{token}{word}`（如 `falconteach`），品牌识别度显著高于反序 `{word}{token}`。
  if (styles.has("metaphor")) {
    const rawTokens = (params["token"] ?? "").trim();
    const rawWords = (params["word"] ?? "").trim();
    const tokens = rawTokens
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/[^a-z]/g, ""))
      .filter((t) => t.length >= 2 && t.length <= 8)
      .slice(0, 3);
    const words = rawWords
      .split(",")
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length >= 2 && w.length <= 10)
      .slice(0, 3);
    if (tokens.length > 0 && words.length > 0) {
      outer: for (const m of tokens) {
        for (const w of words) {
          if (out.length >= max) break outer;
          if (m === w) continue;
          const label = `${m}${w}`;
          if (passesReadability(label, req.tone)) {
            pushLabel(out, seen, excludes, label, "metaphor", max);
          }
        }
      }
    }
  }

  // ---- 5. portmanteau: 必填 `words=a,b[,c...]`（≥2 个）----
  // 只保留 blend1（`head(a) + tail(b)`）+ overlap；删除 blend2（仅是 blend1 的邻居）。
  // 对 head / tail 的最短长度各要求 3，避免 2+2=4 字碎片。
  if (styles.has("portmanteau")) {
    const rawWords = (params["words"] ?? "").trim();
    const pool = rawWords
      .split(",")
      .map((w) => w.trim().toLowerCase().replace(/[^a-z]/g, ""))
      .filter((w) => w.length >= 4 && w.length <= 10);
    if (pool.length >= 2) {
      portLoop: for (let i = 0; i < pool.length; i++) {
        for (let j = 0; j < pool.length; j++) {
          if (out.length >= max) break portLoop;
          if (i === j) continue;
          const a = pool[i]!;
          const b = pool[j]!;
          const midA = Math.ceil(a.length / 2);
          const midB = Math.floor(b.length / 2);
          const head = a.slice(0, midA);
          const tail = b.slice(midB);
          if (head.length >= 3 && tail.length >= 3) {
            const blend = head + tail;
            if (passesReadability(blend, req.tone)) {
              pushLabel(out, seen, excludes, blend, "portmanteau", max);
            }
          }
          for (let ov = 2; ov <= Math.min(4, a.length, b.length); ov++) {
            if (a.slice(-ov) === b.slice(0, ov)) {
              const overlap = `${a}${b.slice(ov)}`;
              if (passesReadability(overlap, req.tone)) {
                pushLabel(out, seen, excludes, overlap, "portmanteau", max);
              }
            }
          }
        }
      }
    }
  }

  // ---- 6. tld_hack: 必填 `base=` + `tld=`（TLD 必须在用户所选后缀集内）----
  // 删除旧「方式 1」（与「方式 2」99% 重复且实现有误）。新增「尾音重叠合并」形式：
  // base=deliciou + tld=us → `delicious.us`（`base + tld` 的最后 1 个字符在 base 末尾已有时触发）。
  if (styles.has("tld_hack")) {
    const base = (params["base"] ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
    const rawTld = (params["tld"] ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (base.length >= 3 && base.length <= 10 && rawTld.length >= 2 && rawTld.length <= 4) {
      const sfx = `.${rawTld}`;
      if (normSuffixes.includes(sfx)) {
        // 主形式：`base.tld`（bit.ly 模式）；SLD 就是 base，要过 tone 长度 & 可读性
        if (passesReadability(base, req.tone)) {
          pushLockedFqdn(out, seen, excludes, `${base}${sfx}`, "tld_hack", max, normSuffixes);
        }
        // 尾音重叠合并：base 尾 1 个字符 = tld 首字符时，合并后得到一个「完整词 .tld」的效果
        if (base.length >= 3 && base.slice(-1) === rawTld.slice(0, 1)) {
          const mergedSld = `${base.slice(0, -1)}${rawTld}`;
          if (passesReadability(mergedSld, req.tone)) {
            pushLockedFqdn(
              out,
              seen,
              excludes,
              `${mergedSld}${sfx}`,
              "tld_hack",
              max,
              normSuffixes,
            );
          }
        }
      }
    }
  }

  // ---- 7. number_combo: 必填 `keyword=` + `num=`；tone + market 双闸 ----
  // tone：playful / tech / any（或未设）放行；professional / elegant / luxury 禁用。
  // market：us 市场下 520/666/888 无语义，强制只接受「国际通用」数字（年份 19xx/20xx、
  //   个位/双位自然数）；cn/both 才允许完整数字表达。
  if (styles.has("number_combo")) {
    const toneKey = (req.tone ?? "").toLowerCase();
    const blockTone =
      toneKey === "professional" || toneKey === "elegant" || toneKey === "luxury";
    if (!blockTone) {
      const rawKeywords = (params["keyword"] ?? "").trim();
      const rawNums = (params["num"] ?? params["number"] ?? "").trim();
      const keywords = rawKeywords
        .split(",")
        .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter((w) => w.length >= 2 && w.length <= 10)
        .slice(0, 3);
      const market = (req.market ?? "").toLowerCase();
      const isIntlSafe = (n: string) => /^\d{1,2}$/.test(n) || /^(19|20)\d{2}$/.test(n);
      const nums = rawNums
        .split(",")
        .map((n) => n.trim())
        .filter((n) => /^\d{1,4}$/.test(n))
        .filter((n) => (market === "us" ? isIntlSafe(n) : true))
        .slice(0, 4);
      if (keywords.length > 0 && nums.length > 0) {
        for (const kw of keywords) {
          for (const num of nums) {
            if (out.length >= max) break;
            const a = `${kw}${num}`;
            const b = `${num}${kw}`;
            if (passesReadability(a, req.tone)) pushLabel(out, seen, excludes, a, "number_combo", max);
            if (passesReadability(b, req.tone)) pushLabel(out, seen, excludes, b, "number_combo", max);
          }
        }
      }
    }
  }

  // ---- 8. pinyin_syllable: 必填 `anchor=` + `initials` 或 `finals` 至少一个非空 ----
  // 取消默认 6×6 = 36 组枚举（产出 `baoxinyi` 这类与 anchor 关系极弱的包裹形体）。
  // tone 闸：elegant/luxury 品牌不合适拼音风格，直接跳过（且这两档的 passesReadability
  // 长度上限只有 10，拼音拼接容易超长，跑了也几乎全被过滤）。
  if (styles.has("pinyin_syllable")) {
    const toneKey = (req.tone ?? "").toLowerCase();
    if (toneKey === "elegant" || toneKey === "luxury") {
      // skip
    } else {
    const anchor = (params["anchor"] ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
    const fixedInitials = (params["initials"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/[^a-z]/g, ""))
      .filter((s) => s.length >= 1 && s.length <= 2);
    const fixedFinals = (params["finals"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/[^a-z]/g, ""))
      .filter((s) => s.length >= 1 && s.length <= 4);
    const hasConstraint = fixedInitials.length > 0 || fixedFinals.length > 0;
    if (anchor.length >= 2 && anchor.length <= 6 && hasConstraint) {
      const initials = fixedInitials.length ? fixedInitials : [...PINYIN_INITIALS].slice(0, 4);
      const finals = fixedFinals.length ? fixedFinals : [...PINYIN_FINALS].slice(0, 4);
      psLoop: for (const i1 of initials) {
        for (const f1 of finals) {
          if (out.length >= max) break psLoop;
          const a = `${i1}${f1}${anchor}`;
          const b = `${anchor}${i1}${f1}`;
          if (passesReadability(a, req.tone)) pushLabel(out, seen, excludes, a, "pinyin_syllable", max);
          if (passesReadability(b, req.tone)) pushLabel(out, seen, excludes, b, "pinyin_syllable", max);
        }
      }
    }
    }
  }

  // ---- 9. markov_syllable: 必填 `seed_word=`，仅加 1 个 Markov 音节尾巴 ----
  // seed 完整保留，再追加 `onset + nucleus`（2–3 字母），产物 = `${seed}${mo|vi|la|...}`，
  // 保留 seed 的可读性与品牌感，不在 seed 内部乱插随机字母。
  if (styles.has("markov_syllable")) {
    const seed = (params["seed_word"] ?? params["seed"] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (seed.length >= 2 && seed.length <= 10) {
      // 枚举所有 onset × nucleus，避免 pick() 带放回采样导致实际产出过少；
      // 单策略最多保留 30 个独立 tail，passesReadability 之后再入 out。
      const MAX_PER_STRATEGY = 30;
      let kept = 0;
      const seedTail = seed.slice(-1);
      // 与 doubleLastConsonant / passesReadability 统一：y 视为元音变体
      const isCons = (c: string) => /[bcdfghjklmnpqrstvwxz]/.test(c);
      outer: for (const onset of MARKOV_ONSETS) {
        for (const nucleus of MARKOV_NUCLEI) {
          if (out.length >= max || kept >= MAX_PER_STRATEGY) break outer;
          const tail = `${onset}${nucleus}`;
          if (tail.length < 2 || tail.length > 4) continue;
          // 边界 3+ 连辅音兜底：仅当「seed 尾辅音 + onset 前 2 位都是辅音」才跳过
          // （如 teach+bl→teachbl... 三连辅音）；单辅音衔接（teach+ma）不拦。
          if (
            isCons(seedTail) &&
            onset.length >= 2 &&
            isCons(onset[0]!) &&
            isCons(onset[1]!)
          ) {
            continue;
          }
          const word = `${seed}${tail}`.replace(/[^a-z]/g, "");
          if (!passesReadability(word, req.tone)) continue;
          const before = out.length;
          pushLabel(out, seen, excludes, word, "markov_syllable", max);
          if (out.length > before) kept += 1;
        }
      }
    }
  }

  // ---- 10. repeat_syllable: 必填 `base=` 或 `syllable=`；tone 闸（禁 professional/elegant/luxury）----
  if (styles.has("repeat_syllable")) {
    const toneKey = (req.tone ?? "").toLowerCase();
    const blockTone =
      toneKey === "professional" || toneKey === "elegant" || toneKey === "luxury";
    if (!blockTone) {
      const baseRaw = (params["base"] ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const syllableRaw = (params["syllable"] ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
      if (baseRaw.length >= 2 && baseRaw.length <= 6) {
        const v = `${baseRaw}${baseRaw}`;
        if (passesReadability(v, req.tone)) pushLabel(out, seen, excludes, v, "repeat_syllable", max);
      }
      if (syllableRaw.length >= 2 && syllableRaw.length <= 4) {
        const v2 = `${syllableRaw}${syllableRaw}`;
        if (passesReadability(v2, req.tone)) pushLabel(out, seen, excludes, v2, "repeat_syllable", max);
        if (syllableRaw.length <= 3) {
          const v3 = `${syllableRaw}${syllableRaw}${syllableRaw}`;
          if (passesReadability(v3, req.tone)) pushLabel(out, seen, excludes, v3, "repeat_syllable", max);
        }
      }
    }
  }

  // ---- 12. ai_direct: words= 直接就是最终 SLD，代码侧不做任何拼接/变形 ----
  // 由 chat AI 根据用户完整描述直接给出它认为最有品牌感的主名，
  // 绕过固定词表与规则拼接的生硬感。与其它策略走完全一致的过滤：
  //   - 纯 [a-z0-9]、无 . 无 -（由 isPlainLabel 保证）
  //   - 长度 4–14（由 passesReadability + tone 长度上限保证）
  //   - excludes 命中即丢、跨策略去重
  // 单策略最多收 40 条，防 AI 一次性丢过多低质量词把一批送检额度吃满。
  if (styles.has("ai_direct")) {
    const rawWords = (params["words"] ?? params["word"] ?? params["_word"] ?? "").trim();
    if (rawWords) {
      const AI_DIRECT_MAX = 40;
      const list = rawWords
        .split(",")
        .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter(Boolean)
        .slice(0, AI_DIRECT_MAX);
      for (const w of list) {
        if (out.length >= max) break;
        if (!passesReadability(w, req.tone)) continue;
        pushLabel(out, seen, excludes, w, "ai_direct", max);
      }
    }
  }

  // ---- 11. cross_lang: 必填 `pinyin=` + `en=`；双向拼接 + 可读性/长度控制 ----
  // 之前 `pinyin` 策略（拼音 root + 英文词）职能与此完全重合，已合并并删除。
  if (styles.has("cross_lang")) {
    const fixedPinyin = (params["pinyin"] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const rawEn = (params["en"] ?? params["word"] ?? params["_word"] ?? "").trim();
    const enWords = rawEn
      .split(",")
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length >= 2 && w.length <= 8)
      .slice(0, 3);
    if (fixedPinyin.length >= 2 && fixedPinyin.length <= 8 && enWords.length > 0) {
      clLoop: for (const en of enWords) {
        if (out.length >= max) break clLoop;
        const a = `${fixedPinyin}${en}`;
        const b = `${en}${fixedPinyin}`;
        if (passesReadability(a, req.tone)) pushLabel(out, seen, excludes, a, "cross_lang", max);
        if (passesReadability(b, req.tone)) pushLabel(out, seen, excludes, b, "cross_lang", max);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// word_combo 新管线（必填 word + curated bank 双向遍历 + 可读性过滤）
// ---------------------------------------------------------------------------

/** word_combo 入参解析结果 */
export interface WordComboParams {
  /** 用户/AI 给出的业务关键词，已规范化为小写字母串（3–12 位）。允许多个（按输入顺序）。 */
  words: string[];
  /** 启用的 curated 分类；显式 `pool=...` 覆盖 tone 映射 */
  pools: CuratedPositiveCategory[];
}

/** 解析 strategy params 字符串为 word_combo 新管线的入参 */
export function parseWordComboParams(
  paramsStr: string | undefined,
  tone: string | undefined,
): WordComboParams {
  const params = parseParams(paramsStr ?? "");
  const rawWords = (params["word"] ?? params["_word"] ?? "").trim();
  const words = rawWords
    .split(",")
    .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 2 && w.length <= 10)
    .slice(0, 5);

  const poolsRaw = (params["pool"] ?? "").trim();
  const requested = poolsRaw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const ALL: CuratedPositiveCategory[] = ["value", "motion", "place", "nature"];
  const poolsFromParam = requested.filter((p): p is CuratedPositiveCategory =>
    (ALL as string[]).includes(p),
  );
  const pools = poolsFromParam.length > 0 ? poolsFromParam : curatedPoolsForTone(tone);
  return { words, pools };
}

/**
 * 拼接后的主名可读性过滤。
 *
 * - 禁止纯数字、纯辅音串（含 `bcdfg...` 这类拗口字符串）；
 * - 禁止 3 连同字符、3 连元音、3 连辅音（字母，不计数字）；
 * - 按 tone 收紧长度：
 *   - `elegant` / `luxury`：上限 10（奢华品牌倾向短）；
 *   - `professional` / `tech`：上限 12；
 *   - `playful` / `any` / 未指定：上限 14；
 * - 红线第 2 条规定 4–12 最佳，>14 由 AI refine 阶段打分处理；这里把代码层上限压到 14，绝不再放 16。
 */
function lengthCapForTone(tone: string | undefined): number {
  const t = (tone ?? "").toLowerCase();
  if (t === "elegant" || t === "luxury") return 10;
  if (t === "professional" || t === "tech") return 12;
  return 14;
}

function passesReadability(label: string, tone?: string | undefined): boolean {
  const h = label.toLowerCase();
  if (!/^[a-z0-9]+$/.test(h)) return false;
  if (h.length < 4) return false;
  if (h.length > lengthCapForTone(tone)) return false;
  if (/^\d+$/.test(h)) return false;
  if (/([a-z0-9])\1{2,}/.test(h)) return false;
  if (/[aeiou]{3,}/.test(h)) return false;
  // y 视为元音变体，与 doubleLastConsonant / markov 边界判定保持一致，
  // 避免 `skryy` 这类被 4 连辅音误杀，同时不放过真 4 连辅音（如 `strngth`）
  if (/[bcdfghjklmnpqrstvwxz]{4,}/.test(h)) return false;
  return true;
}

function collectCuratedTokens(pools: CuratedPositiveCategory[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pools) {
    for (const t of CURATED_POSITIVE_BANK[p]) {
      const k = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (k.length < 2 || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * 按用户关键词与 curated 词表生成 word_combo 候选。
 *
 * - `words` 为空时返回空数组（该策略本轮零产出，不做随机退化）；
 * - 顺序：对每个 `word`，先 Pass A (`token + word`)，后 Pass B (`word + token`)；
 * - 同一主名只留一条；可读性过滤在 pushLabel 之前执行。
 * - 「攒够 80 条即停」由 domain-generation 编排层在检测阶段完成，本函数只产候选。
 */
export function buildWordComboCandidates(
  req: DomainRequirements,
  paramsStr: string | undefined,
  max = 1000,
): Candidate[] {
  const parsed = parseWordComboParams(paramsStr, req.tone);
  if (parsed.words.length === 0) return [];

  const tokens = collectCuratedTokens(parsed.pools);
  if (tokens.length === 0) return [];

  const excludes = req.excludes.map((e) => e.toLowerCase()).filter(Boolean);
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const tryPush = (label: string) => {
    if (!passesReadability(label, req.tone)) return;
    pushLabel(out, seen, excludes, label, "word_combo", max);
  };

  for (const word of parsed.words) {
    for (const tok of tokens) {
      if (out.length >= max) return out;
      if (tok === word) continue;
      tryPush(`${tok}${word}`);
    }
    for (const tok of tokens) {
      if (out.length >= max) return out;
      if (tok === word) continue;
      tryPush(`${word}${tok}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 前缀扩容：主阶段可注册数不足时，对「被占用主名」统一加前缀再检测
// ---------------------------------------------------------------------------

/**
 * 扩容黑名单：把 AFFIX_BRAND_BANK 所有 prefix/suffix 聚合一次，避免与「shell 词」
 * 独立维护导致的不一致（如 `pro/hub/kit/lab/works` 同时出现在两边）。
 * 额外补几个「壳词」常见形态（如 site/shop/cloud）。
 */
const SHELL_LABELS_FOR_EXPAND: readonly string[] = (() => {
  const set = new Set<string>();
  for (const tier of Object.keys(AFFIX_BRAND_BANK) as AffixTier[]) {
    for (const w of AFFIX_BRAND_BANK[tier].prefix) set.add(w.toLowerCase());
    for (const w of AFFIX_BRAND_BANK[tier].suffix) set.add(w.toLowerCase());
  }
  for (const w of ["site", "shop", "store", "cloud", "apps"]) set.add(w);
  return [...set].filter((w) => w.length >= 2 && w.length <= 6);
})();

/**
 * 判定主名是否值得加前缀扩容。
 * 关键修正：不再只按「等于某个壳词」判断，而是按「以壳词开头/结尾」判断——
 * `tryfit` / `prolab` 已经带了 `try/pro/lab`，再加一层前缀就是堆壳词。
 */
function isExpandable(sld: string): boolean {
  const h = sld.toLowerCase();
  if (!/^[a-z0-9]+$/.test(h)) return false;
  if (h.length < 3 || h.length > 10) return false;
  for (const shell of SHELL_LABELS_FOR_EXPAND) {
    if (h === shell) return false;
    if (shell.length >= 3 && (h.startsWith(shell) || h.endsWith(shell))) return false;
  }
  return true;
}

/**
 * 用前缀词表 × 被占用主名 生成扩容候选。
 * - 仅 `prefix + occupiedSld`，不做反向。
 * - 产物的 strategy 字段为 `word_combo_prefix_expand`。
 */
export function buildPrefixExpansionCandidates(
  req: DomainRequirements,
  occupiedSlds: Iterable<string>,
  max = 600,
): Candidate[] {
  const tiers = prefixTiersForTone(req.tone);
  const prefixes: string[] = [];
  const prefSeen = new Set<string>();
  for (const tier of tiers as CuratedPrefixTier[]) {
    for (const p of CURATED_PREFIX_BANK[tier]) {
      const k = p.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!k || prefSeen.has(k)) continue;
      prefSeen.add(k);
      prefixes.push(k);
    }
  }
  if (prefixes.length === 0) return [];

  // 预过滤：加最短前缀（2 字母，如 `my/go/hi`）后也必须能过 tone 长度上限，
  // 否则这类 base 全部会被 passesReadability 过滤掉，白跑枚举
  const toneCap = lengthCapForTone(req.tone);
  const minPrefixLen = Math.min(...prefixes.map((p) => p.length), 99);
  const maxBaseLen = Math.max(4 - minPrefixLen, toneCap - minPrefixLen); // 至少 4 字是 passesReadability 下限
  const bases: string[] = [];
  const baseSeen = new Set<string>();
  for (const raw of occupiedSlds) {
    const h = raw.trim().toLowerCase();
    if (!isExpandable(h) || baseSeen.has(h)) continue;
    if (h.length > maxBaseLen) continue;
    baseSeen.add(h);
    bases.push(h);
  }
  if (bases.length === 0) return [];

  const excludes = req.excludes.map((e) => e.toLowerCase()).filter(Boolean);
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const base of bases) {
    for (const p of prefixes) {
      if (out.length >= max) return out;
      const label = `${p}${base}`;
      if (!passesReadability(label, req.tone)) continue;
      pushLabel(out, seen, excludes, label, "word_combo_prefix_expand", max);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// affix_brand 新管线（合并自旧 compound / brand_prefix）
// ---------------------------------------------------------------------------

/** affix_brand 入参解析结果 */
export interface AffixBrandParams {
  /** 业务核心词，已规范化为小写字母数字；最多 5 个 */
  keywords: string[];
  /** 启用档位（tier=all 时合并四档；否则按显式或 tone 映射） */
  tiers: AffixTier[];
  /** prefix=x 锁死一个前缀（优先级最高，走纯前缀侧） */
  fixedPrefix: string | null;
  /** suffix=y 锁死一个后缀（优先级最高，走纯后缀侧） */
  fixedSuffix: string | null;
  /** side=prefix|suffix|both；当 fixed* 存在时按对应侧执行 */
  side: "prefix" | "suffix" | "both";
}

const ALL_TIERS: AffixTier[] = ["tech", "saas", "playful", "elegant"];

/** 解析 strategy params 字符串为 affix_brand 新管线的入参 */
export function parseAffixBrandParams(
  paramsStr: string | undefined,
  tone: string | undefined,
): AffixBrandParams {
  const params = parseParams(paramsStr ?? "");

  const rawKw = (params["keyword"] ?? params["_word"] ?? "").trim();
  const keywords = rawKw
    .split(",")
    .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 2 && w.length <= 10)
    .slice(0, 5);

  const tierRaw = (params["tier"] ?? "").trim().toLowerCase();
  let tiers: AffixTier[];
  if (tierRaw === "all") {
    tiers = [...ALL_TIERS];
  } else if (tierRaw) {
    const requested = tierRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as string[];
    const picked = requested.filter((p): p is AffixTier => (ALL_TIERS as string[]).includes(p));
    tiers = picked.length > 0 ? picked : affixTierForTone(tone);
  } else {
    tiers = affixTierForTone(tone);
  }

  const fixedPrefixRaw = (params["prefix"] ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const fixedSuffixRaw = (params["suffix"] ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  // 长度上限从词库动态算，避免词库扩容后 hardcode 的 5/6 把合法词缀误杀
  const maxAffixLen = Math.max(
    ...ALL_TIERS.flatMap((t) => [
      ...AFFIX_BRAND_BANK[t].prefix,
      ...AFFIX_BRAND_BANK[t].suffix,
    ]).map((w) => w.length),
    6,
  );
  const fixedPrefix =
    fixedPrefixRaw.length >= 1 && fixedPrefixRaw.length <= maxAffixLen ? fixedPrefixRaw : "";
  const fixedSuffix =
    fixedSuffixRaw.length >= 1 && fixedSuffixRaw.length <= maxAffixLen ? fixedSuffixRaw : "";

  const sideRaw = (params["side"] ?? "").trim().toLowerCase();
  let side: "prefix" | "suffix" | "both";
  if (sideRaw === "prefix" || sideRaw === "suffix" || sideRaw === "both") {
    side = sideRaw;
  } else if (fixedPrefix && !fixedSuffix) {
    side = "prefix";
  } else if (fixedSuffix && !fixedPrefix) {
    side = "suffix";
  } else {
    side = "both";
  }

  return {
    keywords,
    tiers,
    fixedPrefix: fixedPrefix || null,
    fixedSuffix: fixedSuffix || null,
    side,
  };
}

/** 收集指定档位的前缀/后缀，去重并保持档位先后 */
function collectAffixTokens(
  tiers: AffixTier[],
  side: "prefix" | "suffix",
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tiers) {
    for (const raw of AFFIX_BRAND_BANK[t][side]) {
      const k = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * 根据用户关键词与分档词缀生成候选（合并自 compound / brand_prefix）。
 *
 * - `keywords` 为空时返回空数组（零产出，不做 slug 回退）；
 * - `fixedPrefix` / `fixedSuffix` 一经指定则优先走相应单侧；
 * - 否则按 tier 选出的 prefix/suffix 全表枚举；
 * - 避免 keyword 已以缀词开头/结尾时重复拼接（如 keyword=buildly + suffix=ly）；
 * - 所有候选都过一次 `passesReadability`。
 */
export function buildAffixBrandCandidates(
  req: DomainRequirements,
  paramsStr: string | undefined,
  max = 1000,
): Candidate[] {
  const parsed = parseAffixBrandParams(paramsStr, req.tone);
  if (parsed.keywords.length === 0) return [];
  if (parsed.tiers.length === 0) return [];

  const excludes = req.excludes.map((e) => e.toLowerCase()).filter(Boolean);
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const tryPush = (label: string) => {
    if (!passesReadability(label, req.tone)) return;
    pushLabel(out, seen, excludes, label, "affix_brand", max);
  };

  const prefixes = parsed.fixedPrefix
    ? [parsed.fixedPrefix]
    : collectAffixTokens(parsed.tiers, "prefix");
  const suffixes = parsed.fixedSuffix
    ? [parsed.fixedSuffix]
    : collectAffixTokens(parsed.tiers, "suffix");

  const wantPrefix = parsed.side !== "suffix";
  const wantSuffix = parsed.side !== "prefix";

  for (const kw of parsed.keywords) {
    if (wantPrefix) {
      for (const p of prefixes) {
        if (out.length >= max) return out;
        if (kw.startsWith(p)) continue; // keyword 已以该前缀开头，避免 propro*
        tryPush(`${p}${kw}`);
      }
    }
    if (wantSuffix) {
      for (const s of suffixes) {
        if (out.length >= max) return out;
        if (kw.endsWith(s)) continue; // keyword 已以该后缀结尾，避免 *lyly
        tryPush(`${kw}${s}`);
      }
    }
  }

  return out;
}
