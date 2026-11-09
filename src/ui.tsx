import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" | "white" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition-[background-color,transform,border-color] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-brand text-white hover:bg-brand/90",
        variant === "outline" && "border border-line bg-white text-ink hover:border-ink/30",
        variant === "ghost" && "text-ink hover:bg-canvas",
        variant === "white" && "bg-white text-brand hover:bg-white/90",
        className,
      )}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-line bg-white p-6", className)}>{children}</div>;
}

const STEPS = ["System test", "Check-in", "Exam", "Results"];

/** Left rail with the four OnVUE-style stages; header with the Yatri Proctor lockup. */
export function Shell({ step, title, subtitle, children, aside }: { step: number; title: string; subtitle?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-full">
      <nav aria-label="Progress" className="hidden w-64 shrink-0 flex-col border-r border-line bg-canvas p-6 md:flex">
        <div className="flex items-center gap-2.5">
          <img src="./logo.png" alt="" className="h-8 w-8" />
          <div>
            <p className="font-display text-base font-bold leading-none text-ink">Yatri Proctor</p>
            <p className="mt-1 text-xs text-muted">Secure mock exams</p>
          </div>
        </div>
        <ol className="mt-10 space-y-1">
          {STEPS.map((s, i) => (
            <li key={s} className={cx("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm", i === step ? "bg-brand font-semibold text-white" : i < step ? "text-ink" : "text-muted")}>
              <span className={cx("flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold", i === step ? "border-white text-white" : i < step ? "border-ink bg-ink text-white" : "border-line")}>{i < step ? "✓" : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <p className="mt-auto text-xs leading-relaxed text-muted">Need help? info@yatricloud.com</p>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="blue-panel mx-6 mt-6 rounded-3xl px-8 py-7 text-white md:mx-8">
          <h1 className="font-display text-3xl font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 max-w-2xl text-[15px] font-medium text-white/90">{subtitle}</p>}
          {aside && <div className="mt-5">{aside}</div>}
        </header>
        <div className="mx-6 flex-1 py-8 md:mx-8">{children}</div>
      </main>
    </div>
  );
}

/** One row of a check list: label, detail, status in words (not colour alone). */
export function CheckRow({ label, detail, status, action }: { label: string; detail?: ReactNode; status: "pass" | "fail" | "warn" | "wait"; action?: ReactNode }) {
  const text = { pass: "Passed", fail: "Fix needed", warn: "Check", wait: "Checking…" }[status];
  return (
    <li className="flex items-start gap-4 border-b border-line py-4 last:border-0">
      <span aria-hidden="true" className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
        status === "pass" && "bg-brand", status === "fail" && "bg-ink", status === "warn" && "bg-muted", status === "wait" && "animate-pulse bg-line")}>
        {status === "pass" ? "✓" : status === "fail" ? "!" : status === "warn" ? "?" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-6 text-ink">{label}</p>
        {detail && <div className="mt-0.5 text-sm text-muted">{detail}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
      <span className="shrink-0 text-sm font-medium text-ink">{text}</span>
    </li>
  );
}
