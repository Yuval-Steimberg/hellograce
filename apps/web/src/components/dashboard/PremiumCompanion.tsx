import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Clipboard, LockKeyhole, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { DashboardSummary } from "@/lib/dashboardApi";

export function PremiumCompanion({ data }: { data: DashboardSummary }) {
  const premium = data.premium;
  const [section, setSection] = useState<"week" | "today" | "injection" | "doctor">("week");

  if (!premium.unlocked) {
    return (
      <section className="rounded-2xl border border-border bg-background p-6 shadow">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-secondary p-3 text-foreground">
            <LockKeyhole size={20} strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow text-muted-foreground">Grace Plus</p>
            <h2 className="mt-1 text-xl font-bold text-foreground">Your personal pattern, updated every week</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{premium.preview}</p>
            <p className="mt-3 text-sm text-foreground">
              Unlock weekly reports, injection-cycle insights, adaptive daily plans, and doctor-ready exports.
            </p>
            <Link
              to={premium.upgradePath ?? "/upgrade"}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 font-medium text-primary-foreground transition-transform duration-200 hover:underline active:scale-[0.98]"
            >
              <Sparkles size={17} strokeWidth={1.75} />
              Unlock Grace Plus
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const tabs = [
    ["week", "This week"],
    ["today", "Today"],
    ["injection", "Injection"],
    ["doctor", "Doctor report"],
  ] as const;

  const copyDoctorReport = async () => {
    if (!premium.doctorReport) return;
    try {
      await navigator.clipboard.writeText(premium.doctorReport);
      toast.success("Doctor report copied");
    } catch {
      toast.error("Couldn't copy the report");
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-background p-5 shadow sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="eyebrow text-muted-foreground">Grace Plus</p>
          <h2 className="mt-1 text-xl font-bold text-foreground">Your personal companion</h2>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-foreground">
          {premium.access === "pro" ? "Pro" : "Plus"}
        </span>
      </div>

      <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            aria-pressed={section === key}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm transition-colors duration-200 ${
              section === key
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:underline"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 rounded-xl bg-secondary/50 p-4 text-sm leading-relaxed text-foreground">
        {section === "week" && premium.weeklyReport && (
          <div>
            <h3 className="text-base font-bold">{premium.weeklyReport.headline}</h3>
            <div className="mt-3 space-y-2">
              {premium.weeklyReport.highlights.map((item) => (
                <p key={item} className="flex gap-2">
                  <Check className="mt-0.5 shrink-0" size={16} strokeWidth={1.75} />
                  <span>{item}</span>
                </p>
              ))}
            </div>
            <p className="mt-4 border-t border-border pt-3 font-medium">{premium.weeklyReport.focus}</p>
          </div>
        )}

        {section === "today" && premium.dailyPlan && (
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(premium.dailyPlan).map(([key, value]) => (
              <div key={key}>
                <dt className="font-semibold capitalize">{key}</dt>
                <dd className="mt-0.5 text-muted-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {section === "injection" && premium.injectionInsight && (
          <div>
            <h3 className="text-base font-bold">{premium.injectionInsight.title}</h3>
            <p className="mt-2 text-muted-foreground">{premium.injectionInsight.body}</p>
            <p className="mt-3 font-medium">{premium.injectionInsight.nextStep}</p>
          </div>
        )}

        {section === "doctor" && premium.doctorReport && (
          <div>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">{premium.doctorReport}</pre>
            <button
              onClick={copyDoctorReport}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-foreground px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-foreground hover:text-background"
            >
              <Clipboard size={16} strokeWidth={1.75} />
              Copy report
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
