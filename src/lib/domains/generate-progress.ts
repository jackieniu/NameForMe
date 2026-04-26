/** 域名生成管线向前端/日志输出的进度事件（与 domain-generation 步骤对齐） */
export type GenerateProgressEvent =
  | {
      phase: "strategy";
      strategyName: string;
      strategyIndex: number;
      strategyTotal: number;
    }
  | { phase: "candidates"; count: number }
  /** 主名去重后，将按用户后缀展开为若干完整域名做可用性检测 */
  | { phase: "expand_ready"; uniqueLabels: number; fqdnCount: number }
  | { phase: "check_progress"; done: number; total: number; host: string }
  | {
      phase: "check_done";
      checked: number;
      newAvailable: number;
      taken: number;
      overBudget: number;
    }
  | { phase: "batch_done"; newInBatch: number }
  /** 已累计足够可注册域名后，一次性 AI 打分筛选 */
  | { phase: "final_refine_start"; fqdnCount: number }
  | {
      phase: "final_refine_done";
      /** 进入 AI 精炼池的去重可注册条数（rawByDomain） */
      generatedCount: number;
      /** 精炼后返回给前端的条数 */
      selectedCount: number;
      /** 本请求内实际发起可用性检测的完整域名（FQDN）次数，与 expand_ready 累计之和不混用 */
      totalChecked: number;
    };
