import {
  affiliateRegistrarFromCheckSource,
  buildAffiliateUrl,
} from "@/lib/domains/affiliate";
import { USD_TO_CNY } from "@/lib/domains/currency-fx";
import { scoreAndSelectRegisteredDomainsWithAi } from "@/lib/domains/ai-refine";
import {
  buildAffixBrandCandidates,
  buildCandidates,
  buildPrefixExpansionCandidates,
  buildWordComboCandidates,
  normalizeRegistrableSuffix,
  parseWordComboParams,
} from "@/lib/domains/candidate-generator";
import { checkDomainsRealtime } from "@/lib/domains/checkers/orchestrator";
import type {
  DomainAvailabilityStatus,
  DomainGenerateResponse,
  DomainRequirements,
  DomainResultItem,
  RegistrationTier,
} from "@/types/domain";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import type { ParsedStrategy } from "@/lib/chat/parse-action";
import { requestRetryStrategies } from "@/lib/chat/request-strategies";
import type { GenerateProgressEvent } from "@/lib/domains/generate-progress";

export type { ParsedStrategy };

function firstYearPriceCny(det: DomainCheckDetail): number {
  const price = det.price > 0 ? det.price : 0;
  if (det.currency === "CNY") return price;
  return Math.round(price * USD_TO_CNY * 100) / 100;
}

function firstYearPriceUsd(det: DomainCheckDetail): number {
  const price = det.price > 0 ? det.price : 0;
  if (det.currency === "USD") return price;
  return Math.round((price / USD_TO_CNY) * 100) / 100;
}

function tierFromCheck(d: DomainCheckDetail): RegistrationTier {
  if (!d.available) return "normal";
  if (d.isPremium && d.price >= 800) return "ultra-premium";
  if (d.isPremium) return "premium";
  return "normal";
}

function availabilityFromCheck(d: DomainCheckDetail): DomainAvailabilityStatus {
  if (!d.available) return "taken";
  if (d.isPremium) return "premium";
  return "available";
}

/** 与 `buildCandidates` 分支一致。未知策略名直接丢弃，避免被静默映射到 word_combo 后又因缺 `word=` 参数零产出 */
const CANDIDATE_STRATEGY_HINTS = new Set([
  "word_combo",
  "affix_brand",
  "creative_spelling",
  "metaphor",
  "portmanteau",
  "tld_hack",
  "number_combo",
  "pinyin_syllable",
  "markov_syllable",
  "repeat_syllable",
  "cross_lang",
  // AI 直出主名：params 里 words=xxx,yyy,... 本身就是最终候选 SLD，
  // 不再走规则拼接；由 buildCandidates 的同名分支收词 + 统一过滤后送检
  "ai_direct",
]);

/**
 * 返回合法策略名；未知名返回 null（调用方应 skip 该策略）。
 * 原先兜底为 `word_combo` 的做法会把 AI 的笔误静默当成 word_combo，又因
 * 缺 word= 参数实际零产出，问题无法暴露；现在直接跳过并让日志明确记录。
 */
function resolveCandidateStrategyHint(aiStrategyName: string): string | null {
  return CANDIDATE_STRATEGY_HINTS.has(aiStrategyName) ? aiStrategyName : null;
}

/**
 * 将 `ai_direct` 稳定挪到列表最前，保证对话模型直出的主名最先展开、最先送检，
 * 从而在全局 80/160 池与检测上限上优先占位；其余策略相对顺序不变。
 */
function prioritizeAiDirectStrategies(list: ParsedStrategy[]): ParsedStrategy[] {
  const direct: ParsedStrategy[] = [];
  const rest: ParsedStrategy[] = [];
  for (const s of list) {
    if (s.name === "ai_direct") direct.push(s);
    else rest.push(s);
  }
  return [...direct, ...rest];
}

/** 5.2：按策略累积「可注册且在预算内」的完整域名，达到此数则不再执行后续策略 */
const RAW_REGISTRABLE_CAP_PRIMARY = 80;

/** 兜底换策略阶段允许再累积一批，避免首轮已满 80 条但 AI 筛选后过少时无法补仓 */
const RAW_REGISTRABLE_CAP_WITH_FALLBACK = 160;

/** 单策略批次内最多送检的完整 FQDN 数 */
const MAX_CHECK_PER_BATCH = 220;

// ---------- word_combo 新管线 & 前缀扩容 的编排常量 ----------
/** word_combo「攒够即停」的目标：可注册且预算内条数 */
const WORD_COMBO_TARGET_AVAILABLE = 80;
/** 单次 generate 总检测硬上限（跨策略累计，防止单次任务过长） */
const GLOBAL_CHECK_LIMIT = 500;
/** 单次 generate 的墙钟时间上限，超时停止发新检测 */
const GENERATE_WALLCLOCK_MS = 180_000; // 3 分钟；与 GLOBAL_CHECK_LIMIT 二选一先触顶即停
/** word_combo 单个 word 空转保护：检测 ≥ 60 条且新增可注册 < 2 时跳词 */
const WORDCOMBO_STALL_MIN_CHECKED = 60;
const WORDCOMBO_STALL_MIN_NEW = 2;
/** 前缀扩容触发阈值：主阶段结束后可注册且预算内数 < 此值才扩容 */
const PREFIX_EXPAND_TRIGGER = 10;
/** word_combo 检测时每批送检的 FQDN 数（每批 2 次 CF Registrar 调用，检测粒度适中）*/
const WORDCOMBO_BATCH_SIZE = 40;

