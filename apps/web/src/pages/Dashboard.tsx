import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";
import PhoneInput from "@/components/onboarding/PhoneInput";
import { settingsApi, getSettingsToken, setSettingsToken, clearSettingsToken } from "@/lib/settingsApi";
import { dashboardApi, type DashboardSummary } from "@/lib/dashboardApi";
import {
  Reveal, StatCard, WeightChart, NutritionChart, MoodChart, SymptomPatterns, useGreeting,
} from "@/components/dashboard/DashboardCharts";
import { QuickLog } from "@/components/dashboard/QuickLog";

type Stage = "phone" | "code" | "ready";

const inputClass =
  "h-12 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-base text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

export default function Dashboard() {
  const [stage, setStage] = useState<Stage>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [boot, setBoot] = useState(true);
  const [data, setData] = useState<DashboardSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await dashboardApi.summary();
      setData(s);
      setStage("ready");
    } catch (e) {
      if ((e as { status?: number }).status === 401) { clearSettingsToken(); setStage("phone"); }
      else toast.error(e instanceof Error ? e.message : "Couldn't load your dashboard");
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (getSettingsToken()) await load();
      setBoot(false);
    })();
  }, [load]);

  const sendCode = async () => {
    if (phone.replace(/\D/g, "").length < 8) { toast.error("Enter a valid phone number"); return; }
    setBusy(true);
    try { await settingsApi.requestCode(phone); setStage("code"); toast.success("We sent you a 6-digit code"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't send the code"); } finally { setBusy(false); }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) { toast.error("Enter the 6-digit code"); return; }
    setBusy(true);
    try {
      const { token } = await settingsApi.verifyCode(phone, code.trim());
      setSettingsToken(token);
      await load();
      toast.success("Welcome back");
    } catch (e) { toast.error(e instanceof Error ? e.message : "That code didn't work"); } finally { setBusy(false); }
  };

  const logout = () => { clearSettingsToken(); setData(null); setPhone(""); setCode(""); setStage("phone"); };

  return (
    <div className="min-h-screen bg-secondary/20">
      <SEOHead title="Your progress" description="Your Grace progress dashboard — weight, nutrition, and your personal side-effect patterns." noindex
        jsonLd={breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Dashboard", path: "/dashboard" }])} />

      {boot ? (
        <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground">Loading…</p></div>
      ) : stage !== "ready" ? (
        <AuthGate stage={stage} phone={phone} code={code} busy={busy}
          setPhone={setPhone} setCode={setCode} sendCode={sendCode} verify={verify} backToPhone={() => setStage("phone")} />
      ) : data ? (
        <DashboardBody data={data} reload={load} onLogout={logout} />
      ) : null}
    </div>
  );
}

function AuthGate({ stage, phone, code, busy, setPhone, setCode, sendCode, verify, backToPhone }: {
  stage: Stage; phone: string; code: string; busy: boolean;
  setPhone: (v: string) => void; setCode: (v: string) => void; sendCode: () => void; verify: () => void; backToPhone: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <p className="mb-1 font-serif text-4xl text-foreground">Grace</p>
        <h1 className="mb-2 font-serif text-2xl text-foreground">Your progress, all in one place</h1>
        <p className="mb-8 text-muted-foreground">Weight, nutrition, and the personal patterns Grace has learned about how your body handles your medication.</p>
        <AnimatePresence mode="wait">
          {stage === "phone" ? (
            <motion.div key="p" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-5">
              <PhoneInput value={phone} onChange={setPhone} />
              <button onClick={sendCode} disabled={busy} className="h-12 w-full rounded-full bg-primary font-medium text-white disabled:opacity-50">
                {busy ? "Sending…" : "Send me a code"}
              </button>
              <p className="text-center text-xs text-muted-foreground">Use the same number you text Grace on.</p>
            </motion.div>
          ) : (
            <motion.div key="c" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-5">
              <p className="text-foreground">Enter the 6-digit code sent to <span className="font-medium">{phone}</span>.</p>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" className={`${inputClass} tracking-[0.5em] text-2xl`} />
              <button onClick={verify} disabled={busy} className="h-12 w-full rounded-full bg-primary font-medium text-white disabled:opacity-50">
                {busy ? "Verifying…" : "See my progress"}
              </button>
              <button onClick={backToPhone} className="w-full text-center text-sm text-muted-foreground underline">Change number</button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function DashboardBody({ data, reload, onLogout }: { data: DashboardSummary; reload: () => void; onLogout: () => void }) {
  const greeting = useGreeting(data.profile.firstName);
  const w = data.weight;
  const n = data.nutrition;
  const proteinPct = n.proteinGoal ? Math.min(100, Math.round((n.today.protein / n.proteinGoal) * 100)) : 0;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      {/* Header */}
      <header className="mb-8 flex items-start justify-between">
        <div>
          <p className="font-serif text-2xl text-foreground sm:text-3xl">{greeting} 🤍</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.profile.glp1Week != null && <>Week {data.profile.glp1Week} on {data.profile.medication ?? "your GLP-1"}</>}
            {data.profile.injectionDay && <> · {data.profile.injectionDay} injections</>}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link to="/settings" className="text-muted-foreground underline">Settings</Link>
          <button onClick={onLogout} className="text-muted-foreground underline">Sign out</button>
        </div>
      </header>

      {/* Hero stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Reveal delay={0}><StatCard label="Lost so far" tone="clay" value={w.lostLbs != null ? `${w.lostLbs} lb` : "—"} sub={w.start != null ? `from ${w.start} lb` : "add starting weight"} /></Reveal>
        <Reveal delay={0.05}><StatCard label="To goal" value={w.toGoLbs != null ? `${w.toGoLbs} lb` : "—"} sub={w.goal != null ? `goal ${w.goal} lb` : "set a goal"} /></Reveal>
        <Reveal delay={0.1}><StatCard label="Protein today" tone={proteinPct >= 100 ? "sage" : "ink"} value={`${n.today.protein}g`} sub={`of ${n.proteinGoal}g · ${proteinPct}%`} /></Reveal>
        <Reveal delay={0.15}><StatCard label="Logging streak" tone="sage" value={n.streak > 0 ? `${n.streak} day${n.streak === 1 ? "" : "s"}` : "—"} sub={n.streak > 0 ? "keep it going" : "log a meal today"} /></Reveal>
      </div>

      {/* Charts grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal><WeightChart weight={w} /></Reveal>
        <Reveal delay={0.05}><NutritionChart nutrition={n} /></Reveal>
      </div>

      {/* Symptom intelligence — the differentiator, full width */}
      <div className="mt-4">
        <Reveal><SymptomPatterns symptoms={data.symptoms} /></Reveal>
      </div>

      {/* Mood + Quick log */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Reveal><QuickLog onLogged={reload} /></Reveal>
        <Reveal delay={0.05}>
          <div className="space-y-4">
            <MoodChart mood={data.mood} />
            {n.today.items.length > 0 && (
              <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
                <h3 className="mb-3 font-serif text-lg text-foreground">Today's meals</h3>
                <ul className="space-y-2">
                  {n.today.items.map((it, i) => (
                    <li key={i} className="flex items-center justify-between text-sm">
                      <span className="text-foreground/80">{it.food}</span>
                      <span className="text-muted-foreground">{it.protein}g · {it.calories} kcal</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Reveal>
      </div>

      <p className="mt-10 text-center text-xs text-muted-foreground">
        Everything here syncs with your chats. Text Grace anytime — it all lands in the same place.
      </p>
    </div>
  );
}
