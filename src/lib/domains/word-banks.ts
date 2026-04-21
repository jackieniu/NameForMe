/** Curated word lists for rule-based domain candidate generation. */

// ---------------------------------------------------------------------------
// affix_brand 策略的分档词库（取代旧 PREFIXES / SUFFIXES / BRAND_PREFIXES /
// BRAND_SUFFIXES 四张扁平表）。
//
// 设计原则：
//   - 仅保留「词缀 + 业务核心词」一条路，唯一策略 = affix_brand。
//   - 按调性分四档，每档内部再区分 prefix / suffix，避免过长：单词 2–5 字母为主。
//   - 禁用方位词（north/east）、比例词（macro/micro）、拼音类（wo/ni/hao），
//     这些在旧词表里是噪声来源。
//   - 与 word_combo 的 CURATED_POSITIVE_BANK 不重合（后者是「意义向」词，
//     这里是「功能/品牌」缀），避免两种策略产物同质化。
//   - `all` 由 `affixTierForTone("any")` 返回的合并结果，不单独枚举维护。
// ---------------------------------------------------------------------------

export type AffixTier = "tech" | "saas" | "playful" | "elegant";

export const AFFIX_BRAND_BANK: Record<
  AffixTier,
  { readonly prefix: readonly string[]; readonly suffix: readonly string[] }
> = {
  tech: {
    prefix: [
      "pro", "neo", "meta", "core", "prime", "hyper", "omni", "cyber",
      "data", "dev", "node", "code", "byte", "edge", "auto", "open",
    ],
    suffix: [
      "hq", "lab", "labs", "hub", "grid", "stack", "ops", "sync",
      "core", "engine", "logic", "base", "net", "dev", "cloud", "ai",
    ],
  },
  saas: {
    prefix: [
      "get", "go", "try", "use", "make", "run", "now", "just",
      "all", "ever", "any", "open", "set",
    ],
    suffix: [
      "ly", "ify", "hq", "hub", "kit", "app", "box", "works",
      "forge", "flow", "desk", "deck", "base", "yard",
    ],
  },
  playful: {
    prefix: [
      "my", "hey", "our", "lil", "big", "super", "hello", "yo",
      "ah", "oh", "happy", "fun",
    ],
    suffix: [
      "nest", "pop", "buddy", "pals", "bee", "kin", "folk", "club",
      "zone", "party", "loop", "dash", "box", "mate",
    ],
  },
  elegant: {
    prefix: [
      "pure", "true", "ever", "mono", "solo", "one", "open", "prime",
      "core", "noble",
    ],
    suffix: [
      "studio", "house", "works", "craft", "edit", "room", "press",
      "review", "co", "goods",
    ],
  },
};

/**
 * 按 tone 选默认档位。
 * - 单个 tone 返回一个档；any / 未显式设置返回全四档（合并去重由上层完成）。
 * - 产品侧显式参数 `tier=` 会覆盖该函数结果。
 */
export function affixTierForTone(tone: string | undefined): AffixTier[] {
  const t = (tone ?? "any").toLowerCase();
  switch (t) {
    case "professional":
    case "tech":
      return ["tech"];
    case "playful":
    case "casual":
      return ["playful"];
    case "elegant":
    case "luxury":
    case "fashion":
      return ["elegant"];
    case "any":
    default:
      return ["saas"]; // 最中性的一档；tier=all 才合并四档
  }
}

// ---------------------------------------------------------------------------
// 历史扁平词表（VERBS / NOUNS / ADJECTIVES / METAPHOR_TOKENS /
// PORTMANTEAU_WORDS / TLD_HACK_PAIRS）已全部下线：
//   - 策略已改为「AI 必须显式提供 word / keyword / token / base / ...」，
//     不再由代码层按随机/固定词表兜底，避免生成结果与用户需求脱钩；
//   - 原有词表既未被候选生成引用、也未被 prompt 引用，保留只会增加维护
//     负担并误导后续改动。
// 如需恢复某一条路径，应在该策略单独维护一份主题化词表，而不是重新
// 引入通用扁平词表。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pinyin syllables (initials + finals for double/triple pinyin combos)
// ---------------------------------------------------------------------------
export const PINYIN_INITIALS = [
  "b", "p", "m", "f",
  "d", "t", "n", "l",
  "g", "k", "h",
  "j", "q", "x",
  "zh", "ch", "sh", "r",
  "z", "c", "s",
  "y", "w",
] as const;

export const PINYIN_FINALS = [
  "a", "o", "e", "i", "u",
  "ai", "ei", "ui", "ao", "ou", "iu",
  "ie", "ue", "er",
  "an", "en", "in", "un",
  "ang", "eng", "ing", "ong",
  "ia", "iao", "ian", "iang", "iong",
  "ua", "uo", "uai", "uan", "uang",
] as const;

// PINYIN_ROOTS 词表已下线：pinyin_syllable 策略统一要求 AI 显式提供
// `anchor=` + `initials=`/`finals=`，不再依赖一份固定拼音词表进行兜底采样。

// ---------------------------------------------------------------------------
// Markov syllable table — transition-based pronounceable syllable generation
// onset → nucleus → coda  buckets
// ---------------------------------------------------------------------------
export const MARKOV_ONSETS = [
  "b","bl","br","c","cl","cr","d","dr",
  "f","fl","fr","g","gl","gr",
  "j","k","l","m","n","p","pl","pr",
  "r","s","sc","sk","sl","sm","sn","sp","st","str","sw",
  "t","tr","v","w","y","z",
  // light onsets
  "", "sh","ch","th","wh","ph",
] as const;

