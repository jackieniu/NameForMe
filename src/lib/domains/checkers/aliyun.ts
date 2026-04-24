import crypto from "node:crypto";
import { logAliyunCheckDomainFailure } from "@/lib/ai-logger";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import { acquireCheckDomainSlot } from "@/lib/domains/checkers/rate-limit";

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

/**
 * 单次 HTTP 请求，无重试。
 * 若发生限流或网络错误，直接抛出，由调用方决定是否回退到 Phase1 返回的美元价。
 */
async function fetchCheckDomainBody(
  domain: string,
  accessKeyId: string,
  secret: string,
  extra: Record<string, string>,
): Promise<Record<string, unknown>> {
  const d = domain.trim().toLowerCase();

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
  const url = `https://domain.aliyuncs.com/?${query}`;

  await acquireCheckDomainSlot();

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
    logAliyunCheckDomainFailure({
      domain: d,
      httpStatus: res.status,
      requestSummary: reqSummary,
      rawBodyPreview: preview,
      parsedJson: json,
      failureKind: "http_error",
    });
    throw new Error(`Aliyun HTTP ${res.status}`);
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
    logAliyunCheckDomainFailure({
      domain: d,
      httpStatus: res.status,
      requestSummary: reqSummary,
      rawBodyPreview: preview,
      parsedJson: json,
      failureKind: "api_error",
    });
    throw new Error(String(json.Message ?? json.Code));
  }
  return (json.CheckDomainResponse ?? json) as Record<string, unknown>;
}

export function aliyunConfigured(): boolean {
  return Boolean(
    process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET,
  );
}

export interface AliyunCheckOptions {
  /** 询价货币：CNY（中文模式）或 USD（英文模式）。默认 CNY。 */
  currency?: "CNY" | "USD";
}

/**
 * 单域名 CheckDomain（RPC V1 签名）。
 *
 * 最多发起 **2 次** HTTP 请求：
 *   1. create（新购价）— 同时返回可注册状态
 *   2. renew（续费价）— 仅当域名可注册且第 1 次未返回续费价时补充
 *
 * 若 create 请求异常（网络错误 / 阿里云不支持该 TLD），则直接抛出，
 * 由 orchestrator 决定是否转 Porkbun 补价格。
 */
export async function aliyunCheckDomain(
  domain: string,
  opts?: AliyunCheckOptions,
): Promise<DomainCheckDetail> {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID!;
  const secret = process.env.ALIYUN_ACCESS_KEY_SECRET!;
  const currency = opts?.currency ?? "CNY";

  const langParams: Record<string, string> =
    currency === "CNY" ? { Lang: "zh", FeeCurrency: "CNY" } : { Lang: "en" };

  // 请求 1：新购价 + 可注册状态
  const createBody = await fetchCheckDomainBody(domain, accessKeyId, secret, {
    FeeCommand: "create",
    FeePeriod: "1",
    ...langParams,
  });

  const avail = Number(createBody.Avail);
  if (!Number.isFinite(avail)) {
    throw new Error("Invalid Aliyun CheckDomain response");
  }

  const premium =
    String(createBody.Premium ?? "").toLowerCase() === "true" ||
    Number(createBody.Premium) === 1;
  const available = avail === 1;
  const fqdn = domain.trim().toLowerCase();

  if (!available) {
    return {
      domain: fqdn,
      available: false,
      isPremium: false,
      price: 0,
      renewalPrice: 0,
      currency,
      source: "aliyun",
      registrar: "aliyun",
    };
  }

  // 解析新购价
  const topPrice = parseTopLevelPrice(createBody);
  const static1 = parseStaticPriceInfo(createBody);
  let reg = 0;
  let renew = 0;

  if (premium && topPrice > 0) {
    reg = topPrice;
    renew = static1.renew > 0 ? static1.renew : Math.round(topPrice * 1.08 * 100) / 100;
  } else if (!premium) {
    reg = static1.activate > 0 ? static1.activate : 0;
    renew = static1.renew;
  }

  // 请求 2（可选）：续费价——仅当有新购价但无续费价时补查
  if (reg > 0 && renew <= 0) {
    try {
      const renewBody = await fetchCheckDomainBody(domain, accessKeyId, secret, {
        FeeCommand: "renew",
        FeePeriod: "1",
        ...langParams,
      });
      const static2 = parseStaticPriceInfo(renewBody);
      if (static2.renew > 0) renew = static2.renew;
    } catch {
      // 续费价查询失败不影响主流程
    }
    if (renew <= 0) {
      renew = Math.round(reg * 1.12 * 100) / 100;
    }
  }

  return {
    domain: fqdn,
    available,
    isPremium: premium,
    price: reg,
    renewalPrice: renew,
    currency,
    source: "aliyun",
    registrar: "aliyun",
  };
}
