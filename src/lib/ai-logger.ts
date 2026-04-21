/**
 * AI 交互日志记录器
 *
 * 将每次 AI 调用的请求参数和响应内容以 JSON Lines 格式追加写入
 * logs/ai-interactions.jsonl（项目根目录下）。
 *
 * 每条日志字段：
 *   ts          ISO 时间戳（UTC）
 *   type        "chat" | "refine"
 *   locale      "zh" | "en"
 *   system      系统提示（chat 类型）
 *   prompt      用户 prompt（refine 类型）
 *   messages    对话消息列表（chat 类型，仅含 role+content）
 *   input       候选域名列表（refine 类型）
 *   brief       用户需求摘要（refine 类型）
 *   response    AI 完整回复文本（chat 类型）
 *   output      AI 精炼结果（refine 类型）
 *   durationMs  耗时毫秒
 *   error       出错时的错误信息
 *
 *   type "aliyun_checkdomain"：阿里云 CheckDomain 失败排查（HTTP 非 2xx 或返回体带 Code）
 */

import fs from "fs";
import path from "path";

// 日志文件路径：<project_root>/logs/ai-interactions.jsonl
const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "ai-interactions.jsonl");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function appendLog(record: Record<string, unknown>) {
  try {
    ensureLogDir();
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch (err) {
    // 日志写入失败不影响主流程
    console.error("[ai-logger] write failed:", err);
  }
}

// ─── Chat 日志 ────────────────────────────────────────────────────────────────

export interface ChatLogEntry {
  locale: string;
  system: string;
  /** 仅含 role + text content，去掉复杂 UI Message 结构 */
  messages: Array<{ role: string; content: string }>;
  response?: string;
  durationMs?: number;
  error?: string;
}

export function logChat(entry: ChatLogEntry) {
  appendLog({
    ts: new Date().toISOString(),
    type: "chat",
    ...entry,
  });
}

// ─── Refine 日志 ──────────────────────────────────────────────────────────────

export interface RefineLogEntry {
  locale: string;
  brief: string;
  prompt: string;
  inputCount: number;
  input: string[];
  output?: {
    selected: Array<{ domain: string; note: string; score?: number }>;
    invented: Array<{ domain: string; note: string; score?: number }>;
  };
  resultCount?: number;
  durationMs?: number;
  error?: string;
  /** 过滤统计等附加信息（用于排查 AI 评分与硬阈值过滤效果） */
  notes?: Record<string, unknown>;
}

export function logRefine(entry: RefineLogEntry) {
  appendLog({
    ts: new Date().toISOString(),
    type: "refine",
    ...entry,
  });
}

// ─── 生成流程日志（NDJSON 时序） ──────────────────────────────────────────────

export interface GenerateStreamLogEntry {
  /** 生成会话 id（单次 `/api/domains/generate` 调用）*/
  sessionId: string;
  /** 事件类型：start / progress / complete / error / close */
  event: string;
  /** 相对开始时间（毫秒） */
  elapsedMs: number;
  /** 具体载荷：progress 的 `ev`；complete 的 results 摘要；error 信息等 */
  payload?: unknown;
}

export function logGenerateStream(entry: GenerateStreamLogEntry) {
  appendLog({
    ts: new Date().toISOString(),
    type: "generate_stream",
    ...entry,
  });
}

// ─── 阿里云域名检测失败（写入同一 NDJSON，便于与 generate_stream 对照） ─────

export interface AliyunCheckDomainFailureEntry {
  domain: string;
  httpStatus: number;
  /** 不含 AccessKeyId / Signature / SignatureNonce */
  requestSummary: Record<string, string>;
  /** 响应体截断预览（便于看 Message / RequestId） */
  rawBodyPreview: string;
  /** 解析后的 JSON；非 JSON 体时为 null */
  parsedJson: Record<string, unknown> | null;
  /** http_error：HTTP 状态非 2xx；api_error：HTTP 200 但业务 Code 表示失败；invalid_response：2xx 但体为空或非 JSON */
  failureKind: "http_error" | "api_error" | "invalid_response";
}

export function logAliyunCheckDomainFailure(entry: AliyunCheckDomainFailureEntry) {
  appendLog({
    ts: new Date().toISOString(),
    type: "aliyun_checkdomain",
    ...entry,
  });
}
