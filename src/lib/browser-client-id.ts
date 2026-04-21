const STORAGE_KEY = "nfm.client.v1";

function randomId(): string {
  const a =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const b =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2);
  return `${a}${b}`.slice(0, 48);
}

/** 匿名访客浏览器侧稳定 id（localStorage），供限流维度使用；非密码学指纹。 */
export function getOrCreateBrowserClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)?.trim();
    if (existing && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) return existing;
    const next = randomId();
    window.localStorage.setItem(STORAGE_KEY, next);
    return next;
  } catch {
    return "";
  }
}
