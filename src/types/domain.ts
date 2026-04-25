/** Aligns with PRD domain generate / check responses */

export type DomainMarket = "cn" | "us" | "both";
export type DomainTone =
  | "professional"
  | "playful"
  | "tech"
  | "elegant"
  | "luxury"
  | "any";
export type DomainSyllable = "punchy" | "smooth" | "any";

/** 问卷货币：中文界面用人民币档位；英文界面用美元档位（互不换算） */
export type BudgetCurrency = "CNY" | "USD";

/** 首年最高可接受注册价（人民币），按数量级分档；`0` 表示不设上限 */
export type MaxFirstYearBudgetCny =
  | 100
  | 1000
  | 10000
  | 100000
  | 0;

/** 首年最高可接受注册价（美元），按数量级分档；`0` 表示不设上限 */
export type MaxFirstYearBudgetUsd = 10 | 100 | 1000 | 10000 | 0;

/** AI 策略名对应的候选生成器分支（与 [[STRATEGIES:...]] 中的 name 对齐） */
export type NamingStyle =
  | "word_combo"
  | "affix_brand"
  | "creative_spelling"
  | "metaphor"
  | "portmanteau"
  | "tld_hack"
  | "number_combo"
  | "pinyin_syllable"
  | "markov_syllable"
  | "repeat_syllable"
  | "cross_lang"
  | "ai_direct";

export type DomainRequirements = {
  /** 首页场景卡片带入的产品类型（只读展示用，提交时一并传给后端） */
  homeScenarioLabel?: string;
  description: string;
  market: DomainMarket;
  tone: DomainTone;
  syllable: DomainSyllable;
  suffixes: string[];
  budgetCurrency: BudgetCurrency;
  maxFirstYearBudgetAmount: MaxFirstYearBudgetCny | MaxFirstYearBudgetUsd;
  excludes: string[];
  /** Optional notes from follow-up chat */
  extraContext?: string;
};

export type RegistrationTier = "normal" | "premium" | "ultra-premium";
/** 用户可见的注册跳转目标（与域名检测 API 来源无关） */
export type RegistrarId = "aliyun" | "godaddy";

export type DomainAvailabilityStatus = "available" | "taken" | "premium";

export type DomainRegistration = {
  price: number;
  renewalPrice: number;
  currency: "USD" | "CNY";
  tier: RegistrationTier;
};

export type DomainResultItem = {
  domain: string;
  /** 0-100 综合质量分；最终由 AI 评委直接给出，前端按此排序与展示 */
  score: number;
  reason: string;
  strategy: string;
  registration: DomainRegistration;
  registrar: RegistrarId;
  affiliateUrl: string;
  availability: DomainAvailabilityStatus;
};

export type DomainGenerateResponse = {
  results: DomainResultItem[];
  totalGenerated: number;
  totalAvailable: number;
  strategies: string[];
  /**
   * 主策略组合跑完后若可用域名不足，后端会主动请 chat AI 重新出一组策略，
   * 然后再跑一次。该字段记录经历了多少次「让 AI 重新出策略」的轮数。
   */
  fallbackRoundsUsed?: number;
  /** 本次生成过程中实际向注册商发了可用性查询的 FQDN 总数 */
  totalChecked?: number;
  /** 其中被判定为「已被注册」的数量 */
  totalTaken?: number;
  /** 其中被判定为「premium 且超出用户预算」的数量 */
  totalOverBudget?: number;
  /**
   * 穷尽所有策略后仍然找不到任何可用域名时，后端给用户的一段诚实报告
   * （告知尝试了多少、主要原因、建议如何调整需求）。前端应以一条 assistant
   * 气泡的形式把它插入对话，让用户决定下一步。
   */
  advisoryMessage?: string;
};

export type FavoriteRecord = {
  id: string;
  domain: string;
  score: number;
  price: number;
  currency: string;
  savedAt: string;
  /** 保存时的注册跳转链接（旧数据可能为空） */
  affiliateUrl?: string;
  registrar?: RegistrarId;
};

/** 与 chat [[STRATEGIES:...]] 解析结果一致，供会话持久化 */
export type SessionStrategyEntry = {
  name: string;
  params: string;
  key: string;
};

/** 一次「搜索 / 生成域名」完整会话（localStorage） */
export type SearchSessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 列表标题：问卷描述截断 */
  title: string;
  requirements: DomainRequirements;
  /** useChat 消息快照（含助手侧策略标记等） */
  messages: unknown[];
  domains: DomainResultItem[];
  /** 待执行/已排队的策略（按 key 去重合并后的有序列表） */
  strategyQueue?: SessionStrategyEntry[];
  /** 已执行过的策略 key（与生成 API 去重一致） */
  executedStrategyKeys: string[];
  /** 已生成过的域名（小写，与 API historyDomains 一致） */
  historyDomains: string[];
};