const MIN_RESULTS_BEFORE_FALLBACK = 5;

const MAX_AI_RETRY_ROUNDS = 2;

const DEFAULT_SUFFIXES = [".com", ".ai", ".io"];

function userRegistrableSuffixes(req: DomainRequirements): string[] {
  return (req.suffixes?.length ? req.suffixes : DEFAULT_SUFFIXES).map(normalizeRegistrableSuffix);
}

function fqdnEndsWithUserSuffix(fqdn: string, normSuffixes: readonly string[]): boolean {
  const lower = fqdn.toLowerCase();
  return normSuffixes.some((sfx) => lower.endsWith(sfx) && lower.length > sfx.length);
}

function isLockedFqdn(h: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h.trim());
}

function isPlainLabel(h: string): boolean {
  const k = h.toLowerCase();
  return (
    k.length >= 2 &&
    k.length <= 20 &&
    !k.includes(".") &&
    !k.includes("-") &&
    /^[a-z0-9]+$/.test(k)
  );
}

function stripLongestKnownSuffix(host: string, suffixesNorm: string[]): string | null {
  const h = host.trim().toLowerCase();
  const sorted = [...suffixesNorm].sort((a, b) => b.length - a.length);
  for (const sfx of sorted) {
    if (h.endsWith(sfx) && h.length > sfx.length) return h.slice(0, -sfx.length);
  }
  return null;
}

/**
 * 规则/模型产出统一成「主名」或一条须原样检测的锁定 FQDN（已对齐用户后缀白名单）。
 * 若误带可识别后缀（如 foo.com），则剥掉后缀得到主名 foo。
 */
function normalizeGenerationToken(
  raw: string,
  suffixesNorm: string[],
): { mode: "label"; label: string } | { mode: "locked_fqdn"; fqdn: string } | null {
  const h0 = raw.trim().toLowerCase();
  if (!h0) return null;

  if (!h0.includes(".")) {
    const label = h0.replace(/[^a-z0-9]/g, "");
    return isPlainLabel(label) ? { mode: "label", label } : null;
  }

  const stripped = stripLongestKnownSuffix(h0, suffixesNorm);
  if (stripped && !stripped.includes(".")) {
    const label = stripped.replace(/[^a-z0-9]/g, "");
    return isPlainLabel(label) ? { mode: "label", label } : null;
  }

  if (isLockedFqdn(h0) && fqdnEndsWithUserSuffix(h0, suffixesNorm)) {
    return { mode: "locked_fqdn", fqdn: h0 };
  }

  return null;
}

function expandTokenToFqdns(
  token: NonNullable<ReturnType<typeof normalizeGenerationToken>>,
  suffixesNorm: string[],
  seenHosts: Set<string>,
): string[] {
  const out: string[] = [];
  if (token.mode === "locked_fqdn") {
    const f = token.fqdn;
    if (!seenHosts.has(f)) out.push(f);
    return out;
  }
  const k = token.label;
  for (const sfx of suffixesNorm) {
    const fq = `${k}${sfx}`;
    if (!seenHosts.has(fq)) out.push(fq);
  }
  return out;
}

function sldFromFqdn(fqdn: string): string {
  const i = fqdn.lastIndexOf(".");
  if (i <= 0) return fqdn.toLowerCase();
  return fqdn.slice(0, i).toLowerCase();
}

export interface GenerationOptions {
  seed: number;
  locale: "en" | "zh";
  strategies?: ParsedStrategy[];
  executedStrategyKeys?: Set<string>;
  historyDomains?: Set<string>;
  onProgress?: (ev: GenerateProgressEvent) => void | Promise<void>;
  /** 与 HTTP `Request.signal` 对齐：中止后不再向客户端写进度，并让检测层尽快停接新域名。 */
  abortSignal?: AbortSignal;
  /** 与 `logs/ai-interactions.jsonl` 中 `domain_check_route` 与 generate 流关联 */
  checkLogContext?: { sessionId?: string };
}

export async function runDomainGeneration(
  req: DomainRequirements,
  options: GenerationOptions,
): Promise<
  DomainGenerateResponse & {
    executedKeys: string[];
    fallbackRoundsUsed: number;
    totalChecked: number;
    totalTaken: number;
    totalOverBudget: number;
    advisoryMessage?: string;
  }
> {
  return _runDomainGenerationImpl(req, options);
}

/**
 * 内部実装。runDomainGeneration の fetch 予算コンテキスト内で実行される。
 */
async function _runDomainGenerationImpl(
  req: DomainRequirements,
  options: GenerationOptions,
): Promise<
  DomainGenerateResponse & {
    executedKeys: string[];
    fallbackRoundsUsed: number;
    totalChecked: number;
    totalTaken: number;
    totalOverBudget: number;
    advisoryMessage?: string;
  }
