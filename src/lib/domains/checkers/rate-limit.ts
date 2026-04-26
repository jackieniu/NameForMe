/**
 * 进程级令牌桶，统一控制对阿里云 CheckDomain 的整体 QPS。
 *
 * 背景：阿里云文档声明单账号（含子账号）合计 **10 QPS** 硬上限。
 * 本项目全平台共用一个主账号，因此这是一个跨请求、跨用户共享的硬限。
 *
 * **粒度：fetch 维度**（每次真正发到 `domain.aliyuncs.com` 的 CheckDomain 调用都取 1 令牌）。
 * 历史上曾尝试「按域名」取令牌，但 `aliyunCheckDomain` 内部对同一域名可能连打 2–3
 * 次（首查带 FeeCurrency=CNY、非溢价补 create、needed 时补 renew），在高并发下实际
 * 峰值 QPS = 桶速率 × 子请求数，会轻易越过 10 QPS 硬限触发 `Throttling.User`。
 *
 * **自适应降速**（`reportCheckDomainThrottle`）：
 * - 检测到阿里云返 `Throttling.User` 时，主动把当前速率**减半**（下限 2/s），并把桶
 *   清零，强制所有后续请求都等下一次补仓，相当于一次"软熔断"。
 * - 连续 `THROTTLE_QUIET_MS` 毫秒没有再碰到限流，开始每 `RECOVERY_STEP_MS` 毫秒把
 *   速率加回 1/s，直到恢复到 `BASE_RATE_PER_SECOND`。
 * - 这让偶发的尖峰 / 时钟漂移 / 别的系统借用同账号的叠加 QPS 都能被"动态避让"，
 *   而不是一撞限流就把整次业务打断。
 *
 * 进程级单例（模块作用域）。部署到多实例时再换 Redis 版令牌桶。
 */

const BASE_CAPACITY = 8;
/** 稳定期速率：阿里云 10 QPS 硬限留 20% 余量 */
const BASE_RATE_PER_SECOND = 8;
/** 降速下限：低于此值再降也没意义，留个兜底吞吐 */
const MIN_RATE_PER_SECOND = 2;
/** 最近一次限流后，至少安静这么久才开始恢复 */
const THROTTLE_QUIET_MS = 10_000;
/** 恢复阶段：每隔这么久把速率加回 1/s */
const RECOVERY_STEP_MS = 5_000;
/** 补仓 tick，100ms 足够让 2–8/s 的分发感觉顺滑 */
const REFILL_TICK_MS = 100;

type BucketState = {
  /** 可以是浮点（支持小速率下的分数令牌累加） */
  tokens: number;
  lastRefillAt: number;
  waitQueue: Array<() => void>;
  /** 当前生效速率（tokens/s），会随限流事件动态下调并自动恢复 */
  currentRate: number;
  /** 最近一次观察到阿里云限流的时间戳（ms） */
  lastThrottleAt: number;
  /** 上一次"恢复速率 +1/s"的时间戳，用来控制 `RECOVERY_STEP_MS` 节奏 */
  lastRecoveryAt: number;
};

const globalAny = globalThis as unknown as {
  __nfm_aliyun_bucket?: BucketState;
  __nfm_aliyun_refill_timer?: ReturnType<typeof setInterval> | null;
};

function getBucket(): BucketState {
  if (!globalAny.__nfm_aliyun_bucket) {
    globalAny.__nfm_aliyun_bucket = {
      tokens: BASE_CAPACITY,
      lastRefillAt: Date.now(),
      waitQueue: [],
      currentRate: BASE_RATE_PER_SECOND,
      lastThrottleAt: 0,
      lastRecoveryAt: 0,
    };
  }
  return globalAny.__nfm_aliyun_bucket;
}

function refill(state: BucketState) {
  const now = Date.now();
  const elapsed = now - state.lastRefillAt;
  if (elapsed <= 0) return;
  const addable = (elapsed * state.currentRate) / 1000;
  if (addable <= 0) return;
  state.tokens = Math.min(BASE_CAPACITY, state.tokens + addable);
  state.lastRefillAt = now;
  while (state.tokens >= 1 && state.waitQueue.length > 0) {
    state.tokens -= 1;
    const next = state.waitQueue.shift();
    if (next) next();
  }
}

/**
 * 被限流后的恢复逻辑：安静期 ≥ THROTTLE_QUIET_MS 且距上次恢复 ≥ RECOVERY_STEP_MS，
 * 才把速率加回 1/s；恢复到基础速率后自然停步。
 */
function maybeRecover(state: BucketState) {
  if (state.currentRate >= BASE_RATE_PER_SECOND) return;
  const now = Date.now();
  if (now - state.lastThrottleAt < THROTTLE_QUIET_MS) return;
  if (state.lastRecoveryAt && now - state.lastRecoveryAt < RECOVERY_STEP_MS) return;
  state.currentRate = Math.min(BASE_RATE_PER_SECOND, state.currentRate + 1);
  state.lastRecoveryAt = now;
}

function ensureRefillLoop() {
  if (globalAny.__nfm_aliyun_refill_timer) return;
  const timer = setInterval(() => {
    const state = getBucket();
    refill(state);
    maybeRecover(state);
  }, REFILL_TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  globalAny.__nfm_aliyun_refill_timer = timer;
}

/** 异步获取一个令牌；未命中时挂到队列里，补充循环会逐个释放。 */
export function acquireCheckDomainSlot(): Promise<void> {
  const state = getBucket();
  refill(state);
  if (state.tokens >= 1) {
    state.tokens -= 1;
    ensureRefillLoop();
    return Promise.resolve();
  }
  ensureRefillLoop();
  return new Promise<void>((resolve) => {
    state.waitQueue.push(resolve);
  });
}

/**
 * 阿里云侧报告一次限流事件（`Throttling.User` / 429 / 503 等）：
 * - 当前速率减半（不低于 MIN_RATE_PER_SECOND）；
 * - 桶清零，让所有在途请求都走一次补仓等待，避免立即再次撞限流；
 * - 记录时间戳，后续 `maybeRecover` 以此判断何时开始恢复。
 *
 * 幂等且廉价：同一阵限流里被连续调用多次也只会把速率压到下限。
 */
export function reportCheckDomainThrottle(): void {
  const state = getBucket();
  refill(state);
  const next = Math.max(MIN_RATE_PER_SECOND, Math.floor(state.currentRate / 2));
  state.currentRate = next;
  state.tokens = 0;
  state.lastThrottleAt = Date.now();
  state.lastRecoveryAt = 0;
  ensureRefillLoop();
}
