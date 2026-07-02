import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { dashboardApi } from "@/lib/dashboardApi";

const SYMPTOMS = [
  "nausea", "vomiting", "constipation", "diarrhea", "fatigue",
  "headache", "dizziness", "heartburn", "bloating",
] as const;

const chip = "rounded-full border border-sand bg-white px-4 py-2 text-sm text-foreground/80 transition-colors hover:border-primary hover:text-foreground";
const activeChip = "rounded-full border border-primary bg-primary px-4 py-2 text-sm text-white";
const input = "h-12 w-full rounded-xl border border-sand bg-white px-4 text-base text-foreground outline-none focus:border-primary transition-colors";
const primaryBtn = "h-12 rounded-full bg-primary px-6 font-medium text-white disabled:opacity-50";

type Tab = "weight" | "food" | "symptom" | "mood" | "photo";

/** Downscale + re-encode a File to a JPEG data URL (max ~1024px) so uploads stay
 *  small and fast, and land as a clean image the vision model reads reliably. */
function fileToDataUrl(file: File, maxDim = 1024, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("canvas unavailable")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image")); };
    img.src = url;
  });
}

export function QuickLog({ onLogged }: { onLogged: () => void }) {
  const [tab, setTab] = useState<Tab>("weight");
  const [busy, setBusy] = useState(false);
  const [weight, setWeight] = useState("");
  const [food, setFood] = useState("");
  const [symptom, setSymptom] = useState<string>("");
  const [remedy, setRemedy] = useState("");
  const [mood, setMood] = useState(6);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (msg: string) => { toast.success(msg); onLogged(); };

  const submitWeight = async () => {
    const w = Number(weight);
    if (!Number.isFinite(w) || w < 60 || w > 700) { toast.error("Enter a weight in lbs"); return; }
    setBusy(true);
    try { await dashboardApi.logWeight(w); setWeight(""); done("Weight logged"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't log that"); } finally { setBusy(false); }
  };

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

  const tabs: Array<[Tab, string]> = [["weight", "Weight"], ["food", "Meal"], ["symptom", "Symptom"], ["mood", "Mood"], ["photo", "Photo"]];

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
            <div className="flex gap-3">
              <input className={input} type="number" inputMode="decimal" placeholder="Weight in lbs" value={weight} onChange={(e) => setWeight(e.target.value)} />
              <button className={primaryBtn} disabled={busy} onClick={submitWeight}>{busy ? "…" : "Log"}</button>
            </div>
          )}

          {tab === "food" && (
            <div className="flex gap-3">
              <input className={input} placeholder="e.g. grilled chicken and rice" value={food} onChange={(e) => setFood(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitFood()} />
              <button className={primaryBtn} disabled={busy} onClick={submitFood}>{busy ? "…" : "Log"}</button>
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
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
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