> {
  const { seed, locale } = options;
  const historyDomains = options.historyDomains ?? new Set<string>();
  const executedStrategyKeys = options.executedStrategyKeys ?? new Set<string>();

  const rawStrategies = options.strategies ?? [];
  if (rawStrategies.length === 0) {
    throw new Error("至少需要一组由 AI 给出的生成策略（strategies 不能为空）。");
  }

  const strategies = prioritizeAiDirectStrategies(
    rawStrategies.filter((s) => !executedStrategyKeys.has(s.key)),
  );

  const executedKeys: string[] = [];
  const usedStrategiesSet = new Set<string>();
  const seenHosts = new Set<string>(historyDomains);
  const emit = async (ev: GenerateProgressEvent) => {
    if (options.abortSignal?.aborted) return;
    if (options.onProgress) await options.onProgress(ev);
  };

  let totalGenerated = 0;
  let totalChecked = 0;
  let totalTaken = 0;
  let totalOverBudget = 0;

  /** word_combo / 前缀扩容使用：主阶段里 taken 的主名集合（SLD），作为扩容基底 */
  const occupiedSlds = new Set<string>();
  /** 单次 generate 的墙钟起点，用于 GENERATE_WALLCLOCK_MS 超时保护 */
  const wallStart = Date.now();
  /** 是否已触顶：墙钟或全局检测上限 */
  const limitsReached = () =>
    totalChecked >= GLOBAL_CHECK_LIMIT || Date.now() - wallStart >= GENERATE_WALLCLOCK_MS;

  const rawByDomain = new Map<string, DomainResultItem>();
  let rawCap = RAW_REGISTRABLE_CAP_PRIMARY;

  function appendRawItems(items: DomainResultItem[]) {
    for (const it of items) {
      if (rawByDomain.size >= rawCap) return;
      const k = it.domain.toLowerCase();
      if (rawByDomain.has(k)) continue;
      rawByDomain.set(k, it);
      seenHosts.add(k);
    }
  }

  function buildItemFromCheck(
    host: string,
    det: DomainCheckDetail,
    strategy: string,
    batchReq: DomainRequirements,
  ): DomainResultItem | null {
    const availability = availabilityFromCheck(det);
    if (availability === "taken") return null;

    const priceCny = firstYearPriceCny(det);
    const priceUsd = firstYearPriceUsd(det);
    const cap = batchReq.maxFirstYearBudgetAmount;
    const inBudget =
      cap === 0
        ? true
        : batchReq.budgetCurrency === "CNY"
          ? priceCny <= cap
          : priceUsd <= cap;
    if (!inBudget) return null;

    const score = 0;

    const tier = tierFromCheck(det);
    const price =
      det.price > 0
        ? det.price
        : availability === "available" && det.currency === "USD"
          ? 12.99
          : 0;
    const renewal =
      det.renewalPrice > 0
        ? det.renewalPrice
        : price > 0
          ? Math.round(price * 1.15 * 100) / 100
          : 0;

    const strategyLine =
      availability === "premium"
        ? `${strategy}: premium / aftermarket pricing — still registrable via registrar.`
        : `${strategy}: fits your brief; checked via ${det.source}.`;

    const affiliateRegistrar = affiliateRegistrarFromCheckSource(det.source);

    return {
      domain: host,
      score,
      reason: strategyLine,
      strategy,
      registration: {
        price,
        renewalPrice: renewal,
        currency: det.currency,
        tier,
      },
      registrar: affiliateRegistrar,
      affiliateUrl: buildAffiliateUrl(host, affiliateRegistrar),
      availability,
    };
  }

  /**
   * 5.2：主名归一 → 去重 → 拼用户后缀 → 注册商检测 → 预算过滤（不做 AI 精炼）。
   */
  async function runAvailabilityPassForStrategy(
    batchReq: DomainRequirements,
    batchSeed: number,
    strategyHint: string,
    paramsHint: string | undefined,
    strategyMeta: ParsedStrategy,
  ): Promise<void> {
    const suffixesNorm = userRegistrableSuffixes(batchReq);
    const candidates = buildCandidates(
      batchReq,
      batchSeed,
      MAX_CHECK_PER_BATCH + 80,
      strategyHint,
      paramsHint,
    );
    totalGenerated += candidates.length;
    await emit({ phase: "candidates", count: candidates.length });

    const labelToStrategy = new Map<string, string>();
    const lockedFqdnToStrategy = new Map<string, string>();
    for (const c of candidates) {
      const tok = normalizeGenerationToken(c.host, suffixesNorm);
      if (!tok) continue;
      if (tok.mode === "locked_fqdn") {
        lockedFqdnToStrategy.set(tok.fqdn.toLowerCase(), c.strategy);
      } else {
        labelToStrategy.set(tok.label, c.strategy);
      }
    }

    const uniqueFqdns: string[] = [];
    const fqdnSeen = new Set<string>();
    for (const c of candidates) {
      const tok = normalizeGenerationToken(c.host, suffixesNorm);
      if (!tok) continue;
      for (const fq of expandTokenToFqdns(tok, suffixesNorm, seenHosts)) {
        const k = fq.toLowerCase();
        if (fqdnSeen.has(k)) continue;
        fqdnSeen.add(k);
        uniqueFqdns.push(fq);
        if (uniqueFqdns.length >= MAX_CHECK_PER_BATCH) break;
      }
      if (uniqueFqdns.length >= MAX_CHECK_PER_BATCH) break;
    }

    // 与 word_combo 管线一致：发起检测前按剩余全局配额截断，避免单策略一次性把 600 超掉
    const remainingGlobal = GLOBAL_CHECK_LIMIT - totalChecked;
    const checkTargets =
      remainingGlobal > 0 ? uniqueFqdns.slice(0, remainingGlobal) : [];

    await emit({
      phase: "expand_ready",
      uniqueLabels: labelToStrategy.size + lockedFqdnToStrategy.size,
      fqdnCount: checkTargets.length,
    });

    if (!checkTargets.length) {
      await emit({ phase: "batch_done", newInBatch: 0 });
      return;
    }

    const resolveStrategy = (fqdn: string): string => {
      const lower = fqdn.toLowerCase();
      if (lockedFqdnToStrategy.has(lower)) return lockedFqdnToStrategy.get(lower)!;
      return labelToStrategy.get(sldFromFqdn(lower)) ?? strategyMeta.name;
    };

    const checks = await checkDomainsRealtime(checkTargets, batchReq.market, {
      signal: options.abortSignal,
      locale,
      checkLogContext: options.checkLogContext,

      onCheckProgress: async ({ done, total, host }) => {
        if (done !== 1 && done !== total && done % 12 !== 0) return;
        await emit({ phase: "check_progress", done, total, host });
      },
    });
    totalChecked += checkTargets.length;

    const batchItems: DomainResultItem[] = [];
    let batchTaken = 0;
    let batchOverBudget = 0;

    for (const host of checkTargets) {
      const hkey = host.toLowerCase();
      const det = checks.get(hkey);
      if (!det) continue;

      const availability = availabilityFromCheck(det);
      if (availability === "taken") {
        totalTaken += 1;
        batchTaken += 1;
        seenHosts.add(hkey);
        occupiedSlds.add(sldFromFqdn(hkey));
        continue;
      }

      const priceCny = firstYearPriceCny(det);
      const priceUsd = firstYearPriceUsd(det);
      const cap = batchReq.maxFirstYearBudgetAmount;
      const inBudget =
        cap === 0
          ? true
          : batchReq.budgetCurrency === "CNY"
            ? priceCny <= cap
            : priceUsd <= cap;
      if (!inBudget) {
        if (availability === "premium") {
          totalOverBudget += 1;
          batchOverBudget += 1;
        }
        seenHosts.add(hkey);
        continue;
      }

      const st = resolveStrategy(host);
      usedStrategiesSet.add(st);
      const item = buildItemFromCheck(host, det, st, batchReq);
      seenHosts.add(hkey);
      if (item) batchItems.push(item);
    }

    appendRawItems(batchItems);

    await emit({
      phase: "check_done",
      checked: checkTargets.length,
      newAvailable: batchItems.length,
      taken: batchTaken,
      overBudget: batchOverBudget,
    });
    await emit({ phase: "batch_done", newInBatch: batchItems.length });
  }

  /**
   * word_combo 新管线：必填 word + curated bank 双向遍历 + 边查边停。
   *
   * 与 `runAvailabilityPassForStrategy` 的关键差异：
   * - 候选由 `buildWordComboCandidates` 直接产出（不走随机种子，完全按词表遍历）；
   * - 分批送检，每一批实时累计「可注册且预算内」数，达 WORD_COMBO_TARGET_AVAILABLE 即停；
   * - 空转保护：某个 word 已检 ≥ 60 条、新增可注册 < 2 条 → 跳词；
   * - 墙钟/全局检测上限触顶即停。
   */
  async function runWordComboPipeline(strategyMeta: ParsedStrategy): Promise<void> {
    const suffixesNorm = userRegistrableSuffixes(req);
    const parsed = parseWordComboParams(strategyMeta.params, req.tone);
    if (parsed.words.length === 0) {
      // 让前端的 "candidates / batch_done" 计数对齐：参数不合法时也要显式发 0 事件，
      // 而不是跳过中间 phase 让进度条错位
      await emit({ phase: "candidates", count: 0 });
      await emit({ phase: "batch_done", newInBatch: 0 });
      return;
    }

    // 对每个 word 独立生成候选并检测；在编排层统计 available/checked，达标立即停
    for (const word of parsed.words) {
      if (limitsReached()) break;
      if (rawByDomain.size >= WORD_COMBO_TARGET_AVAILABLE) break;

      const singleWordMeta: ParsedStrategy = {
        ...strategyMeta,
        params: `word=${word}${
          strategyMeta.params.includes("pool=")
            ? "+" + strategyMeta.params.split("+").find((p) => p.startsWith("pool="))
            : ""
        }`,
      };
      const candidates = buildWordComboCandidates(req, singleWordMeta.params);
      totalGenerated += candidates.length;
      await emit({ phase: "candidates", count: candidates.length });

      // 展开到 FQDN 并去重（已在历史里出现过的 hkey 跳过）
      const fqdns: string[] = [];
      const fqdnSeen = new Set<string>();
      for (const c of candidates) {
        for (const sfx of suffixesNorm) {
          const fq = `${c.host}${sfx}`.toLowerCase();
          if (seenHosts.has(fq) || fqdnSeen.has(fq)) continue;
          fqdnSeen.add(fq);
          fqdns.push(fq);
        }
      }

      await emit({
        phase: "expand_ready",
        uniqueLabels: candidates.length,
        fqdnCount: fqdns.length,
      });

      // 逐批检测、实时统计、空转保护
      let wordChecked = 0;
      let wordNewAvailable = 0;
      for (let i = 0; i < fqdns.length; i += WORDCOMBO_BATCH_SIZE) {
        if (limitsReached()) break;
        if (rawByDomain.size >= WORD_COMBO_TARGET_AVAILABLE) break;

        const remainingGlobal = GLOBAL_CHECK_LIMIT - totalChecked;
        if (remainingGlobal <= 0) break;

        const slice = fqdns
          .slice(i, i + WORDCOMBO_BATCH_SIZE)
          .slice(0, remainingGlobal);
        if (slice.length === 0) break;

        const checks = await checkDomainsRealtime(slice, req.market, {
          signal: options.abortSignal,
          locale,
          checkLogContext: options.checkLogContext,

          onCheckProgress: async ({ done, total, host }) => {
            if (done !== 1 && done !== total && done % 12 !== 0) return;
            await emit({ phase: "check_progress", done, total, host });
          },
        });
        totalChecked += slice.length;
        wordChecked += slice.length;

        const batchItems: DomainResultItem[] = [];
        let batchTaken = 0;
        let batchOverBudget = 0;
        for (const host of slice) {
          const det = checks.get(host);
          if (!det) continue;
          const availability = availabilityFromCheck(det);
          if (availability === "taken") {
            totalTaken += 1;
            batchTaken += 1;
            seenHosts.add(host);
            occupiedSlds.add(sldFromFqdn(host));
            continue;
          }
          const priceCny = firstYearPriceCny(det);
          const priceUsd = firstYearPriceUsd(det);
          const cap = req.maxFirstYearBudgetAmount;
          const inBudget =
            cap === 0
              ? true
              : req.budgetCurrency === "CNY"
                ? priceCny <= cap
                : priceUsd <= cap;
          if (!inBudget) {
            if (availability === "premium") {
              totalOverBudget += 1;
              batchOverBudget += 1;
            }
            seenHosts.add(host);
            continue;
          }
          usedStrategiesSet.add("word_combo");
          const item = buildItemFromCheck(host, det, "word_combo", req);
          seenHosts.add(host);
          if (item) batchItems.push(item);
        }

        appendRawItems(batchItems);
        wordNewAvailable += batchItems.length;

        await emit({
          phase: "check_done",
          checked: slice.length,
          newAvailable: batchItems.length,
          taken: batchTaken,
          overBudget: batchOverBudget,
        });

        // 空转保护：某个 word 已查 ≥ 60、仍几乎没有可用 → 跳词
        if (
          wordChecked >= WORDCOMBO_STALL_MIN_CHECKED &&
          wordNewAvailable < WORDCOMBO_STALL_MIN_NEW
        ) {
          break;
        }
      }

      await emit({ phase: "batch_done", newInBatch: wordNewAvailable });
    }
  }

  /**
   * 前缀扩容：主阶段结束后若可注册且预算内 < PREFIX_EXPAND_TRIGGER，
   * 对 occupiedSlds（被占主名）逐一加前缀后再检测，往 rawByDomain 里补仓。
   */
  async function runPrefixExpansionPipeline(): Promise<void> {
    if (limitsReached()) return;
    if (rawByDomain.size >= WORD_COMBO_TARGET_AVAILABLE) return;
    if (occupiedSlds.size === 0) return;

    const suffixesNorm = userRegistrableSuffixes(req);
    const candidates = buildPrefixExpansionCandidates(req, occupiedSlds);
    if (candidates.length === 0) return;
    totalGenerated += candidates.length;
    await emit({ phase: "candidates", count: candidates.length });

    const fqdns: string[] = [];
    const fqdnSeen = new Set<string>();
    for (const c of candidates) {
      for (const sfx of suffixesNorm) {
        const fq = `${c.host}${sfx}`.toLowerCase();
        if (seenHosts.has(fq) || fqdnSeen.has(fq)) continue;
        fqdnSeen.add(fq);
        fqdns.push(fq);
      }
    }

    await emit({
      phase: "expand_ready",
      uniqueLabels: candidates.length,
      fqdnCount: fqdns.length,
    });

    let runChecked = 0;
    let runNewAvailable = 0;
    for (let i = 0; i < fqdns.length; i += WORDCOMBO_BATCH_SIZE) {
      if (limitsReached()) break;
      if (rawByDomain.size >= WORD_COMBO_TARGET_AVAILABLE) break;

      const remainingGlobal = GLOBAL_CHECK_LIMIT - totalChecked;
      if (remainingGlobal <= 0) break;
      const slice = fqdns
        .slice(i, i + WORDCOMBO_BATCH_SIZE)
        .slice(0, remainingGlobal);
      if (slice.length === 0) break;

      const checks = await checkDomainsRealtime(slice, req.market, {
        signal: options.abortSignal,
        locale,
        checkLogContext: options.checkLogContext,

        onCheckProgress: async ({ done, total, host }) => {
          if (done !== 1 && done !== total && done % 12 !== 0) return;
          await emit({ phase: "check_progress", done, total, host });
        },
      });
      totalChecked += slice.length;
      runChecked += slice.length;

      const batchItems: DomainResultItem[] = [];
      let batchTaken = 0;
      let batchOverBudget = 0;
      for (const host of slice) {
        const det = checks.get(host);
        if (!det) continue;
        const availability = availabilityFromCheck(det);
        if (availability === "taken") {
          totalTaken += 1;
          batchTaken += 1;
          seenHosts.add(host);
          continue;
        }
        const priceCny = firstYearPriceCny(det);
        const priceUsd = firstYearPriceUsd(det);
        const cap = req.maxFirstYearBudgetAmount;
        const inBudget =
          cap === 0
            ? true
            : req.budgetCurrency === "CNY"
              ? priceCny <= cap
              : priceUsd <= cap;
        if (!inBudget) {
          if (availability === "premium") {
            totalOverBudget += 1;
            batchOverBudget += 1;
          }
          seenHosts.add(host);
          continue;
        }
        usedStrategiesSet.add("word_combo_prefix_expand");
        const item = buildItemFromCheck(host, det, "word_combo_prefix_expand", req);
        seenHosts.add(host);
        if (item) batchItems.push(item);
      }

      appendRawItems(batchItems);
      runNewAvailable += batchItems.length;
      await emit({
        phase: "check_done",
        checked: slice.length,
        newAvailable: batchItems.length,
        taken: batchTaken,
        overBudget: batchOverBudget,
      });

      // 扩容空转保护：已检 60+ 条但几乎没新增可用 → 别继续烧全局配额
      if (
        runChecked >= WORDCOMBO_STALL_MIN_CHECKED &&
        runNewAvailable < WORDCOMBO_STALL_MIN_NEW
      ) {
        break;
      }
    }
  }

  /**
   * affix_brand 新管线（合并自旧 compound / brand_prefix）。
   *
   * 与 word_combo 同样「边查边停 + 墙钟/全局上限 + 分批送检」，但候选由
   * `buildAffixBrandCandidates` 按 tier 词集 × keyword 一次性产出；
   * 整策略级的空转保护：已检 >= WORDCOMBO_STALL_MIN_CHECKED 且新增 < WORDCOMBO_STALL_MIN_NEW 即跳。
   */
  async function runAffixBrandPipeline(strategyMeta: ParsedStrategy): Promise<void> {
    const suffixesNorm = userRegistrableSuffixes(req);
    const candidates = buildAffixBrandCandidates(req, strategyMeta.params);
    if (candidates.length === 0) {
      await emit({ phase: "candidates", count: 0 });
      await emit({ phase: "batch_done", newInBatch: 0 });
      return;
    }
    totalGenerated += candidates.length;
    await emit({ phase: "candidates", count: candidates.length });

    const fqdns: string[] = [];
    const fqdnSeen = new Set<string>();
    for (const c of candidates) {
      for (const sfx of suffixesNorm) {
        const fq = `${c.host}${sfx}`.toLowerCase();
        if (seenHosts.has(fq) || fqdnSeen.has(fq)) continue;
        fqdnSeen.add(fq);
        fqdns.push(fq);
      }
    }

    await emit({
      phase: "expand_ready",
      uniqueLabels: candidates.length,
      fqdnCount: fqdns.length,
    });

    let runChecked = 0;
    let runNewAvailable = 0;

    for (let i = 0; i < fqdns.length; i += WORDCOMBO_BATCH_SIZE) {
      if (limitsReached()) break;
      if (rawByDomain.size >= WORD_COMBO_TARGET_AVAILABLE) break;

      const remainingGlobal = GLOBAL_CHECK_LIMIT - totalChecked;
      if (remainingGlobal <= 0) break;

      const slice = fqdns
        .slice(i, i + WORDCOMBO_BATCH_SIZE)
        .slice(0, remainingGlobal);
      if (slice.length === 0) break;

      const checks = await checkDomainsRealtime(slice, req.market, {
        signal: options.abortSignal,
        locale,
        checkLogContext: options.checkLogContext,

        onCheckProgress: async ({ done, total, host }) => {
          if (done !== 1 && done !== total && done % 12 !== 0) return;
          await emit({ phase: "check_progress", done, total, host });
        },
      });
      totalChecked += slice.length;
      runChecked += slice.length;

      const batchItems: DomainResultItem[] = [];
      let batchTaken = 0;
      let batchOverBudget = 0;
      for (const host of slice) {
        const det = checks.get(host);
        if (!det) continue;
        const availability = availabilityFromCheck(det);
        if (availability === "taken") {
          totalTaken += 1;
          batchTaken += 1;
          seenHosts.add(host);
          occupiedSlds.add(sldFromFqdn(host));
          continue;
        }
        const priceCny = firstYearPriceCny(det);
        const priceUsd = firstYearPriceUsd(det);
        const cap = req.maxFirstYearBudgetAmount;
        const inBudget =
          cap === 0
            ? true
            : req.budgetCurrency === "CNY"
              ? priceCny <= cap
              : priceUsd <= cap;
        if (!inBudget) {
          if (availability === "premium") {
            totalOverBudget += 1;
            batchOverBudget += 1;
          }
          seenHosts.add(host);
          continue;
        }
        usedStrategiesSet.add("affix_brand");
        const item = buildItemFromCheck(host, det, "affix_brand", req);
        seenHosts.add(host);
        if (item) batchItems.push(item);
      }

      appendRawItems(batchItems);
      runNewAvailable += batchItems.length;

      await emit({
        phase: "check_done",
        checked: slice.length,
        newAvailable: batchItems.length,
        taken: batchTaken,
        overBudget: batchOverBudget,
      });

      // 整策略级空转保护：已检 60+ 条但基本无可用 → 提前跳出，别把余量继续喂这条策略
      if (
        runChecked >= WORDCOMBO_STALL_MIN_CHECKED &&
        runNewAvailable < WORDCOMBO_STALL_MIN_NEW
      ) {
        break;
      }
    }

    await emit({ phase: "batch_done", newInBatch: runNewAvailable });
  }

  async function runStrategyList(list: ParsedStrategy[], cap: number, seedOffset: number) {
    rawCap = cap;
    for (let i = 0; i < list.length; i++) {
      if (rawByDomain.size >= rawCap) break;
      if (limitsReached()) break;

      const strategy = list[i]!;
      await emit({
        phase: "strategy",
        strategyName: strategy.name,
        strategyIndex: i,
        strategyTotal: list.length,
      });

      // word_combo / affix_brand 走各自的新管线（必填 keyword + 词集 + 边查边停）
      // 其它策略保留原有随机候选 + 批量检测路径。
      if (strategy.name === "word_combo") {
        await runWordComboPipeline(strategy);
      } else if (strategy.name === "affix_brand") {
        await runAffixBrandPipeline(strategy);
      } else {
        const strategyHint = resolveCandidateStrategyHint(strategy.name);
        if (!strategyHint) {
          console.warn(
            `[domain-generation] unknown strategy "${strategy.name}" from AI; skipping`,
          );
          await emit({ phase: "candidates", count: 0 });
          await emit({ phase: "batch_done", newInBatch: 0 });
        } else {
          const batchSeed = seed + seedOffset + i;
          await runAvailabilityPassForStrategy(
            req,
            batchSeed,
            strategyHint,
            strategy.params,
            strategy,
          );
        }
      }
      executedKeys.push(strategy.key);
    }
  }

  if (strategies.length > 0) {
    await runStrategyList(strategies, RAW_REGISTRABLE_CAP_PRIMARY, 0);
  }

  // 主阶段结束：若可注册且预算内 < PREFIX_EXPAND_TRIGGER，且存在被占主名，触发一次前缀扩容。
  // 这一步独立于 AI 重试策略，也在 AI 重试之前执行：先尝试用更便宜的方式（本地前缀 + 已有被占主名）补仓。
  if (rawByDomain.size < PREFIX_EXPAND_TRIGGER && occupiedSlds.size > 0 && !limitsReached()) {
    await emit({
      phase: "strategy",
      strategyName: "word_combo_prefix_expand",
      strategyIndex: 0,
      strategyTotal: 1,
    });
    await runPrefixExpansionPipeline();
  }

  let aiRetryRoundsUsed = 0;
  const runFallback = strategies.length > 0;

  if (runFallback) {
    for (let round = 0; round < MAX_AI_RETRY_ROUNDS; round++) {
      if (limitsReached()) break;
      const rawArr = [...rawByDomain.values()];
      if (rawArr.length >= MIN_RESULTS_BEFORE_FALLBACK) break;

      const retryPick = await requestRetryStrategies(req, locale, {
        executedKeys: [...executedStrategyKeys, ...executedKeys],
        triedCount: totalChecked,
        takenCount: totalTaken,
        premiumOverBudgetCount: totalOverBudget,
        retryRound: round,
      });
      if (!retryPick) break;

      rawCap = RAW_REGISTRABLE_CAP_WITH_FALLBACK;
      const retryStrategies = prioritizeAiDirectStrategies(retryPick.strategies);
      for (let i = 0; i < retryStrategies.length; i++) {
        if (rawByDomain.size >= rawCap) break;
        if (limitsReached()) break;
        const strategy = retryStrategies[i]!;
        await emit({
          phase: "strategy",
          strategyName: `${strategy.name} (retry ${round + 1})`,
          strategyIndex: i,
          strategyTotal: retryStrategies.length,
        });
        if (strategy.name === "word_combo") {
          await runWordComboPipeline(strategy);
        } else if (strategy.name === "affix_brand") {
          await runAffixBrandPipeline(strategy);
        } else {
          const strategyHint = resolveCandidateStrategyHint(strategy.name);
          if (!strategyHint) {
            console.warn(
              `[domain-generation] unknown retry strategy "${strategy.name}"; skipping`,
            );
            await emit({ phase: "candidates", count: 0 });
            await emit({ phase: "batch_done", newInBatch: 0 });
          } else {
            const batchSeed = seed + 10_000 * (round + 1) + i;
            await runAvailabilityPassForStrategy(
              req,
              batchSeed,
              strategyHint,
              strategy.params,
              strategy,
            );
          }
        }
        executedKeys.push(strategy.key);
      }
      aiRetryRoundsUsed += 1;
    }
  }

  const rawPool = [...rawByDomain.values()];
  let allAvailableItems: DomainResultItem[] = [];

  if (rawPool.length > 0) {
    await emit({ phase: "final_refine_start", fqdnCount: rawPool.length });
    allAvailableItems = await scoreAndSelectRegisteredDomainsWithAi(rawPool, req, locale);
    await emit({
      phase: "final_refine_done",
      generatedCount: rawPool.length,
      selectedCount: allAvailableItems.length,
      totalChecked,
    });
  } else {
    await emit({
      phase: "final_refine_done",
      generatedCount: 0,
      selectedCount: 0,
      totalChecked,
    });
  }

  allAvailableItems.sort((a, b) => b.score - a.score);

  let advisoryMessage: string | undefined;
  if (allAvailableItems.length === 0 && totalChecked > 0) {
    advisoryMessage = buildAdvisoryMessage({
      req,
      locale,
      totalChecked,
      totalTaken,
      totalOverBudget,
      executedStrategyCount: executedStrategyKeys.size + executedKeys.length,
    });
  }

  return {
    results: allAvailableItems,
    totalGenerated,
    totalAvailable: allAvailableItems.length,
    strategies: [...usedStrategiesSet],
    executedKeys,
    fallbackRoundsUsed: aiRetryRoundsUsed,
    totalChecked,
    totalTaken,
    totalOverBudget,
    advisoryMessage,
  };
}

