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

// 日志输出：Node.js 写文件；无 fs 时回退到 console
function appendLog(record: Record<string, unknown>) {
  try {
    // 检测是否有可写文件系统（本地 Node.js 开发环境）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const LOG_DIR = path.join(process.cwd(), "logs");
    const LOG_FILE = path.join(LOG_DIR, "ai-interactions.jsonl");
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // 无文件系统时仅打印到标准输出
    console.log("[ai-log]", JSON.stringify(record).slice(0, 500));
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
