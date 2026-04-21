import crypto from "node:crypto";
import { logAliyunCheckDomainFailure } from "@/lib/ai-logger";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import { getPorkbunTldRetailUsd } from "@/lib/domains/checkers/porkbun-pricing";
import {
  acquireCheckDomainSlot,
  backoffDelayMs,
  isThrottlingError,
  reportCheckDomainThrottle,
  sleep as rlSleep,
} from "@/lib/domains/checkers/rate-limit";

/**
 * 限流专用重试次数：配合 `reportCheckDomainThrottle` 的自适应降速，比普通错误更宽容；
 * base=1.5s 的指数退避配合 4 次重试最多等 ~15s（1.5+3+4+4），留足让桶降速生效。
 */
const MAX_THROTTLE_RETRIES = 4;
const THROTTLE_BACKOFF_BASE_MS = 1500;
const CHECKDOMAIN_LOG_BODY_MAX = 8000;

/** 写入 ai-interactions.jsonl 的请求摘要（不含密钥与签名） */
function redactedParamsForLog(params: Record<string, string>): Record<string, string> {
  const omit = new Set(["AccessKeyId", "Signature", "SignatureNonce"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (omit.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 阿里云限流常以 HTTP 400 返回 JSON：`Code=Throttling.User`、`Message=…flow control…`
 *（与 429/503 不同，旧逻辑未重试会导致整批检测失败）。
 */
function isAliyunThrottlePayload(json: Record<string, unknown> | null): boolean {
  if (!json) return false;
  const code = String(json.Code ?? "");
  const msg = String(json.Message ?? "");
  return (
    /throttl/i.test(code) ||
    /flow control/i.test(msg) ||
    /requestlimitexceeded/i.test(code)
  );
}

function percentEncode(s: string) {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function hmacSha1Base64(secret: string, data: string) {
  return crypto.createHmac("sha1", `${secret}&`).update(data).digest("base64");
}

function parseMoney(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析 CheckDomain 的 StaticPriceInfo。
 * 文档：PriceInfo[].money 单位为**元**；同一域名可能返回多档报价，新购取 **activate 类目的最小值** 更接近控制台展示价。
 */
function parseStaticPriceInfo(body: Record<string, unknown>): {
  activate: number;
  renew: number;
} {
  const rows: Record<string, unknown>[] = [];
  const spiRaw = body.StaticPriceInfo ?? body.staticPriceInfo;
  const collectFromSpi = (spi: unknown) => {
    if (!spi || typeof spi !== "object") return;
    const o = spi as Record<string, unknown>;
    const pi = o.PriceInfo ?? o.priceInfo;
    const list: unknown[] = Array.isArray(pi) ? pi : pi && typeof pi === "object" ? [pi] : [];
    for (const row of list) {
      if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
    }
  };
  if (Array.isArray(spiRaw)) {
    for (const chunk of spiRaw) collectFromSpi(chunk);
  } else {
    collectFromSpi(spiRaw);
  }

  let activate = 0;
  let renew = 0;
  for (const r of rows) {
    const action = String(r.action ?? r.Action ?? "").toLowerCase();
    const money = parseMoney(r.money ?? r.Money);
    if (!money || money <= 0) continue;
    if (action === "activate" || action === "create" || action === "register") {
      activate = activate === 0 ? money : Math.min(activate, money);
    }
    if (action === "renew" || action === "renewal") {
      renew = renew === 0 ? money : Math.min(renew, money);
    }
  }
  return { activate, renew };
}

function parseTopLevelPrice(body: Record<string, unknown>): number {
  const priceRaw = body.Price;
  if (typeof priceRaw === "number" && Number.isFinite(priceRaw)) return priceRaw;
  return Number.parseFloat(String(priceRaw ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

async function fetchCheckDomainBody(
  domain: string,
  accessKeyId: string,
  secret: string,
  extra: Record<string, string>,
): Promise<Record<string, unknown>> {
  const d = domain.trim().toLowerCase();

  // 每次尝试都必须重新生成 SignatureNonce + Timestamp 并重算签名，
  // 否则阿里云会以 `SignatureNonceUsed` 拒绝重试请求（nonce 服务端去重）。
  const buildSignedUrl = (): { url: string; params: Record<string, string> } => {
    const params: Record<string, string> = {
      Action: "CheckDomain",
      DomainName: d,
      Format: "JSON",
      Version: "2018-01-29",
      AccessKeyId: accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: crypto.randomUUID(),
      SignatureVersion: "1.0",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...extra,
    };
    const sortedKeys = Object.keys(params).sort();
    const canonicalized = sortedKeys
      .map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
      .join("&");
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalized)}`;
    const signature = percentEncode(hmacSha1Base64(secret, stringToSign));
    const query =
      sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`).join("&") +
      `&Signature=${signature}`;
    return { url: `https://domain.aliyuncs.com/?${query}`, params };
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    // 每次真正的 CheckDomain HTTP 请求都要取一个 fetch 级令牌：单域名内部的 2–3 次子
    // 请求、以及限流重试，都会被线性压进阿里云 10 QPS 硬限以下，不会因并行 ×子请求
    // 叠加超限。
    await acquireCheckDomainSlot();
    const { url, params } = buildSignedUrl();
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      const rawBody = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        if (rawBody.trim().length > 0) json = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        json = null;
      }
      const reqSummary = redactedParamsForLog(params);
      const preview = rawBody.slice(0, CHECKDOMAIN_LOG_BODY_MAX);

      if (!res.ok) {
        const throttle =
          res.status === 429 ||
          res.status === 503 ||
          isAliyunThrottlePayload(json);
        const apiDetail = json
          ? `${String(json.Code ?? "")}: ${String(json.Message ?? "")}`.trim()
          : "";
        if (!throttle) {
          logAliyunCheckDomainFailure({
            domain: d,
            httpStatus: res.status,
            requestSummary: reqSummary,
            rawBodyPreview: preview,
            parsedJson: json,
            failureKind: "http_error",
          });
        }
        const err = new Error(
          throttle && apiDetail.length > 1 ? `Aliyun ${apiDetail}` : `Aliyun HTTP ${res.status}`,
        );
        if (throttle) {
          // 通知令牌桶动态降速；配合本次退避，后续请求会在更慢的节奏下通过
          reportCheckDomainThrottle();
        }
        if (throttle && attempt < MAX_THROTTLE_RETRIES) {
          lastError = err;
          await rlSleep(backoffDelayMs(attempt, THROTTLE_BACKOFF_BASE_MS));
          continue;
        }
        if (throttle) {
          logAliyunCheckDomainFailure({
            domain: d,
            httpStatus: res.status,
            requestSummary: reqSummary,
            rawBodyPreview: preview,
            parsedJson: json,
            failureKind: "http_error",
          });
        }
        throw err;
      }
      if (!json) {
        logAliyunCheckDomainFailure({
          domain: d,
          httpStatus: res.status,
          requestSummary: reqSummary,
          rawBodyPreview: preview,
          parsedJson: null,
          failureKind: "invalid_response",
        });
        throw new Error("Aliyun CheckDomain: empty or non-json response body");
      }
      if (json.Code && !json.CheckDomainResponse) {
        const err = new Error(String(json.Message ?? json.Code));
        const throttle = isThrottlingError(err) || isAliyunThrottlePayload(json);
        if (!throttle) {
          logAliyunCheckDomainFailure({
            domain: d,
            httpStatus: res.status,
            requestSummary: reqSummary,
            rawBodyPreview: preview,
            parsedJson: json,
            failureKind: "api_error",
          });
        }
        if (throttle) {
          reportCheckDomainThrottle();
        }
        if (throttle && attempt < MAX_THROTTLE_RETRIES) {
          lastError = err;
          await rlSleep(backoffDelayMs(attempt, THROTTLE_BACKOFF_BASE_MS));
          continue;
        }
        if (throttle) {
          logAliyunCheckDomainFailure({
            domain: d,
            httpStatus: res.status,
            requestSummary: reqSummary,
            rawBodyPreview: preview,
            parsedJson: json,
            failureKind: "api_error",
          });
        }
        throw err;
      }
      return (json.CheckDomainResponse ?? json) as Record<string, unknown>;
    } catch (err) {
      // 限流类错误走重试；网络抖动（fetch 抛 TypeError / AbortError / ECONNRESET 等）
      // 也给一次 backoff 重试机会，避免一次 TCP 抖动就让整批检测失败
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      const isTransient =
        isThrottlingError(err) ||
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("socket");
      if (isTransient && attempt < MAX_THROTTLE_RETRIES) {
        lastError = err;
        await rlSleep(backoffDelayMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Aliyun CheckDomain: throttling retry exhausted");
}

export function aliyunConfigured(): boolean {
  return Boolean(
    process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET,
  );
}

/**
 * 单域名 CheckDomain（RPC V1 签名）。
 * 价格取自接口返回的 StaticPriceInfo（新购 activate、续费 renew），与阿里云域名控制台一致；
 * 不再对普通可注册域名使用写死的 ¥55/¥65。
 */
export async function aliyunCheckDomain(domain: string): Promise<DomainCheckDetail> {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID!;
  const secret = process.env.ALIYUN_ACCESS_KEY_SECRET!;

  const withCny: Record<string, string> = {
    FeeCommand: "create",
    FeePeriod: "1",
    Lang: "zh",
    FeeCurrency: "CNY",
  };
  const noCurrency: Record<string, string> = {
    FeeCommand: "create",
    FeePeriod: "1",
    Lang: "zh",
  };

  let body = await fetchCheckDomainBody(domain, accessKeyId, secret, withCny);
  const staticTry = parseStaticPriceInfo(body);
  const availEarly = Number(body.Avail);
  const premEarly =
    String(body.Premium ?? "").toLowerCase() === "true" || Number(body.Premium) === 1;
  /** 非溢价且首轮未解析到 StaticPriceInfo 新购价时，再请求一次（避免误用根级 Price） */
  const needSecondFetch =
    Number.isFinite(availEarly) &&
    availEarly === 1 &&
    !premEarly &&
    staticTry.activate <= 0;
  if (needSecondFetch) {
    body = await fetchCheckDomainBody(domain, accessKeyId, secret, noCurrency);
  }

  const avail = Number(body.Avail);
  if (!Number.isFinite(avail)) {
    throw new Error("Invalid Aliyun CheckDomain response");
  }
  const premium =
    String(body.Premium ?? "").toLowerCase() === "true" || Number(body.Premium) === 1;
  const topPrice = parseTopLevelPrice(body);
  const available = avail === 1;
  const static1 = parseStaticPriceInfo(body);

  let reg = 0;
  let renew = 0;

  if (premium && available && topPrice > 0) {
    reg = topPrice;
    renew = static1.renew > 0 ? static1.renew : Math.round(topPrice * 1.08 * 100) / 100;
  } else if (available && !premium) {
    // 根级 Price 文档定义为「溢价词注册价格」；Premium=false 时不得回退到 Price，否则会远高于控制台普通价
    reg = static1.activate > 0 ? static1.activate : 0;
    renew = static1.renew;
    if (reg > 0 && renew <= 0) {
      try {
        const renewBody = await fetchCheckDomainBody(domain, accessKeyId, secret, {
          FeeCommand: "renew",
          FeePeriod: "1",
          Lang: "zh",
          FeeCurrency: "CNY",
        });
        renew = parseStaticPriceInfo(renewBody).renew;
      } catch {
        try {
          const renewBody = await fetchCheckDomainBody(domain, accessKeyId, secret, {
            FeeCommand: "renew",
            FeePeriod: "1",
            Lang: "zh",
          });
          renew = parseStaticPriceInfo(renewBody).renew;
        } catch {
          renew = 0;
        }
      }
      if (renew <= 0 && reg > 0) {
        renew = Math.round(reg * 1.12 * 100) / 100;
      }
    }
  }

  const fqdn = domain.trim().toLowerCase();
  /** 阿里云不卖或未返回 StaticPriceInfo 价的 `.ai`：用 Porkbun 公开价目（USD）作参考零售价 */
  if (available && !premium && reg <= 0 && fqdn.endsWith(".ai")) {
    const pb = await getPorkbunTldRetailUsd("ai");
    if (pb) {
      return {
        domain: fqdn,
        available,
        isPremium: premium && available,
        price: pb.registration,
        renewalPrice: pb.renewal,
        currency: "USD",
        source: "aliyun",
        registrar: "porkbun",
      };
    }
  }

  return {
    domain: fqdn,
    available,
    isPremium: premium && available,
    price: reg,
    renewalPrice: renew,
    currency: "CNY",
    source: "aliyun",
    registrar: "aliyun",
  };
}
