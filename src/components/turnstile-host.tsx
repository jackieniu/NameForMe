"use client";

import Script from "next/script";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";

type TurnstileGlobal = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size: "invisible";
      callback: (token: string) => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  execute: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

export type TurnstileHostHandle = {
  getToken: () => Promise<string>;
};

type Pending = {
  resolve: (t: string) => void;
  reject: (e: Error) => void;
};

/**
 * 无站点 key 时 `getToken` 恒返回空串，后端不强制 Turnstile。
 * 有站点 key 时用 invisible 控件，每次 `getToken` 执行一次校验。
 */
export const TurnstileHost = forwardRef<TurnstileHostHandle>(function TurnstileHost(
  _props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const scriptReadyRef = useRef(false);
  const currentRef = useRef<Pending | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const queueRef = useRef<Pending[]>([]);

  const clearTimer = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const settle = (fn: (p: Pending) => void) => {
    const p = currentRef.current;
    currentRef.current = null;
    clearTimer();
    if (p) fn(p);
    const next = queueRef.current.shift();
    if (next) runPending(next);
  };

  const runPending = (p: Pending) => {
    const id = widgetIdRef.current;
    const api = window.turnstile;
    if (!id || !api) {
      p.reject(new Error("turnstile_not_ready"));
      const next = queueRef.current.shift();
      if (next) runPending(next);
      return;
    }
    currentRef.current = p;
    timeoutRef.current = window.setTimeout(() => {
      settle((cur) => cur.reject(new Error("turnstile_timeout")));
    }, 12_000);
    try {
      api.reset(id);
      api.execute(id);
    } catch (e) {
      settle((cur) => cur.reject(e instanceof Error ? e : new Error("turnstile_execute")));
    }
  };

  const mountWidget = useCallback(() => {
    if (!SITE_KEY || !scriptReadyRef.current) return;
    const el = containerRef.current;
    const api = window.turnstile;
    if (!el || !api || widgetIdRef.current) return;
    widgetIdRef.current = api.render(el, {
      sitekey: SITE_KEY,
      size: "invisible",
      callback: (token: string) => settle((p) => p.resolve(token)),
      "error-callback": () => settle((p) => p.reject(new Error("turnstile_error"))),
    });
    // 内部函数只读取 ref，不需要把它们塞进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountWidget();
  }, [mountWidget]);

  useImperativeHandle(ref, () => ({
    getToken: () => {
      if (!SITE_KEY) return Promise.resolve("");
      return new Promise<string>((resolve, reject) => {
        const waitReady = (attempt: number) => {
          if (widgetIdRef.current && window.turnstile) {
            const p: Pending = { resolve, reject };
            if (currentRef.current) {
              queueRef.current.push(p);
            } else {
              runPending(p);
            }
            return;
          }
          if (attempt > 200) {
            reject(new Error("turnstile_not_ready"));
            return;
          }
          window.setTimeout(() => waitReady(attempt + 1), 50);
        };
        waitReady(0);
      });
    },
  }));

  if (!SITE_KEY) return null;

  return (
    <>
      <div
        ref={containerRef}
        className="pointer-events-none fixed left-0 top-0 -z-10 h-px w-px overflow-hidden opacity-0"
        aria-hidden
      />
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onLoad={() => {
          scriptReadyRef.current = true;
          mountWidget();
        }}
      />
    </>
  );
});
