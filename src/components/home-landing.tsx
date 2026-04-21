"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";

type Props = {
  t: Record<string, string>;
};

const SCENARIOS = [
  { key: "startup", icon: RocketIcon, color: "from-emerald-400 to-emerald-600" },
  { key: "ecommerce", icon: CartIcon, color: "from-emerald-500 to-teal-600" },
  { key: "blog", icon: PenIcon, color: "from-amber-500 to-orange-500" },
  { key: "app", icon: AppIcon, color: "from-cyan-500 to-blue-600" },
  { key: "other", icon: SparkleIcon, color: "from-pink-500 to-rose-600" },
] as const;

export function HomeLanding({ t }: Props) {
  const router = useRouter();
  const locale = useLocale();
  const [customQuery, setCustomQuery] = useState("");

  function goSearch(query: string) {
    const qs = query.trim()
      ? `?q=${encodeURIComponent(query.trim())}`
      : "";
    router.push(`/${locale}/search${qs}`);
  }

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (customQuery.trim()) goSearch(customQuery);
  }

  return (
    <div className="relative overflow-hidden">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-0 h-[500px] w-[500px] rounded-full bg-gradient-to-br from-emerald-100 to-green-50 opacity-60 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 h-[400px] w-[400px] rounded-full bg-gradient-to-tr from-blue-50 to-cyan-50 opacity-50 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        {/* ===== HERO ===== */}
        <section className="pb-16 pt-12 text-center sm:pb-20 sm:pt-16 md:pt-20">
          <div className="animate-fade-in-up">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm font-semibold tracking-wide text-emerald-700">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="animate-float">
                <path d="M7 1l1.76 3.57L13 5.64l-3 2.92.71 4.13L7 10.77 3.29 12.7 4 8.56 1 5.64l4.24-.07L7 1z" fill="currentColor" />
              </svg>
              {t.heroTag}
            </span>
          </div>
          <h1 className="animate-fade-in-up stagger-1 mx-auto mt-6 max-w-3xl text-balance text-3xl font-extrabold leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl lg:text-[3.25rem]">
            {t.heroTitle}
          </h1>
          <p className="animate-fade-in-up stagger-2 mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-muted sm:text-lg">
            {t.heroSubtitle}
          </p>
        </section>

        {/* ===== SCENARIO CARDS ===== */}
        <section className="pb-16 sm:pb-20">
          <div className="text-center">
            <h2 className="animate-fade-in-up text-xl font-bold text-foreground sm:text-2xl">
              {t.scenarioTitle}
            </h2>
            <p className="animate-fade-in-up stagger-1 mt-2 text-sm text-muted">
              {t.scenarioSubtitle}
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {SCENARIOS.map((s, i) => {
              const Icon = s.icon;
              const href = `/${locale}/search?scenario=${encodeURIComponent(s.key)}`;
              return (
                <Link
                  key={s.key}
                  href={href}
                  className={`animate-fade-in-up stagger-${i + 1} group relative block cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-white p-5 text-left no-underline shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--border-hover)] hover:shadow-md`}
                >
                  <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${s.color} text-white shadow-sm`}>
                    <Icon />
                  </div>
                  <h3 className="mt-3 text-sm font-bold text-foreground">
                    {t[`scenario${capitalize(s.key)}`]}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">
                    {t[`scenario${capitalize(s.key)}Desc`]}
                  </p>
                  <div className="absolute -bottom-1 -right-1 h-16 w-16 rounded-tl-full bg-gradient-to-tl from-[var(--brand)]/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              );
            })}
          </div>

          {/* Custom input */}
          <div className="mt-8">
            <p className="mb-3 text-center text-sm text-muted">
              {t.scenarioOrCustom}
            </p>
            <form
              onSubmit={handleCustomSubmit}
              className="mx-auto flex max-w-xl flex-col gap-3 sm:flex-row"
            >
              <input
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder={t.scenarioCustomPlaceholder}
                className="min-h-12 flex-1 rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-foreground shadow-sm outline-none transition-all placeholder:text-muted/60 focus:border-[var(--border-hover)] focus:ring-2 focus:ring-brand/20"
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={!customQuery.trim()}
                className="min-h-12 shrink-0 cursor-pointer rounded-xl bg-gradient-to-r from-brand to-brand-dark px-6 text-sm font-semibold text-white shadow-md shadow-brand/25 transition-all hover:shadow-lg hover:shadow-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t.scenarioCustomButton}
              </button>
            </form>
          </div>
        </section>

        {/* ===== STATS ===== */}
        <section className="pb-16 sm:pb-20">
          <div className="rounded-2xl border border-[var(--border)] bg-white/60 p-8 shadow-sm backdrop-blur-sm sm:p-10">
            <p className="text-center text-sm font-semibold uppercase tracking-widest text-muted">
              {t.statsTitle}
            </p>
            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
              <StatItem value="50,000+" label={t.statsDomains} />
              <StatItem value="73%" label={t.statsAvailability} />
              <StatItem value={`< 30 ${t.statsTimeSuffix}`} label={t.statsTime} />
            </div>
          </div>
        </section>

        {/* ===== HOW IT WORKS ===== */}
        <section className="pb-16 sm:pb-20">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-foreground sm:text-3xl">
              {t.howTitle}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t.howSubtitle}
            </p>
          </div>
          <div className="relative mt-12 grid gap-8 sm:grid-cols-3">
            {/* Connecting line (desktop) */}
            <div className="pointer-events-none absolute left-0 right-0 top-10 hidden h-px bg-gradient-to-r from-transparent via-emerald-200 to-transparent sm:block" />
            {[
              { n: "01", title: t.step1Title, body: t.step1Body, icon: ChatBubbleIcon },
              { n: "02", title: t.step2Title, body: t.step2Body, icon: CpuIcon },
              { n: "03", title: t.step3Title, body: t.step3Body, icon: CheckBadgeIcon },
            ].map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.n} className="relative text-center">
                  <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-2xl border border-[var(--border)] bg-white shadow-sm">
                    <Icon />
                    <span className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-white shadow-sm">
                      {step.n}
                    </span>
                  </div>
                  <h3 className="mt-5 text-base font-bold text-foreground">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {step.body}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===== FEATURES ===== */}
        <section className="pb-16 sm:pb-20">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-foreground sm:text-3xl">
              {t.featuresTitle}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t.featuresSubtitle}
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { key: "1", icon: MessageIcon, gradient: "from-emerald-500/10 to-green-500/10" },
              { key: "2", icon: LayersIcon, gradient: "from-emerald-500/10 to-teal-500/10" },
              { key: "3", icon: StarIcon, gradient: "from-amber-500/10 to-orange-500/10" },
              { key: "4", icon: GlobeIcon, gradient: "from-cyan-500/10 to-blue-500/10" },
              { key: "5", icon: CursorClickIcon, gradient: "from-pink-500/10 to-rose-500/10" },
              { key: "6", icon: ShieldIcon, gradient: "from-slate-500/10 to-gray-500/10" },
            ].map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.key}
                  className="group rounded-2xl border border-[var(--border)] bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--border-hover)] hover:shadow-md"
                >
                  <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${f.gradient}`}>
                    <Icon />
                  </div>
                  <h3 className="mt-4 text-sm font-bold text-foreground">
                    {t[`feature${f.key}Title`]}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {t[`feature${f.key}Body`]}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===== FAQ ===== */}
        <section className="pb-16 sm:pb-20">
          <h2 className="text-center text-2xl font-bold text-foreground sm:text-3xl">
            {t.faqTitle}
          </h2>
          <div className="mx-auto mt-8 max-w-2xl space-y-3">
            {["1", "2", "3", "4"].map((n) => (
              <FaqItem
                key={n}
                question={t[`faq${n}Q`]}
                answer={t[`faq${n}A`]}
              />
            ))}
          </div>
        </section>

        {/* ===== BOTTOM CTA ===== */}
        <section className="pb-16 sm:pb-24">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand to-brand-dark p-8 text-center text-white shadow-xl shadow-brand/20 sm:p-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.15),transparent_50%)]" />
            <h2 className="relative text-2xl font-bold sm:text-3xl">
              {t.ctaTitle}
            </h2>
            <p className="relative mx-auto mt-3 max-w-lg text-sm text-white/80">
              {t.ctaSubtitle}
            </p>
            <Link
              href={`/${locale}/search?scenario=other`}
              className="relative mt-6 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-white px-8 py-3.5 text-sm font-bold text-brand no-underline shadow-lg transition-all hover:-translate-y-0.5 hover:shadow-xl"
            >
              {t.ctaButton}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ===== FAQ Accordion Item ===== */