export const MARKOV_NUCLEI = [
  "a","e","i","o","u",
  "ai","ay","ee","ea","ie","oo","ou","ue",
] as const;

// MARKOV_CODAS 曾用于 markov_syllable 三段式生成，现在策略只在 seed 后
// 追加「onset + nucleus」两段，不再使用 coda，词表整体下线。

// ---------------------------------------------------------------------------
// Curated positive bank — word_combo 新管线使用
// 规则：
//   - 全部为正向/中性、读音顺口的常见英文词；长度 3–9。
//   - 允许一词多档（同一个词可以同时出现在多个分类中）。
//   - 不限制每类数量：好域名难注册，覆盖面越广越能对冲占用率。
//   - tone 映射（在 candidate-generator 里）：
//       professional/tech     → value + place
//       playful               → motion + nature
//       elegant/luxury        → value + nature
//       any / 未显式设置      → 四类全开
// ---------------------------------------------------------------------------
export type CuratedPositiveCategory = "value" | "motion" | "place" | "nature";

export const CURATED_POSITIVE_BANK: Record<CuratedPositiveCategory, readonly string[]> = {
  value: [
    "bright", "smart", "clear", "calm", "prime", "swift", "pure", "true",
    "grand", "loud", "sharp", "bold", "fresh", "deep", "wide", "quick",
    "rapid", "keen", "fine", "neat", "solid", "royal", "noble", "elite",
    "sleek", "clean", "crisp", "vivid", "sunny", "lively", "warm", "brave",
    "wise", "kind", "gentle", "loyal", "free", "strong", "safe", "steady",
    "sure", "rich", "able", "ready", "great", "peak", "top",
    "lucky", "epic", "ever", "evergreen", "primeval",
  ],
  motion: [
    "build", "grow", "spark", "flow", "launch", "rise", "boost", "craft",
    "forge", "ship", "send", "push", "pull", "lift", "ride", "run",
    "jump", "leap", "race", "dash", "swift", "glide", "climb", "dive",
    "reach", "soar", "charge", "drive", "thrive", "bloom", "shine", "beam",
    "pulse", "wave", "stream", "flash", "burst", "snap", "tap", "zoom",
    "fly", "fuel", "power", "kick", "turn", "spin", "move",
    "shift", "blend", "merge", "join", "link", "connect", "create", "make",
    "bring", "give", "share", "help",
  ],
  place: [
    "studio", "works", "lab", "labs", "yard", "base", "hub", "forge",
    "harbor", "nest", "hive", "dock", "deck", "gate", "path", "lane",
    "line", "grid", "mesh", "stack", "cloud", "vault", "atlas", "compass",
    "anchor", "bridge", "tower", "court", "square", "plaza", "room", "house",
    "home", "station", "depot", "camp", "cabin", "loft", "bay", "port",
    "shore", "ridge", "peak", "summit", "field", "garden", "park", "ground",
    "zone", "space", "circle", "nook", "den", "haven", "hearth", "forum",
    "arena", "theater", "workshop", "kitchen",
  ],
  nature: [
    "ember", "aurora", "cedar", "river", "spark", "orbit", "pulse", "pearl",
    "stone", "flame", "beam", "pixel", "signal", "thread", "node", "core",
    "wave", "tide", "ocean", "sea", "sun", "moon", "star", "sky",
    "cloud", "storm", "dawn", "dusk", "bloom", "leaf", "petal", "root",
    "branch", "grove", "forest", "meadow", "valley", "canyon", "glacier", "comet",
    "nova", "nebula", "quartz", "onyx", "opal", "jade", "amber", "coral",
    "sage", "basil", "mint", "clove", "ivy", "maple", "willow", "aspen",
    "birch", "spruce", "falcon", "orca", "panda", "heron", "otter", "lynx",
    "phoenix", "griffin", "dragon", "tiger", "eagle", "hawk",
  ],
};

/**
 * 按 tone 获取默认启用的分类集合。
 * - 若用户在 word_combo 参数里显式指定 `pool=value,place`，则覆盖此函数的结果。
 */
export function curatedPoolsForTone(tone: string | undefined): CuratedPositiveCategory[] {
  const t = (tone ?? "any").toLowerCase();
  switch (t) {
    case "professional":
    case "tech":
      return ["value", "place"];
    case "playful":
      return ["motion", "nature"];
    case "elegant":
    case "luxury":
      return ["value", "nature"];
    case "any":
    default:
      return ["value", "motion", "place", "nature"];
  }
}

// ---------------------------------------------------------------------------
// Curated prefix bank — 前缀扩容使用
// 规则：
//   - 仅当主阶段「可注册且预算内 < 10」时，对「被占用主名」逐个尝试加前缀。
//   - 按调性分层；tone=any 时两档合并。
//   - 产物长度上限 ≤ 16；品牌形态不佳（空壳/过长）的主名不扩容。
// ---------------------------------------------------------------------------
export type CuratedPrefixTier = "professional" | "playful";

export const CURATED_PREFIX_BANK: Record<CuratedPrefixTier, readonly string[]> = {
  professional: [
    "pro", "next", "plus", "prime", "neo", "meta", "true", "peak",
    "open", "core", "hyper", "omni", "uni", "ultra",
  ],
  playful: [
    "my", "the", "good", "hey", "our", "go", "try", "get",
    "just", "now", "big", "super", "hello",
  ],
};

export function prefixTiersForTone(tone: string | undefined): CuratedPrefixTier[] {
  const t = (tone ?? "any").toLowerCase();
  switch (t) {
    case "professional":
    case "tech":
    case "elegant":
    case "luxury":
      return ["professional"];
    case "playful":
      return ["playful"];
    case "any":
    default:
      return ["professional", "playful"];
  }
}
