"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, generateId } from "ai";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { UIMessage } from "ai";
import { Copy, Loader2, Trash2 } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { ChatMarkdown } from "@/components/chat-markdown";
import { UiTooltip } from "@/components/ui-tooltip";
import { DomainQuestionnaire } from "@/components/domain-questionnaire";
import { formatQuestionnaireUserMessage } from "@/lib/chat/format-questionnaire-message";
import { CHAT_USER_MESSAGE_MAX_CHARS } from "@/lib/chat/limits";
import {
  parseChatAction,
  parseRequirementsOverride,
  snapBudgetAmount,
  stripActionMarkers,
} from "@/lib/chat/parse-action";
import {
  GEN_PROGRESS_MESSAGE_ID_PREFIX,
  isGenProgressUiMessage,
  stripAssistantProgressHallucination,
} from "@/lib/chat/strip-assistant-progress-hallucination";
import type { ParsedStrategy } from "@/lib/chat/parse-action";
import { addFavorite, isFavoriteDomain, listFavorites } from "@/lib/storage/favorites";
import { FAVORITES_CHANGED_EVENT } from "@/lib/storage/keys";
import {
  getSearchSession,
  sessionTitleFromRequirements,
  upsertSearchSession,
} from "@/lib/storage/search-sessions";
import type { GenerateProgressEvent } from "@/lib/domains/generate-progress";
import { isReadonlyProductScenario, type HomeScenarioValue } from "@/lib/home-scenario";
import { TurnstileHost, type TurnstileHostHandle } from "@/components/turnstile-host";
import {
  RateBudgetBadge,
  RateLimitBanner,
  notifyRateRefresh,
} from "@/components/rate-budget-badge";
import { RegistrarButtonRow } from "@/components/registrar-button-row";
import { formatRegistrationPriceLine, registrationFirstYearSortKey } from "@/lib/domains/price-display";
import type {
  DomainGenerateResponse,
  DomainRequirements,
  DomainResultItem,
} from "@/types/domain";
import { getOrCreateBrowserClientId } from "@/lib/browser-client-id";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeParsedStrategies(
  existing: ParsedStrategy[],
  incoming: ParsedStrategy[],
): ParsedStrategy[] {
  const keys = new Set(existing.map((s) => s.key));
  const out = [...existing];
  for (const s of incoming) {
    if (keys.has(s.key)) continue;
    keys.add(s.key);
    out.push(s);
  }
  return out;
}

