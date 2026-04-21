const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function isTurnstileEnforced(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

type SiteverifyResponse = { success?: boolean; "error-codes"?: string[] };

export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  const t = token?.trim();
  if (!t) return false;

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", t);
  if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json().catch(() => null)) as SiteverifyResponse | null;
    return Boolean(json?.success);
  } catch {
    return false;
  }
}