function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-white shadow-sm transition-all">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-sm font-semibold text-foreground">{question}</span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className={`shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M5 7l4 4 4-4" />
        </svg>
      </button>
      <div
        className={`grid transition-all duration-200 ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-4 text-sm leading-relaxed text-muted">
            {answer}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ===== Stat Item ===== */
function StatItem({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <p className="text-3xl font-extrabold tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

/* ===== Utility ===== */
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ===== Icons (inline SVG for zero-dependency) ===== */
function RocketIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 18s-2-2.5-2-6c0-4 2-8 2-8s2 4 2 8c0 3.5-2 6-2 6z" />
      <path d="M6.5 12.5L4 14l1 3 3-1.5M13.5 12.5L16 14l-1 3-3-1.5" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h1.5l1 9h9l1.5-6H6" />
      <circle cx="8" cy="16" r="1.5" />
      <circle cx="14" cy="16" r="1.5" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 3.5l3 3L7 16H4v-3l9.5-9.5z" />
    </svg>
  );
}

function AppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="14" height="14" rx="3" />
      <path d="M3 8h14M8 8v9" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2l1.5 5.5L17 9l-5.5 1.5L10 16l-1.5-5.5L3 9l5.5-1.5L10 2z" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 20l-2 4 5-2h9a4 4 0 004-4V10a4 4 0 00-4-4H10a4 4 0 00-4 4v10z" />
      <path d="M10 11h8M10 15h5" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="14" height="14" rx="2" />
      <rect x="10" y="10" width="8" height="8" rx="1" />
      <path d="M14 3v4M14 21v4M3 14h4M21 14h4" />
    </svg>
  );
}

function CheckBadgeIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="14" cy="14" r="10" />
      <path d="M10 14l3 3 5-6" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15l-1 3 4-2h7a3 3 0 003-3V7a3 3 0 00-3-3H6a3 3 0 00-3 3v8z" />
      <path d="M7 8h6M7 11h4" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-success"
    >
      <path d="M10 2l8 4-8 4-8-4 8-4zM2 10l8 4 8-4M2 14l8 4 8-4" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-warning"
    >
      <path d="M10 2l2.24 4.54 5.01.73-3.63 3.53.86 5L10 13.27 5.52 15.8l.86-5L2.75 7.27l5.01-.73L10 2z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-brand"
    >
      <circle cx="10" cy="10" r="8" />
      <path d="M2 10h16M10 2c2.5 2.5 4 5.2 4 8s-1.5 5.5-4 8c-2.5-2.5-4-5.2-4-8s1.5-5.5 4-8z" />
    </svg>
  );
}

function CursorClickIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-error"
    >
      <path d="M4 4l4 12 2-5 5-2L4 4z" />
      <path d="M12 12l4 4" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted"
    >
      <path d="M10 2l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V5l7-3z" />
      <path d="M7.5 10l2 2 3.5-4" />
    </svg>
  );
}
