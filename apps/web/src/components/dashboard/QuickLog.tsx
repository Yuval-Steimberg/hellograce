import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { dashboardApi } from "@/lib/dashboardApi";
import { fileToDataUrl } from "@/lib/image";
import { getWeightUnit, setWeightUnit, toLbs, type WeightUnit } from "@/lib/units";

const SYMPTOMS = [
  "nausea", "vomiting", "constipation", "diarrhea", "fatigue",
  "headache", "dizziness", "heartburn", "bloating",
] as const;

const chip = "rounded-full border border-sand bg-white px-4 py-2 text-sm text-foreground/80 transition-colors hover:border-primary hover:text-foreground";
const activeChip = "rounded-full border border-primary bg-primary px-4 py-2 text-sm text-white";
const input = "h-12 w-full rounded-xl border border-sand bg-white px-4 text-base text-foreground outline-none focus:border-primary transition-colors";
const primaryBtn = "h-12 rounded-full bg-primary px-6 font-medium text-white disabled:opacity-50";

type Tab = "weight" | "food" | "water" | "symptom" | "mood" | "photo";

export function QuickLog({ onLogged }: { onLogged: () => void }) {
  const [tab, setTab] = useState<Tab>("weight");
  const [busy, setBusy] = useState(false);
  const [weight, setWeight] = useState("");
  const [wUnit, setWUnit] = useState<WeightUnit>(getWeightUnit());
  const [food, setFood] = useState("");
  const [symptom, setSymptom] = useState<string>("");
  const [remedy, setRemedy] = useState("");
  const [mood, setMood] = useState(6);
  const [water, setWater] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (msg: string) => { toast.success(msg); onLogged(); };

  const submitWeight = async () => {
    const w = Number(weight);
    const lbs = Number.isFinite(w) ? toLbs(w, wUnit) : NaN;
    if (!Number.isFinite(lbs) || lbs < 60 || lbs > 700) { toast.error(`Enter a weight in ${wUnit}`); return; }
    setBusy(true);
    try { await dashboardApi.logWeight(w, wUnit); setWeight(""); done("Weight logged"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't log that"); } finally { setBusy(false); }
  };

  const pickWUnit = (u: WeightUnit) => { setWUnit(u); setWeightUnit(u); };

  const submitFood = async () => {
    if (!food.trim()) { toast.error("Tell Grace what you ate"); return; }
    setBusy(true);
    try {
      const r = await dashboardApi.logFood(food.trim());
      setFood("");
      done(r.logged.protein != null ? `Logged — about ${r.logged.protein}g protein` : "Meal logged");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't estimate that"); } finally { setBusy(false); }
  };

  const submitSymptom = async () => {
    if (!symptom) { toast.error("Pick a symptom"); return; }
    setBusy(true);
    try {
      const r = await dashboardApi.logSymptom(symptom, remedy.trim() || undefined);
      setSymptom(""); setRemedy("");
      done(r.pattern?.typicalTiming ? `Logged — Grace sees this usually hits ${r.pattern.typicalTiming}` : "Logged — Grace is learning your pattern");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't log that"); } finally { setBusy(false); }
  };

  const submitMood = async () => {
    setBusy(true);
    try { await dashboardApi.logMood(mood); done("Mood logged"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't log that"); } finally { setBusy(false); }
  };

  const submitWater = async (oz: number) => {
    if (!(oz > 0)) { toast.error("Enter how many ounces"); return; }
    setBusy(true);
    try { const r = await dashboardApi.logWater(oz); setWater(""); done(`Logged — ${r.today} oz today`); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't log that"); } finally { setBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await dashboardApi.uploadPhoto(dataUrl);
      if (r.kind === "food" && r.logged) done(`Logged your meal — about ${r.protein}g protein`);
      else if (r.kind === "food") { toast.message(r.ask || "Got it — tell me the portion in chat and I'll log it."); onLogged(); }
      else { toast.message("Analyzed 🤍", { description: r.analysis?.slice(0, 140) }); onLogged(); }
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't read that photo"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const tabs: Array<[Tab, string]> = [["weight", "Weight"], ["food", "Meal"], ["water", "Water"], ["symptom", "Symptom"], ["mood", "Mood"], ["photo", "Photo"]];

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <h3 className="mb-4 font-serif text-lg text-foreground">Log something</h3>
      <div className="mb-5 flex flex-wrap gap-2">
        {tabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={tab === t ? activeChip : chip}>{label}</button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          {tab === "weight" && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <input className={input} type="number" inputMode="decimal" placeholder={`Weight in ${wUnit}`} value={weight} onChange={(e) => setWeight(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitWeight()} />
                <div className="flex rounded-xl bg-secondary p-0.5 text-sm">
                  {(["lbs", "kg"] as const).map((u) => (
                    <button key={u} onClick={() => pickWUnit(u)}
                      className={`rounded-lg px-3 transition-colors ${wUnit === u ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>{u}</button>
                  ))}
                </div>
                <button className={primaryBtn} disabled={busy} onClick={submitWeight}>{busy ? "…" : "Log"}</button>
              </div>
            </div>
          )}

          {tab === "food" && (
            <div className="flex gap-3">
              <input className={input} placeholder="e.g. grilled chicken and rice" value={food} onChange={(e) => setFood(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitFood()} />
              <button className={primaryBtn} disabled={busy} onClick={submitFood}>{busy ? "…" : "Log"}</button>
            </div>
          )}

          {tab === "water" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {([["Glass", 8], ["Bottle", 16], ["Large", 24]] as const).map(([label, oz]) => (
                  <button key={label} onClick={() => submitWater(oz)} disabled={busy} className={chip}>
                    +{oz} oz <span className="text-muted-foreground">{label}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-3">
                <input className={input} type="number" inputMode="numeric" placeholder="Ounces" value={water} onChange={(e) => setWater(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitWater(Number(water))} />
                <button className={primaryBtn} disabled={busy} onClick={() => submitWater(Number(water))}>{busy ? "…" : "Log"}</button>
              </div>
            </div>
          )}

          {tab === "symptom" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {SYMPTOMS.map((s) => (
                  <button key={s} onClick={() => setSymptom(s)} className={symptom === s ? activeChip : chip} style={{ textTransform: "capitalize" }}>{s}</button>
                ))}
              </div>
              <input className={input} placeholder="What helped, if anything? (e.g. ginger tea)" value={remedy} onChange={(e) => setRemedy(e.target.value)} />
              <button className={`${primaryBtn} w-full`} disabled={busy} onClick={submitSymptom}>{busy ? "Logging…" : "Log symptom"}</button>
            </div>
          )}

          {tab === "mood" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-muted-foreground"><span>How are you feeling?</span><span className="font-serif text-2xl text-foreground">{mood}/10</span></div>
              <input type="range" min={1} max={10} value={mood} onChange={(e) => setMood(Number(e.target.value))} className="w-full accent-[#B05A41]" />
              <button className={`${primaryBtn} w-full`} disabled={busy} onClick={submitMood}>{busy ? "Logging…" : "Log mood"}</button>
            </div>
          )}

          {tab === "photo" && (
            <div className="space-y-3">
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="flex h-28 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-sand bg-secondary/30 text-sm text-muted-foreground transition-colors hover:border-primary disabled:opacity-50">
                {busy ? "Reading your photo…" : (<><span className="text-2xl">📷</span><span className="mt-1">Upload a meal or progress photo</span></>)}
              </button>
              <p className="text-xs text-muted-foreground">A clear meal photo gets logged automatically. Progress photos get a warm, private read — never logged.</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
