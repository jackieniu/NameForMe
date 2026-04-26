import { protectAfterJsonParsed } from "@/lib/api-protection";
import { generateBodySchema } from "@/lib/domains/schemas";
import { runDomainGeneration } from "@/lib/domains/domain-generation";
import { logGenerateStream } from "@/lib/ai-logger";
import { randomUUID } from "crypto";

/**
 * 必须在 Node runtime 下执行，并禁用静态优化/ISR，确保 NDJSON 流能按 chunk 下发
 * 而不是被上层缓冲成一次性响应（反代/代理下更典型）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel 等平台：Pro 可拉满长时流式生成；Hobby 仍受套餐默认上限约束 */
export const maxDuration = 300;

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = generateBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const denied = await protectAfterJsonParsed({
    req,
    turnstileToken: parsed.data.turnstileToken,
  });
  if (denied) return denied;

  const {
    requirements,
    seed,
    locale,
    strategies,
    executedStrategyKeys,
    historyDomains,
    stream,
  } = parsed.data;

  try {
    const sessionId = randomUUID();
    const genOpts = {
      seed: seed ?? Math.floor(Date.now() % 1_000_000_000),
      locale,
      strategies,
      executedStrategyKeys: executedStrategyKeys ? new Set(executedStrategyKeys) : undefined,
      historyDomains: historyDomains ? new Set(historyDomains) : undefined,
      checkLogContext: { sessionId },
    };

    if (stream) {
      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const startedAt = Date.now();
      const elapsed = () => Date.now() - startedAt;

      /**
       * 客户端断开 / 停止读流时，TransformStream 会关闭 writable；多路并发检测仍会通过
       * `onProgress` 回调写 NDJSON，若不防护会触发 `WritableStream is closed` 与未处理的
       * Promise 拒绝。这里对写入做「单队列 + 吞掉关闭后错误」，并在 `req.signal` abort
       * 后尽早 no-op。
       */
      let streamEnded = false;
      const markEnded = () => {
        streamEnded = true;
      };
      req.signal.addEventListener("abort", markEnded, { once: true });

      let writeChain = Promise.resolve();
      const writeLine = (obj: unknown) => {
        writeChain = writeChain.then(async () => {
          if (streamEnded || req.signal.aborted) return;
          try {
            await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));
          } catch {
            markEnded();
          }
        });
        return writeChain;
      };

      logGenerateStream({
        sessionId,
        event: "start",
        elapsedMs: 0,
        payload: {
          locale,
          strategyCount: strategies.length,
          historyCount: historyDomains?.length ?? 0,
          executedCount: executedStrategyKeys?.length ?? 0,
        },
      });

      void writeLine({ kind: "ready" });
      logGenerateStream({ sessionId, event: "ready", elapsedMs: elapsed() });

      void (async () => {
        try {
          const payload = await runDomainGeneration(requirements, {
            ...genOpts,
            abortSignal: req.signal,
            onProgress: async (ev) => {
              logGenerateStream({
                sessionId,
                event: "progress",
                elapsedMs: elapsed(),
                payload: ev,
              });
              await writeLine({ kind: "progress", ev });
            },
          });
          logGenerateStream({
            sessionId,
            event: "complete",
            elapsedMs: elapsed(),
            payload: {
              resultsCount: payload.results.length,
              totalGenerated: payload.totalGenerated,
              totalAvailable: payload.totalAvailable,
              totalChecked: payload.totalChecked,
              totalTaken: payload.totalTaken,
              totalOverBudget: payload.totalOverBudget,
              fallbackRoundsUsed: payload.fallbackRoundsUsed,
            },
          });
          await writeLine({ kind: "complete", payload });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logGenerateStream({
            sessionId,
            event: "error",
            elapsedMs: elapsed(),
            payload: { message },
          });
          await writeLine({ kind: "error", error: message });
        } finally {
          markEnded();
          await writeChain.catch(() => {});
          await writer.close().catch(() => {});
          logGenerateStream({ sessionId, event: "close", elapsedMs: elapsed() });
        }
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        },
      });
    }

    const payload = await runDomainGeneration(requirements, {
      ...genOpts,
      abortSignal: req.signal,
    });
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 503 });
  }
}