function textFromParts(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function mergeDomainResults(
  existing: DomainResultItem[],
  incoming: DomainResultItem[],
): DomainResultItem[] {
  const map = new Map<string, DomainResultItem>();
  for (const r of existing) map.set(r.domain.toLowerCase(), r);
  for (const r of incoming) {
    const k = r.domain.toLowerCase();
    const prev = map.get(k);
    if (!prev || r.score > prev.score) map.set(k, r);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function hostLabelLength(domain: string): number {
  const i = domain.indexOf(".");
  return i === -1 ? domain.length : i;
}

function tldOf(domain: string): string {
  const i = domain.lastIndexOf(".");
  return i === -1 ? "" : domain.slice(i).toLowerCase();
}

/** 右侧列表关键词：按空格分词，各词均需在完整域名（FQDN）中出现（不区分大小写） */
function domainMatchesListKeyword(row: DomainResultItem, raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return true;
  const hay = row.domain.toLowerCase();
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => hay.includes(tok));
}

type SortKey =
  | "score-desc"
  | "score-asc"
  | "host-asc"
  | "host-desc"
  | "price-asc"
  | "price-desc";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SearchExperience({
  initialQuery,
  initialScenarioKey,
  initialSessionId,
  locale,
}: {
  initialQuery: string;
  initialScenarioKey?: HomeScenarioValue;
  /** 从搜索历史恢复完整会话（对话、域名列表、策略去重状态） */
  initialSessionId?: string;
  locale: string;
}) {
  const t = useTranslations("Search");
  const tw = useTranslations("Wizard");
  const router = useRouter();

  const [bootstrapDescription, setBootstrapDescription] = useState(() => initialQuery.trim());

  useEffect(() => {
    setBootstrapDescription(initialQuery.trim());
  }, [initialQuery]);

  type RestorePhase = "idle" | "loading" | "ready" | "missing";
  const [restorePhase, setRestorePhase] = useState<RestorePhase>(() =>
    initialSessionId ? "loading" : "idle",
  );

  const sessionIdRef = useRef<string | null>(null);
  const pendingSessionUrlRef = useRef<string | null>(null);
  const urlSyncedForSessionRef = useRef(false);
  const prevInitialSessionIdRef = useRef<string | undefined>(undefined);
  /** 问卷首条自动发送标记（必须挂在组件上；勿用模块级 Set，否则 StrictMode/HMR 会跳过 sendMessage 导致空对话） */
  const autoQuestionnaireSentRef = useRef<Set<number>>(new Set());

  // ---- Chat state ----
  const messagesRef = useRef<UIMessage[]>([]);
  const wizardReqRef = useRef<DomainRequirements | null>(null);
  const turnstileRef = useRef<TurnstileHostHandle>(null);
  const fingerprintRef = useRef("");
  const chatBlockRef = useRef<{
    code: string;
    retryAfterSec?: number;
    max?: number;
  } | null>(null);
  const [chatInputError, setChatInputError] = useState<string | null>(null);

  useEffect(() => {
    fingerprintRef.current = getOrCreateBrowserClientId();
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { locale },
        fetch: async (input, init) => {
          const res = await globalThis.fetch(input, init);
          if (!res.ok) {
            let parsed: { code?: string; retryAfterSec?: number; max?: number } = {};
            try {
              parsed = (await res.clone().json()) as typeof parsed;
            } catch {
              /* ignore */
            }
            chatBlockRef.current = parsed.code
              ? { code: parsed.code, retryAfterSec: parsed.retryAfterSec, max: parsed.max }
              : null;
          } else {
            chatBlockRef.current = null;
          }
          notifyRateRefresh();
          return res;
        },
        prepareSendMessagesRequest: async ({
          id,
          messages,
          body,
          headers,
          trigger,
          messageId,
        }) => {
          const token = (await turnstileRef.current?.getToken()) ?? "";
          const h =
            headers instanceof Headers
              ? Object.fromEntries(headers.entries())
              : Array.isArray(headers)
                ? Object.fromEntries(headers)
                : { ...(headers as Record<string, string>) };
          const fp = fingerprintRef.current;
          return {
            body: {
              ...body,
              id,
              messages,
              trigger,
              messageId,
              turnstileToken: token,
            },
            headers: fp ? { ...h, "X-NFM-Fingerprint": fp } : h,
          };
        },
      }),
    [locale],
  );

  const [wizardReq, setWizardReq] = useState<DomainRequirements | null>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "domains">("chat");
  const [submissionId, setSubmissionId] = useState(0);
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("score-desc");
  const [suffixFilter, setSuffixFilter] = useState<string>("");
  const [listKeywordFilter, setListKeywordFilter] = useState("");
  const [clearListOpen, setClearListOpen] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<DomainResultItem[]>([]);
  const accumulatedRef = useRef<DomainResultItem[]>([]);

  // Track session-level state for generation dedup
  const executedStrategyKeysRef = useRef<Set<string>>(new Set());
  const historyDomainsRef = useRef<Set<string>>(new Set());
  /** 待执行策略队列（会话内持久化；与 chat 新返回策略按 key 去重合并） */
  const strategyQueueRef = useRef<ParsedStrategy[]>([]);
  /** 初始策略解析失败时的静默重试计数（0 表示尚未重试） */
  const strategyParseRetryRef = useRef(0);

  // Generation progress shown in chat bubble
  const [genPhase, setGenPhase] = useState<
    "idle" | "generating" | "checking" | "scoring" | "done"
  >("idle");
  const genPhaseIdRef = useRef<string>("");
  /** 当前生成请求的 AbortController（fetch signal；可扩展为显式取消） */
  const genAbortRef = useRef<AbortController | null>(null);
  /** 串行执行多次「生成」，避免并发时后一批以空列表为基准合并导致覆盖上一批 */
  const generateQueueRef = useRef(Promise.resolve());

  wizardReqRef.current = wizardReq;

  useEffect(() => {
    const bump = () => setFavoritesVersion((v) => v + 1);
    window.addEventListener("storage", bump);
    window.addEventListener(FAVORITES_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener("storage", bump);
      window.removeEventListener(FAVORITES_CHANGED_EVENT, bump);
    };
  }, []);

  const removeDomainFromAccumulated = useCallback((domain: string) => {
    const d = domain.toLowerCase();
    setAccumulated((prev) => {
      const next = prev.filter((x) => x.domain.toLowerCase() !== d);
      accumulatedRef.current = next;
      return next;
    });
  }, []);

  // ---- Generation ----

  const injectAssistantBubble = useCallback(
    (id: string, text: string) => {
      setMessages((prev) => {
        const idx = (prev as UIMessage[]).findIndex((m) => m.id === id);
        const msg: UIMessage = {
          id,
          role: "assistant",
          parts: [{ type: "text", text }],
        };
        if (idx === -1) return [...(prev as UIMessage[]), msg];
        const copy = [...(prev as UIMessage[])];
        copy[idx] = msg;
        return copy;
      });
    },
    // setMessages comes from useChat; populated below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const runOneGenerate = useCallback(
    async (req: DomainRequirements) => {
      setGenError(null);

      if (!strategyQueueRef.current.length) {
        setGenError(t("generateMissingStrategies"));
        setGenPhase("idle");
        genPhaseIdRef.current = "";
        return;
      }

      /**
       * 生成 + 检测 + 评分：复用 **同一条** 助手气泡（loopBubbleId）就地更新。
       * 进度分母用前端累计的 expand_ready（多策略会相加）；**结束统计**只用后端
       * `final_refine_done` 的 `totalChecked` / `generatedCount` / `selectedCount`，避免与「累计待检测」口径混用。
       */
      /** 前缀须保留：`isGenProgressUiMessage` 依赖此从发给对话 AI 的历史中剔除 */
      const loopBubbleId = `${GEN_PROGRESS_MESSAGE_ID_PREFIX}${generateId()}`;
      genPhaseIdRef.current = loopBubbleId;
      setGenPhase("generating");
      injectAssistantBubble(loopBubbleId, t("genStarting"));

      /** 各批 expand_ready.fqdnCount 之和，用于检测进度分母 */
      let cumCandidates = 0;
      /** 各批 check_done.checked 之和；当前批进行中再加 check_progress.done */
      let cumCheckedCompleted = 0;
      let hasShownExpandHint = false;

      const refreshLoopBubble = (text: string) => {
        injectAssistantBubble(loopBubbleId, text);
        genPhaseIdRef.current = loopBubbleId;
      };

      const onExpandReady = (fqdnCount: number) => {
        cumCandidates += fqdnCount;
        if (!hasShownExpandHint && fqdnCount > 0) {
          hasShownExpandHint = true;
          refreshLoopBubble(t("genExpandHint"));
        }
      };

      const onCheckProgress = (batchDone: number) => {
        const cumDone = cumCheckedCompleted + batchDone;
        const denom = Math.max(cumCandidates, cumDone, 1);
        refreshLoopBubble(
          t("genChecking", {
            done: cumDone,
            total: denom,
          }),
        );
      };

      const showScoringStart = () => {
        refreshLoopBubble(t("genScoring"));
      };

      const showScoringDone = (ev: {
        generatedCount: number;
        selectedCount: number;
        totalChecked: number;
      }) => {
        refreshLoopBubble(
          t("genDoneSummary", {
            checked: ev.totalChecked,
            inPool: ev.generatedCount,
            picked: ev.selectedCount,
          }),
        );
      };

      const abortCtrl = new AbortController();
      genAbortRef.current = abortCtrl;

      try {
        const curMessages = messagesRef.current as UIMessage[];
        const contextMessages = curMessages.filter((m) => !isGenProgressUiMessage(m));
        const fp = fingerprintRef.current;
        const turnstileToken = (await turnstileRef.current?.getToken()) ?? "";

        // 注意：助手消息里可能含 [[ACTION:...]] 和 [[STRATEGIES:...]] 技术标记，
        // 这些是给程序读的，不应再灌给后端的 refine AI（否则会污染 slug 与提示词）。
        const extra = contextMessages
          .filter(
            (m) =>
              (m.role === "user" || m.role === "assistant") && !isGenProgressUiMessage(m),
          )
          .map((m) => {
            const tag = m.role === "user" ? "User" : "Assistant";
            const raw = textFromParts(m);
            const clean =
              m.role === "assistant" ? stripActionMarkers(raw).trim() : raw.trim();
            return clean ? `${tag}: ${clean}` : "";
          })
          .filter(Boolean)
          .join("\n")
          .trim()
          // 大模型长上下文下不再预压缩对话；仅限制单次请求体大小
          .slice(0, 12_000);

        const requirements: DomainRequirements = {
          ...req,
          extraContext: extra || undefined,
        };

        const res = await fetch("/api/domains/generate", {
          method: "POST",
          signal: abortCtrl.signal,
          headers: {
            "Content-Type": "application/json",
            ...(fp ? { "X-NFM-Fingerprint": fp } : {}),
          },
          body: JSON.stringify({
            requirements,
            locale,
            seed: Math.floor(Math.random() * 1e9),
            strategies: strategyQueueRef.current,
            executedStrategyKeys: [...executedStrategyKeysRef.current],
            historyDomains: [...historyDomainsRef.current],
            stream: true,
            turnstileToken,
          }),
        });

        notifyRateRefresh();

        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as {
            code?: string;
            retryAfterSec?: number;
            error?: string;
          } | null;
          setGenError(
            j?.code === "RATE_LIMIT"
              ? t("httpRateLimit", { sec: j.retryAfterSec ?? 60 })
              : j?.code === "SITE_DEGRADED"
                ? t("httpSiteBusy")
                : j?.code === "TURNSTILE_FAILED" || j?.code === "IP_BLOCKED"
                  ? t("httpAccessDenied")
                  : (j?.error ?? `HTTP ${res.status}`),
          );
          genPhaseIdRef.current = "";
          setGenPhase("idle");
          return;
        }

        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        let payload!: DomainGenerateResponse & { executedKeys?: string[] };

        const resBody = res.body;
        const isNdjsonStream =
          resBody != null &&
          (contentType.includes("ndjson") || contentType.includes("x-ndjson"));

        if (isNdjsonStream) {
          const reader = resBody.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let complete = false;

          type NdjsonLine =
            | { kind: "ready" }
            | { kind: "progress"; ev: GenerateProgressEvent }
            | {
                kind: "complete";
                payload: DomainGenerateResponse & { executedKeys?: string[] };
              }
            | { kind: "error"; error: string };

          const handleMsg = (msg: NdjsonLine) => {
            if (msg.kind === "error") throw new Error(msg.error);
            if (msg.kind === "ready") return;
            if (msg.kind === "complete") {
              payload = msg.payload;
              complete = true;
              return;
            }
            // progress
            const ev = msg.ev;
            switch (ev.phase) {
              case "expand_ready":
                onExpandReady(ev.fqdnCount);
                break;
              case "check_progress":
                onCheckProgress(ev.done);
                break;
              case "check_done":
                cumCheckedCompleted += ev.checked;
                break;
              case "final_refine_start":
                showScoringStart();
                break;
              case "final_refine_done":
                showScoringDone(ev);
                break;
              // strategy / candidates / batch_done: 不显示
              default:
                break;
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
              const i = buffer.indexOf("\n");
              if (i < 0) break;
              const line = buffer.slice(0, i).trim();
              buffer = buffer.slice(i + 1);
              if (!line) continue;
              handleMsg(JSON.parse(line) as NdjsonLine);
            }
          }
          const tail = buffer.trim();
          if (tail) handleMsg(JSON.parse(tail) as NdjsonLine);
          if (!complete) throw new Error("Empty generate stream");
        } else {
          payload = (await res.json()) as DomainGenerateResponse & {
            executedKeys?: string[];
          };
        }

        if (payload.executedKeys?.length) {
          for (const k of payload.executedKeys) executedStrategyKeysRef.current.add(k);
        }
        for (const r of payload.results) historyDomainsRef.current.add(r.domain.toLowerCase());

        flushSync(() => {
          setAccumulated((prev) => {
            const next = mergeDomainResults(prev, payload.results);
            accumulatedRef.current = next;
            return next;
          });
        });

        setGenPhase("done");

        const mergedLen = accumulatedRef.current.length;
        if (mergedLen === 0) {
          // 后端给出了「尝试了 N 个但都不可用，请调整需求」的诚实报告 → 作为一条
          // assistant 气泡插入对话；而不是让用户对着一个红色 noResults toast 发呆。
          if (payload.advisoryMessage) {
            injectAssistantBubble(generateId(), payload.advisoryMessage);
            setGenError(null);
          } else {
            setGenError(t("noResults"));
          }
        } else {
          setGenError(null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          setGenError(t("genInterrupted"));
        } else {
          setGenError(t("errorRetry"));
        }
        genPhaseIdRef.current = "";
        setGenPhase("idle");
      } finally {
        if (genAbortRef.current === abortCtrl) genAbortRef.current = null;
      }
    },
    [locale, t, injectAssistantBubble],
  );

  const doGenerate = useCallback(
    (req: DomainRequirements) => {
      generateQueueRef.current = generateQueueRef.current
        .then(() => runOneGenerate(req))
        .catch(() => {});
      void generateQueueRef.current;
    },
    [runOneGenerate],
  );

  // ---- useChat ----

  const { messages, sendMessage, status, error, clearError, setMessages } = useChat({
    transport,
    onFinish: ({ message }) => {
      const fullText = textFromParts(message as UIMessage);

      // Apply [[SUFFIXES:...]] / [[BUDGET:...|...]] overrides immediately so
      // that the subsequent doGenerate call already uses the updated params.
      const override = parseRequirementsOverride(fullText);
      if (wizardReqRef.current && (override.suffixes ?? override.budget)) {
        const base = wizardReqRef.current;
        const updated: DomainRequirements = {
          ...base,
          ...(override.suffixes ? { suffixes: override.suffixes } : {}),
          ...(override.budget
            ? {
                maxFirstYearBudgetAmount: snapBudgetAmount(
                  override.budget.amount,
                  base.budgetCurrency,
                ) as DomainRequirements["maxFirstYearBudgetAmount"],
              }
            : {}),
        };
        wizardReqRef.current = updated;
        setWizardReq(updated);
      }

      const action = parseChatAction(fullText);

      if (action.type === "GENERATE") {
        const req = wizardReqRef.current;
        if (!req) return;
        if (!action.strategies.length) {
          // 策略解析失败：静默向后端重试，最多 3 次
          const MAX_PARSE_RETRIES = 3;
          if (strategyParseRetryRef.current < MAX_PARSE_RETRIES) {
            strategyParseRetryRef.current += 1;
            const currentMessages = messagesRef.current;
            void (async () => {
              try {
                const res = await fetch("/api/chat/request-strategies", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ messages: currentMessages, locale }),
                });
                if (res.ok) {
                  const data = (await res.json()) as { strategies?: ParsedStrategy[] };
                  if (data.strategies?.length) {
                    strategyParseRetryRef.current = 0;
                    strategyQueueRef.current = mergeParsedStrategies(
                      strategyQueueRef.current,
                      data.strategies,
                    );
                    void doGenerate(req);
                    return;
                  }
                }
              } catch {
                // network error — fall through to show error on last attempt
              }
              // 最后一次重试也失败了，才告知用户
              if (strategyParseRetryRef.current >= MAX_PARSE_RETRIES) {
                strategyParseRetryRef.current = 0;
                injectAssistantBubble(generateId(), t("generateMissingStrategies"));
              }
            })();
          } else {
            strategyParseRetryRef.current = 0;
            injectAssistantBubble(generateId(), t("generateMissingStrategies"));
          }
          return;
        }
        strategyParseRetryRef.current = 0;
        strategyQueueRef.current = mergeParsedStrategies(
          strategyQueueRef.current,
          action.strategies,
        );
        void doGenerate(req);
      }
      // QUESTION: do nothing, wait for user to reply
    },
  });

  useEffect(() => {
    const incoming = initialSessionId?.trim() || undefined;
    const prev = prevInitialSessionIdRef.current;

    if (incoming) {
      if (sessionIdRef.current === incoming && wizardReq) {
        setRestorePhase("ready");
        prevInitialSessionIdRef.current = incoming;
        return;
      }
      setRestorePhase("loading");
      const s = getSearchSession(incoming);
      if (!s) {
        setMessages([]);
        sessionIdRef.current = null;
        pendingSessionUrlRef.current = null;
        urlSyncedForSessionRef.current = false;
        autoQuestionnaireSentRef.current = new Set();
        strategyQueueRef.current = [];
        setRestorePhase("missing");
        prevInitialSessionIdRef.current = incoming;
        return;
      }
      sessionIdRef.current = s.id;
      setWizardReq(s.requirements);
      setAccumulated(s.domains);
      accumulatedRef.current = s.domains;
      executedStrategyKeysRef.current = new Set(s.executedStrategyKeys);
      historyDomainsRef.current = new Set(s.historyDomains.map((x) => x.toLowerCase()));
      strategyQueueRef.current = (s.strategyQueue ?? []) as ParsedStrategy[];
      setMessages(s.messages as UIMessage[]);
      setSubmissionId(1);
      setGenError(null);
      setSuffixFilter("");
      setListKeywordFilter("");
      setSortKey("score-desc");
      setGenPhase("idle");
      setRestorePhase("ready");
      prevInitialSessionIdRef.current = incoming;
      return;
    }

    setRestorePhase("idle");

    if (prev && !incoming) {
      setWizardReq(null);
      setAccumulated([]);
      accumulatedRef.current = [];
      executedStrategyKeysRef.current = new Set();
      historyDomainsRef.current = new Set();
      strategyQueueRef.current = [];
      setMessages([]);
      sessionIdRef.current = null;
      pendingSessionUrlRef.current = null;
      urlSyncedForSessionRef.current = false;
      setSubmissionId(0);
      setGenPhase("idle");
      setGenError(null);
      setSuffixFilter("");
      setListKeywordFilter("");
      setSortKey("score-desc");
      autoQuestionnaireSentRef.current = new Set();
      prevInitialSessionIdRef.current = undefined;
      return;
    }

    if (!wizardReq) {
      setMessages([]);
      sessionIdRef.current = null;
      pendingSessionUrlRef.current = null;
      urlSyncedForSessionRef.current = false;
      autoQuestionnaireSentRef.current = new Set();
    }
    prevInitialSessionIdRef.current = incoming;
  }, [initialSessionId, setMessages, wizardReq]);

  useEffect(() => {
    const sid = pendingSessionUrlRef.current;
    if (!sid || !wizardReq) return;
    if (urlSyncedForSessionRef.current) return;
    const hasUser = (messages as UIMessage[]).some((m) => m.role === "user");
    if (!hasUser) return;
    urlSyncedForSessionRef.current = true;
    pendingSessionUrlRef.current = null;
    router.replace(`/search?sessionId=${encodeURIComponent(sid)}`);
  }, [messages, wizardReq, router]);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid || !wizardReq) return;
    const handle = window.setTimeout(() => {
      upsertSearchSession({
        id: sid,
        title: sessionTitleFromRequirements(wizardReq.description),
        requirements: wizardReq,
        messages: messagesRef.current as unknown[],
        domains: accumulatedRef.current,
        strategyQueue: strategyQueueRef.current.map((s) => ({
          name: s.name,
          params: s.params,
          key: s.key,
        })),
        executedStrategyKeys: [...executedStrategyKeysRef.current],
        historyDomains: [...historyDomainsRef.current],
      });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [wizardReq, messages, accumulated]);

  // Hide footer on mobile when in chat phase
  useEffect(() => {
    if (wizardReq) {
      document.body.setAttribute("data-chat-active", "");
    } else {
      document.body.removeAttribute("data-chat-active");
    }
    return () => {
      document.body.removeAttribute("data-chat-active");
    };
  }, [wizardReq]);

  // Strip markers from displayed messages
  const displayMessages = useMemo(
    () =>
      (messages as UIMessage[]).map((m) => {
        if (m.role !== "assistant") return m;
        const raw = textFromParts(m);
        const clean = stripActionMarkers(raw);
        const shown = isGenProgressUiMessage(m)
          ? clean
          : stripAssistantProgressHallucination(clean);
        if (shown === raw) return m;
        return {
          ...m,
          parts: [{ type: "text" as const, text: shown }],
        };
      }),
    [messages],
  );

  messagesRef.current = messages as UIMessage[];

  /**
   * 右侧域名列表当前条数：只由 `accumulated.length` 决定。
   * 生成合并、单项删除、清空列表等凡改动列表的操作，一律只更新 `accumulated`；
   * 标题与「列表是否为空」等展示只读此变量，不叠加 availability 等其它条件。
   */
  const domainListCount = useMemo(() => accumulated.length, [accumulated]);

  // ---- Auto-send questionnaire result as first user message ----

  useEffect(() => {
    if (!wizardReq || submissionId === 0) return;
    const text = formatQuestionnaireUserMessage(wizardReq, tw as (key: string) => string);
    const msgs = messages as UIMessage[];
    if (msgs.some((m) => m.role === "user" && textFromParts(m).trim() === text.trim())) {
      autoQuestionnaireSentRef.current.add(submissionId);
      return;
    }
    if (autoQuestionnaireSentRef.current.has(submissionId)) return;
    autoQuestionnaireSentRef.current.add(submissionId);
    // 仅 sendMessage：`sendMessage` 会追加用户消息；不要再 `setMessages([...])` 否则同一条会显示两次
    void sendMessage({ text });
  }, [submissionId, wizardReq, sendMessage, tw, messages]);

  // 生成结束不再追加「列表中共有 N 个域名」总结气泡——终态由 `final_refine_done`
  // 的「本次共生成 X 个…精选 Z 个…」气泡承担。
  useEffect(() => {
    if (genPhase === "done") {
      genPhaseIdRef.current = "";
    }
  }, [genPhase]);

  // ---- Other UI state ----

  const favoriteDomains = useMemo(() => {
    void favoritesVersion;
    return new Set(listFavorites().map((f) => f.domain.toLowerCase()));
  }, [favoritesVersion]);

  const uniqueTlds = useMemo(() => {
    const s = new Set<string>();
    for (const r of accumulated) {
      const tld = tldOf(r.domain);
      if (tld) s.add(tld);
    }
    return [...s].sort();
  }, [accumulated]);

  const filteredSortedDomains = useMemo(() => {
    let rows = accumulated.filter((r) => {
      if (suffixFilter && tldOf(r.domain) !== suffixFilter.toLowerCase()) return false;
      if (!domainMatchesListKeyword(r, listKeywordFilter)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "score-asc":
          return a.score - b.score;
        case "host-asc":
          return hostLabelLength(a.domain) - hostLabelLength(b.domain);
        case "host-desc":
          return hostLabelLength(b.domain) - hostLabelLength(a.domain);
        case "price-asc":
          return (
            registrationFirstYearSortKey(a.registration) -
            registrationFirstYearSortKey(b.registration)
          );
        case "price-desc":
          return (
            registrationFirstYearSortKey(b.registration) -
            registrationFirstYearSortKey(a.registration)
          );
        case "score-desc":
        default:
          return b.score - a.score;
      }
    });
    return rows;
  }, [accumulated, suffixFilter, sortKey, listKeywordFilter]);

  const chatSubmitting = status === "streaming" || status === "submitted";
  /** 仅在「已提交、尚未收到首段流」时显示思考中；streaming 时用助手气泡展示内容 */
  const showThinkingIndicator = status === "submitted";
  const isGenerating = genPhase === "generating";

  useEffect(() => {
    if (!clearListOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setClearListOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearListOpen]);

  const clearAccumulatedList = useCallback(() => {
    accumulatedRef.current = [];
    setAccumulated([]);
    setGenError(null);
    setSuffixFilter("");
    setListKeywordFilter("");
    setClearListOpen(false);
    genPhaseIdRef.current = "";
    setGenPhase("idle");
  }, []);

  const copyAllDomainNames = useCallback(async () => {
    const lines = accumulatedRef.current.map((r) => r.domain.trim()).filter(Boolean);
    const text = lines.join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // ---- Render ----

  return (
    <div
      className={`mx-auto flex w-full flex-col px-4 py-4 sm:px-6 sm:py-5 ${
        wizardReq
          ? // 对话阶段：在 main 内占满高度；须为 flex 列，子项 flex-1 的「双栏」才有限高可滚动
            "w-full min-h-0 max-w-screen-2xl flex-1 flex-col overflow-hidden"
          : // 问卷阶段：随内容自然撑高，允许整页滚动
            "max-w-3xl pb-8"
      }`}
    >
      <TurnstileHost ref={turnstileRef} />
      <div className="mb-3 shrink-0 flex items-center gap-2 sm:mb-4 sm:gap-3">
        <Link
          href="/"
          className="shrink-0 text-sm font-medium text-brand hover:underline"
        >
          ← {t("back")}
        </Link>
        {/* Mobile tab switcher — only shown in chat phase below lg breakpoint */}
        {wizardReq ? (
          <div className="flex flex-1 justify-center lg:hidden">
            <div className="flex rounded-full bg-surface-hover p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setMobileTab("chat")}
                className={`rounded-full px-3 py-1 font-medium transition-colors ${
                  mobileTab === "chat"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {t("chatColumnTitle")}
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("domains")}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-colors ${
                  mobileTab === "domains"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {t("domainsColumnTitle")}
                {domainListCount > 0 && (
                  <span className="rounded-full bg-brand/20 px-1.5 text-xs font-semibold text-brand leading-none py-0.5">
                    {domainListCount}
                  </span>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {/* 对话阶段手机端隐藏配额徽章，限流时由 RateLimitBanner 在 tab 下方提示 */}
        <div className={wizardReq ? "hidden lg:block" : ""}>
          <RateBudgetBadge />
        </div>
      </div>

      {initialSessionId && restorePhase === "loading" ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-sm text-muted">
          <Loader2 className="h-9 w-9 animate-spin text-brand" aria-hidden />
          <p>{t("sessionLoading")}</p>
        </div>
      ) : !wizardReq ? (
        <>
          {restorePhase === "missing" ? (
            <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {t("sessionMissing")}
            </p>
          ) : null}
          <DomainQuestionnaire
            initialDescription={bootstrapDescription}
            initialHomeScenarioKey={
              isReadonlyProductScenario(initialScenarioKey) ? initialScenarioKey : undefined
            }
            onComplete={(req) => {
              const sid = crypto.randomUUID();
              sessionIdRef.current = sid;
              pendingSessionUrlRef.current = sid;
              urlSyncedForSessionRef.current = false;
              upsertSearchSession({
                id: sid,
                title: sessionTitleFromRequirements(req.description),
                requirements: req,
                messages: [],
                domains: [],
                strategyQueue: [],
                executedStrategyKeys: [],
                historyDomains: [],
              });
              setSubmissionId((n) => n + 1);
              setWizardReq(req);
              setMobileTab("chat");
              accumulatedRef.current = [];
              setAccumulated([]);
              executedStrategyKeysRef.current = new Set();
              historyDomainsRef.current = new Set();
              strategyQueueRef.current = [];
              setGenError(null);
              setSuffixFilter("");
              setListKeywordFilter("");
              setSortKey("score-desc");
              setGenPhase("idle");
            }}
          />
        </>
      ) : (
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <RateLimitBanner />
          <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-hidden lg:flex-row lg:gap-6">
          {clearListOpen ? (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setClearListOpen(false);
              }}
            >
              <div
                className="w-full max-w-sm rounded-xl border border-black/[0.08] bg-white p-5 shadow-xl"
                role="alertdialog"
                aria-labelledby="clear-list-title"
                aria-describedby="clear-list-desc"
              >
                <p id="clear-list-title" className="text-base font-semibold text-foreground">
                  {t("clearListTitle")}
                </p>
                <p id="clear-list-desc" className="mt-2 text-sm text-muted">
                  {t("clearListBody")}
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-black/[0.1] bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-hover"
                    onClick={() => setClearListOpen(false)}
                  >
                    {t("clearListCancel")}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700"
                    onClick={clearAccumulatedList}
                  >
                    {t("clearListConfirm")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Chat column */}
          <section className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm ${mobileTab === "chat" ? "flex" : "hidden lg:flex"}`}>
            <h2 className="shrink-0 text-base font-semibold tracking-tight text-foreground">
              {t("chatColumnTitle")}
            </h2>
            <p className="mt-1 shrink-0 text-sm leading-relaxed text-muted">{t("chatColumnHint")}</p>
            <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
                {displayMessages.map((m) => {
                  const assistantText = m.role === "assistant" ? textFromParts(m) : "";
                  const isSystemGenBubble = m.role === "assistant" && isGenProgressUiMessage(m);
                  const showGenSpinner =
                    isSystemGenBubble &&
                    genPhase === "generating" &&
                    m.id === genPhaseIdRef.current;
                  return (
                    <div
                      key={m.id}
                      className={
                        m.role === "user"
                          ? "ml-4 rounded-xl bg-brand/10 px-3 py-2 text-sm text-foreground sm:ml-8"
                          : "mr-4 rounded-xl bg-surface-hover px-3 py-2 text-sm text-foreground sm:mr-8"
                      }
                      aria-busy={showGenSpinner ? true : undefined}
                    >
                      {m.role === "user" ? (
                        <div className="whitespace-pre-wrap">{textFromParts(m)}</div>
                      ) : showGenSpinner ? (
                        <div className="flex items-start gap-2">
                          <Loader2
                            className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-brand"
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <ChatMarkdown text={assistantText} />
                          </div>
                        </div>
                      ) : (
                        <ChatMarkdown text={assistantText} />
                      )}
                    </div>
                  );
                })}
                {showThinkingIndicator ? (
                  <div className="mr-4 flex items-center gap-2 rounded-xl bg-surface-hover px-3 py-2 text-sm text-muted sm:mr-8">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    {locale === "zh" ? "AI 思考中…" : "AI is thinking…"}
                  </div>
                ) : null}
              </div>

              {error ? (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {chatBlockRef.current?.code === "RATE_LIMIT"
                    ? t("httpRateLimit", {
                        sec: chatBlockRef.current.retryAfterSec ?? 60,
                      })
                    : chatBlockRef.current?.code === "CHAT_MESSAGE_TOO_LONG"
                      ? t("chatMessageTooLong", {
                          max: chatBlockRef.current.max ?? CHAT_USER_MESSAGE_MAX_CHARS,
                        })
                    : chatBlockRef.current?.code === "SITE_DEGRADED"
                      ? t("httpSiteBusy")
                      : chatBlockRef.current?.code === "TURNSTILE_FAILED" ||
                          chatBlockRef.current?.code === "IP_BLOCKED"
                        ? t("httpAccessDenied")
                        : t("errorRetry")}
                  <button
                    type="button"
                    className="ml-2 font-semibold underline"
                    onClick={() => {
                      chatBlockRef.current = null;
                      clearError();
                    }}
                  >
                    {t("errorDismiss")}
                  </button>
                </div>
              ) : null}

              {chatInputError ? (
                <p className="mt-2 text-sm text-red-600" role="alert">
                  {chatInputError}
                </p>
              ) : null}
              <form
                className="mt-3 shrink-0 flex flex-col gap-2 sm:flex-row"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const text = String(fd.get("chat-message") ?? "").trim();
                  if (!text) return;
                  if (text.length > CHAT_USER_MESSAGE_MAX_CHARS) {
                    setChatInputError(
                      t("chatMessageTooLong", { max: CHAT_USER_MESSAGE_MAX_CHARS }),
                    );
                    return;
                  }
                  setChatInputError(null);
                  void sendMessage({ text });
                  e.currentTarget.reset();
                }}
              >
                <input
                  name="chat-message"
                  placeholder={t("inputPlaceholder")}
                  maxLength={CHAT_USER_MESSAGE_MAX_CHARS}
                  onChange={() => setChatInputError(null)}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  disabled={chatSubmitting || isGenerating}
                  className="min-h-11 flex-1 rounded-xl border border-black/[0.06] bg-white px-3 text-sm text-foreground outline-none transition-[box-shadow,border-color] focus:border-brand/50 focus:ring-2 focus:ring-inset focus:ring-brand/35 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={chatSubmitting || isGenerating}
                  className="min-h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow disabled:opacity-50"
                >
                  {t("send")}
                </button>
              </form>
            </div>
          </section>

          {/* Domains column */}
          <section className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm ${mobileTab === "domains" ? "flex" : "hidden lg:flex"}`}>
            <div className="flex shrink-0 items-center justify-between gap-2">
              <h2 className="min-w-0 flex-1 text-base font-semibold tracking-tight text-foreground">
                {t("domainsColumnTitle")}
                <span className="ml-1 font-normal text-sm text-muted">
                  {t("domainsTitleCount", { count: domainListCount })}
                </span>
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                {domainListCount > 0 ? (
                  <>
                    <UiTooltip label={t("copyDomainsTooltip")}>
                      <button
                        type="button"
                        onClick={() => void copyAllDomainNames()}
                        className="rounded-lg p-1.5 text-muted transition-colors hover:bg-muted/40 hover:text-foreground"
                        aria-label={t("copyDomainsAria")}
                      >
                        <Copy className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                      </button>
                    </UiTooltip>
                    <UiTooltip label={t("clearListTooltip")}>
                      <button
                        type="button"
                        onClick={() => setClearListOpen(true)}
                        className="rounded-lg p-1.5 text-muted transition-colors hover:bg-red-50 hover:text-red-600"
                        aria-label={t("clearListAria")}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                      </button>
                    </UiTooltip>
                  </>
                ) : null}
              </div>
            </div>

            {genError && domainListCount === 0 ? (
              <p className="mt-3 text-sm text-red-600">{genError}</p>
            ) : null}

            {domainListCount > 0 ? (
              <div className="mt-3 shrink-0 rounded-xl border border-black/[0.06] bg-background p-2 sm:p-3">
                <div className="flex flex-nowrap items-center gap-x-2 gap-y-0 overflow-x-auto overscroll-x-contain pb-0.5 [-webkit-overflow-scrolling:touch] sm:flex-wrap sm:gap-x-4 sm:gap-y-2 sm:overflow-visible sm:pb-0">
                  <label className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-muted sm:min-w-[10rem] sm:max-w-[22rem] sm:basis-[14rem] sm:gap-2">
                    <span className="max-sm:sr-only sm:shrink-0 sm:whitespace-nowrap sm:text-sm">
                      {t("filterKeyword")}
                    </span>
                    <input
                      type="search"
                      value={listKeywordFilter}
                      onChange={(e) => setListKeywordFilter(e.target.value)}
                      placeholder={t("filterKeywordPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-[6rem] flex-1 rounded-lg border border-black/[0.08] bg-white px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted/70 focus:ring-2 focus:ring-brand/20 max-sm:min-w-[5.5rem] max-sm:py-1.5 max-sm:text-xs"
                    />
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted sm:gap-2">
                    <span className="max-sm:sr-only sm:shrink-0 sm:whitespace-nowrap sm:text-sm">
                      {t("filterSuffix")}
                    </span>
                    <select
                      value={suffixFilter}
                      onChange={(e) => setSuffixFilter(e.target.value)}
                      className="max-sm:w-[5.5rem] w-[4.75rem] shrink-0 rounded-lg border border-black/[0.08] bg-white py-2 pl-1.5 pr-6 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/20 max-sm:py-1.5 max-sm:text-xs sm:w-auto sm:min-w-0 sm:max-w-[12rem] sm:flex-1 sm:px-2"
                    >
                      <option value="">{t("filterSuffixAll")}</option>
                      {uniqueTlds.map((suf) => (
                        <option key={suf} value={suf}>
                          {suf}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted sm:min-w-0 sm:max-w-full sm:gap-2">
                    <span className="max-sm:sr-only sm:shrink-0 sm:whitespace-nowrap sm:text-sm">
                      {t("sortBy")}
                    </span>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="max-sm:w-[6.25rem] w-[5.25rem] shrink-0 rounded-lg border border-black/[0.08] bg-white py-2 pl-1.5 pr-6 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/20 max-sm:py-1.5 max-sm:text-xs sm:w-auto sm:min-w-0 sm:max-w-[12rem] sm:flex-1 sm:px-2"
                    >
                      <option value="score-desc">{t("sortScoreDesc")}</option>
                      <option value="score-asc">{t("sortScoreAsc")}</option>
                      <option value="host-desc">{t("sortHostDesc")}</option>
                      <option value="host-asc">{t("sortHostAsc")}</option>
                      <option value="price-desc">{t("sortPriceDesc")}</option>
                      <option value="price-asc">{t("sortPriceAsc")}</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col">
              <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
                {domainListCount === 0 && !isGenerating ? (
                  <li className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-muted">
                    {t("listEmpty")}
                  </li>
                ) : null}
                {domainListCount > 0 && filteredSortedDomains.length === 0 ? (
                  <li className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-muted">
                    {t("filterEmpty")}
                  </li>
                ) : null}
                {filteredSortedDomains.map((row) => (
                  <DomainCard
                    key={row.domain}
                    row={row}
                    locale={locale}
                    favorited={favoriteDomains.has(row.domain.toLowerCase())}
                    onStar={() => {
                      if (!isFavoriteDomain(row.domain)) {
                        addFavorite({
                          domain: row.domain,
                          score: row.score,
                          price: row.registration.price,
                          currency: row.registration.currency,
                          affiliateUrl: row.affiliateUrl,
                          registrar: row.registrar,
                        });
                      }
                      removeDomainFromAccumulated(row.domain);
                      setFavoritesVersion((v) => v + 1);
                    }}
                    onRemoveFromList={() => removeDomainFromAccumulated(row.domain)}
                  />
                ))}
              </ul>
            </div>
          </section>
        </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DomainCard
// ---------------------------------------------------------------------------

function DomainCard({
  row,
  locale,
  favorited,
  onStar,
  onRemoveFromList,
}: {
  row: DomainResultItem;
  locale: string;
  favorited: boolean;
  onStar: () => void;
  onRemoveFromList: () => void;
}) {
  const t = useTranslations("Search");
  const trashIconClass = "h-[18px] w-[18px]";

  const { tier } = row.registration;
  const tierNote =
    tier === "premium"
      ? t("registrationTierPremiumShort")
      : tier === "ultra-premium"
        ? t("registrationTierUltraShort")
        : "";
  const priceLine = formatRegistrationPriceLine(locale, row.registration, tierNote, t);

  return (
    <li className="rounded-xl border border-black/[0.06] bg-background p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-base font-semibold text-foreground">{row.domain}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-brand tabular-nums">{row.score}</p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">{row.reason}</p>
      <p className="mt-2 text-sm text-muted">{priceLine}</p>
      <div className="mt-2 flex flex-wrap items-stretch gap-2">
        <RegistrarButtonRow
          domain={row.domain}
          presentation="text"
          size="md"
          className="min-w-[14rem] flex-1 basis-[14rem]"
        />
        <div className="flex shrink-0 items-center gap-2">
          <UiTooltip label={t("favoriteFromListTooltip")}>
            <button
              type="button"
              onClick={onStar}
              className="rounded-lg border border-black/[0.08] bg-white p-1.5 text-success hover:border-emerald-300/60 hover:bg-emerald-50"
              aria-label={favorited ? t("unfavorite") : t("favorite")}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 16 16"
                fill={favorited ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M8 2.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 11.9l-3.52 1.85.67-3.93-2.85-2.78 3.94-.57L8 2.5z" />
              </svg>
            </button>
          </UiTooltip>
          <UiTooltip label={t("removeFromListTooltip")}>
            <button
              type="button"
              onClick={onRemoveFromList}
              className="rounded-lg border border-black/[0.08] bg-white p-1.5 text-muted hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              aria-label={t("removeFromList")}
            >
              <Trash2 className={trashIconClass} strokeWidth={1.75} aria-hidden />
            </button>
          </UiTooltip>
        </div>
      </div>
    </li>
  );
}
