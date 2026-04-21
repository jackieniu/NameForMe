import { z } from "zod";

const requirementsBaseSchema = z.object({
  homeScenarioLabel: z.string().max(200).optional(),
  description: z.string().min(1).max(4000),
  market: z.enum(["cn", "us", "both"]),
  tone: z.enum([
    "professional",
    "playful",
    "tech",
    "elegant",
    "luxury",
    "any",
  ]),
  syllable: z.enum(["punchy", "smooth", "any"]),
  suffixes: z.array(z.string()).default([".com", ".ai", ".io"]),
  excludes: z.array(z.string()).default([]),
  extraContext: z.string().max(2000).optional(),
});

export const requirementsSchema = z.discriminatedUnion("budgetCurrency", [
  requirementsBaseSchema.extend({
    budgetCurrency: z.literal("CNY"),
    maxFirstYearBudgetAmount: z.union([
      z.literal(100),
      z.literal(1000),
      z.literal(10000),
      z.literal(100000),
      z.literal(0),
    ]),
  }),
  requirementsBaseSchema.extend({
    budgetCurrency: z.literal("USD"),
    maxFirstYearBudgetAmount: z.union([
      z.literal(10),
      z.literal(100),
      z.literal(1000),
      z.literal(10000),
      z.literal(0),
    ]),
  }),
]);

const parsedStrategySchema = z.object({
  name: z.string(),
  params: z.string(),
  key: z.string(),
});

export const generateBodySchema = z.object({
  requirements: requirementsSchema,
  locale: z.enum(["en", "zh"]),
  seed: z.number().int().optional(),
  /** 由 AI 给出的本批策略（至少一组） */
  strategies: z.array(parsedStrategySchema).min(1),
  /** Strategy keys already executed in this session (for dedup) */
  executedStrategyKeys: z.array(z.string()).optional(),
  /** Valid domain names already generated/seen in this session */
  historyDomains: z.array(z.string()).optional(),
  /** 为 true 时返回 NDJSON 流（progress 行 + 最后一行 complete） */
  stream: z.boolean().optional(),
  /** Cloudflare Turnstile；生产配置 `TURNSTILE_SECRET_KEY` 时必填 */
  turnstileToken: z.string().min(1).optional(),
});

export const checkBodySchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
});