function buildAdvisoryMessage(args: {
  req: DomainRequirements;
  locale: "en" | "zh";
  totalChecked: number;
  totalTaken: number;
  totalOverBudget: number;
  executedStrategyCount: number;
}): string {
  const {
    req,
    locale,
    totalChecked,
    totalTaken,
    totalOverBudget,
    executedStrategyCount,
  } = args;
  const suffixes = req.suffixes?.length ? req.suffixes : [".com"];
  const suffixList = suffixes.join(", ");
  const cap = req.maxFirstYearBudgetAmount;
  const curSymbol = req.budgetCurrency === "CNY" ? "¥" : "$";
  const budgetText = cap > 0 ? `${curSymbol}${cap}` : locale === "zh" ? "未限定" : "unlimited";

  if (locale === "zh") {
    const lines: string[] = [];
    lines.push(
      `我已经用 ${executedStrategyCount} 组不同策略尝试了 **${totalChecked}** 个候选域名，但在您给定的后缀 **${suffixList}** 与预算 **${budgetText}** 范围内，没有找到可以立刻注册的域名。`,
    );
    const reasonBits: string[] = [];
    if (totalTaken > 0) reasonBits.push(`${totalTaken} 个已被他人注册`);
    if (totalOverBudget > 0) reasonBits.push(`${totalOverBudget} 个是溢价（premium）且超出预算`);
    if (reasonBits.length) lines.push(`其中 ${reasonBits.join("，")}。`);
    lines.push("");
    lines.push("您可以调整一下需求让我继续：");
    const tips: string[] = [];
    tips.push(`- **放宽后缀**：在 ${suffixList} 之外再加 .net / .co / .xyz / .app 等，可用空间会大幅扩大；`);
    if (cap > 0) {
      tips.push(
        `- **提高预算**：目前上限是 ${curSymbol}${cap}，热门短词的 premium 价格多在 ${curSymbol}${Math.max(300, cap * 3)} 以上；`,
      );
    }
    tips.push(
      "- **调整关键词**：换一个更窄的业务词（比如从 \"english\" 改成 \"pronunciation / grammar / ielts\"），或者允许使用无语义的发明词；",
    );
    tips.push("- **直接告诉我**您更在意哪一点（短、品牌感、含姓名…），我会按新方向再试一轮。");
    lines.push(tips.join("\n"));
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    `I ran ${executedStrategyCount} different strategies and checked **${totalChecked}** candidate domains, but none were immediately registerable within your suffix set **${suffixList}** and budget **${budgetText}**.`,
  );
  const reasonBits: string[] = [];
  if (totalTaken > 0) reasonBits.push(`${totalTaken} are already registered`);
  if (totalOverBudget > 0) reasonBits.push(`${totalOverBudget} are premium and over your budget`);
  if (reasonBits.length) lines.push(`Of those, ${reasonBits.join(", ")}.`);
  lines.push("");
  lines.push("A few ways to unblock me:");
  const tips: string[] = [];
  tips.push(`- **Broaden the suffixes** — on top of ${suffixList}, allow .net / .co / .xyz / .app, etc.;`);
  if (cap > 0) {
    tips.push(
      `- **Raise the budget** — popular short-word combos often sit above ${curSymbol}${Math.max(300, cap * 3)} as premium;`,
    );
  }
  tips.push(
    "- **Tweak the keyword** — try a narrower niche term (e.g. switch \"english\" to \"pronunciation / grammar / ielts\"), or allow invented words;",
  );
  tips.push(
    "- Or just tell me which trade-off you're okay with (short vs. branded vs. contains your name), and I'll try another round.",
  );
  lines.push(tips.join("\n"));
  return lines.join("\n");
}
