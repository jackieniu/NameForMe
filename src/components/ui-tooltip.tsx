"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const GAP_PX = 8;
const SHOW_DELAY_MS = 60;
const Z_TOOLTIP = 500;

type Side = "top" | "bottom";

export type UiTooltipProps = {
  /** Tooltip 文案（纯文本或简短富文本） */
  label: ReactNode;
  /** 触发器：单个可挂事件的 React 元素（如 button / a） */
  children: ReactElement<
    Record<string, unknown> & {
      onMouseEnter?: (e: React.MouseEvent) => void;
      onMouseLeave?: (e: React.MouseEvent) => void;
      onFocus?: (e: React.FocusEvent) => void;
      onBlur?: (e: React.FocusEvent) => void;
    }
  >;
  side?: Side;
  /** 包在触发器外层的 class（如 flex-1 / min-w-0） */
  wrapperClassName?: string;
};

/**
 * 非原生 `title`：悬停/聚焦时在 `document.body` 上以 fixed 渲染，避免被 overflow 裁剪。
 */
export function UiTooltip({ label, children, side = "top", wrapperClassName = "" }: UiTooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0, transform: "translate(-50%, -100%)" as string });

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current != null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const updateCoords = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    if (side === "top") {
      setCoords({
        left: cx,
        top: r.top - GAP_PX,
        transform: "translate(-50%, -100%)",
      });
    } else {
      setCoords({
        left: cx,
        top: r.bottom + GAP_PX,
        transform: "translate(-50%, 0)",
      });
    }
  }, [side]);

  const scheduleOpen = useCallback(() => {
    clearShowTimer();
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      updateCoords();
      setOpen(true);
    }, SHOW_DELAY_MS);
  }, [clearShowTimer, updateCoords]);

  const close = useCallback(() => {
    clearShowTimer();
    setOpen(false);
  }, [clearShowTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
  }, [open, label, updateCoords]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updateCoords();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updateCoords]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => () => clearShowTimer(), [clearShowTimer]);

  const child = children;
  if (!isValidElement(child)) {
    return <span className={wrapperClassName}>{children}</span>;
  }

  const merged = cloneElement(child, {
    onMouseEnter: (e: React.MouseEvent) => {
      (child.props as { onMouseEnter?: (ev: React.MouseEvent) => void }).onMouseEnter?.(e);
      scheduleOpen();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      (child.props as { onMouseLeave?: (ev: React.MouseEvent) => void }).onMouseLeave?.(e);
      close();
    },
    onFocus: (e: React.FocusEvent) => {
      (child.props as { onFocus?: (ev: React.FocusEvent) => void }).onFocus?.(e);
      clearShowTimer();
      updateCoords();
      setOpen(true);
    },
    onBlur: (e: React.FocusEvent) => {
      (child.props as { onBlur?: (ev: React.FocusEvent) => void }).onBlur?.(e);
      close();
    },
  });

  const portal =
    open &&
    typeof document !== "undefined" &&
    createPortal(
      <div
        role="tooltip"
        className="pointer-events-none fixed max-w-[min(18rem,calc(100vw-1rem))] rounded-lg bg-[#1f1f1f] px-2.5 py-1.5 text-center text-xs leading-snug text-white shadow-[0_4px_14px_rgba(0,0,0,0.25)] ring-1 ring-white/10"
        style={{
          left: coords.left,
          top: coords.top,
          transform: coords.transform,
          zIndex: Z_TOOLTIP,
        }}
      >
        {label}
      </div>,
      document.body,
    );

  return (
    <>
      <span ref={wrapRef} className={`inline-flex ${wrapperClassName}`.trim()}>
        {merged}
      </span>
      {portal}
    </>
  );
}
