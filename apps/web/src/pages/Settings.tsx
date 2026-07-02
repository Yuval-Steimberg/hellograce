import { useState, useEffect, useCallback } from "react";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";
import LegalFooter from "@/components/LegalFooter";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import PhoneInput from "@/components/onboarding/PhoneInput";
import {
  settingsApi,
  getSettingsToken,
  setSettingsToken,
  clearSettingsToken,
  type SettingsProfile,
  type SettingsUpdate,
} from "@/lib/settingsApi";
import {
  getWeightUnit, setWeightUnit as persistWeightUnit, getHeightUnit, setHeightUnit as persistHeightUnit,
  toLbs, fromLbs, cmToFeetInches, feetInchesToCm, type WeightUnit, type HeightUnit,
} from "@/lib/units";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MEDICATIONS = ["Ozempic", "Wegovy", "Mounjaro", "Zepbound", "Compounded semaglutide", "Compounded tirzepatide", "Rybelsus", "Other"];
const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix",
  "America/Toronto", "America/Mexico_City", "America/Sao_Paulo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Athens",
  "Asia/Jerusalem", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland", "Africa/Johannesburg",
];

const inputClass =
  "h-12 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-base text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";
const labelClass = "block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1";

type Stage = "phone" | "code" | "profile";

// Editable form mirror of the profile (strings for inputs).
interface FormState {
  first_name: string;
  medication: string;
  medication_frequency: string;
  dose_mg: string;
  injection_day: string;
  timezone: string;
  wake_time: string;
  sleep_time: string;
  current_weight: string;
  goal_weight: string;
  starting_weight: string;
  height_cm: string;
  age: string;
  sex: string;
  primary_goal: string;
  activity_level: string;
  protein_goal_grams: string;
  calorie_goal_kcal: string;
  dietary_pattern: string;
  dietary_restriction: string;
  food_dislikes: string;
  goals: string;
  checkin_count_per_day: string;
  checkin_days_interval: string;
  glp1_start_date: string;
}

// At-rest field encryption was dropped (the key is gone), but legacy rows may
// still hold an unrecoverable ciphertext blob (`enc:<iv>:<data>:<tag>`) for
// first_name / medication. Never load one into the form: it would display as
// garbage AND fail the save (blobs exceed the 120-char limit). Treat it as
// empty so the user can simply re-enter the value (saved as plaintext now).
const ENC_BLOB_RE = /^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;
const cleanField = (v: string | null | undefined): string =>
  v && ENC_BLOB_RE.test(v.trim()) ? "" : (v ?? "");

function profileToForm(p: SettingsProfile): FormState {
  const num = (n: number | null) => (n == null ? "" : String(n));
  return {
    first_name: cleanField(p.first_name),
    medication: cleanField(p.medication),
    medication_frequency: p.medication_frequency ?? "weekly",
    dose_mg: num(p.dose_mg),
    injection_day: p.injection_day ?? "",
    timezone: p.timezone ?? "America/New_York",
    wake_time: (p.wake_time ?? "07:00").slice(0, 5),
    sleep_time: (p.sleep_time ?? "22:00").slice(0, 5),
    current_weight: num(p.current_weight),
    goal_weight: num(p.goal_weight),
    starting_weight: num(p.starting_weight),
    height_cm: num(p.height_cm),
    age: num(p.age),
    sex: p.sex ?? "",
    primary_goal: p.primary_goal ?? "",
    activity_level: p.activity_level ?? "",
    protein_goal_grams: num(p.protein_goal_grams),
    calorie_goal_kcal: num(p.calorie_goal_kcal),
    dietary_pattern: p.dietary_pattern ?? "",
    dietary_restriction: p.dietary_restriction ?? "",
    food_dislikes: (p.food_dislikes ?? []).join(", "),
    goals: (p.goals ?? []).join(", "),
    checkin_count_per_day: num(p.checkin_count_per_day),
    checkin_days_interval: num(p.checkin_days_interval),
    glp1_start_date: p.glp1_start_date ? String(p.glp1_start_date).slice(0, 10) : "",
  };
}

function formToUpdate(f: FormState): SettingsUpdate {
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
  const strOrNull = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    first_name: f.first_name.trim() || undefined,
    medication: f.medication.trim() || undefined,
    medication_frequency: f.medication_frequency || undefined,
    dose_mg: numOrNull(f.dose_mg),
    injection_day: strOrNull(f.injection_day),
    timezone: f.timezone || undefined,
    wake_time: f.wake_time || undefined,
    sleep_time: f.sleep_time || undefined,
    current_weight: numOrNull(f.current_weight),
    goal_weight: numOrNull(f.goal_weight),
    starting_weight: numOrNull(f.starting_weight),
    height_cm: numOrNull(f.height_cm),
    age: numOrNull(f.age),
    sex: (f.sex || null) as SettingsUpdate["sex"],
    primary_goal: strOrNull(f.primary_goal),
    activity_level: strOrNull(f.activity_level),
    protein_goal_grams: numOrNull(f.protein_goal_grams),
    calorie_goal_kcal: numOrNull(f.calorie_goal_kcal),
    dietary_pattern: (f.dietary_pattern || null) as SettingsUpdate["dietary_pattern"],
    dietary_restriction: strOrNull(f.dietary_restriction),
    food_dislikes: f.food_dislikes ? f.food_dislikes.split(",").map((s) => s.trim()).filter(Boolean) : [],
    goals: f.goals ? f.goals.split(",").map((s) => s.trim()).filter(Boolean) : [],
    checkin_count_per_day: f.checkin_count_per_day ? Number(f.checkin_count_per_day) : undefined,
    checkin_days_interval: f.checkin_days_interval ? Number(f.checkin_days_interval) : undefined,
    glp1_start_date: strOrNull(f.glp1_start_date),
  };
}

const Settings = () => {
  const [stage, setStage] = useState<Stage>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<SettingsProfile | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [wUnit, setWUnit] = useState<WeightUnit>(getWeightUnit());
  const [hUnit, setHUnit] = useState<HeightUnit>(getHeightUnit());

  // Resume an existing verified session on load.
  useEffect(() => {
    (async () => {
      if (getSettingsToken()) {
        try {
          const { profile: p } = await settingsApi.me();
          setProfile(p);
          setForm(profileToForm(p));
          setStage("profile");
        } catch {
          clearSettingsToken();
        }
      }
      setBootLoading(false);
    })();
  }, []);

  const setField = useCallback((k: keyof FormState, v: string) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }, []);

  // ── Unit-aware helpers (form stores canonical lbs/cm; user sees their unit) ──
  const pickWUnit = (u: WeightUnit) => { setWUnit(u); persistWeightUnit(u); };
  const pickHUnit = (u: HeightUnit) => { setHUnit(u); persistHeightUnit(u); };
  // Weight field: convert stored lbs → display unit, and back on edit.
  const wDisplay = (lbsStr: string): string =>
    lbsStr.trim() === "" ? "" : String(fromLbs(Number(lbsStr), wUnit));
  const wOnChange = (key: keyof FormState, v: string) =>
    setField(key, v.trim() === "" ? "" : String(Math.round(toLbs(Number(v), wUnit) * 10) / 10));
  // Height (ft/in mode): derive feet/inches from stored cm; write cm on edit.
  const heightFt = form?.height_cm ? cmToFeetInches(Number(form.height_cm)).feet : 0;
  const heightIn = form?.height_cm ? cmToFeetInches(Number(form.height_cm)).inches : 0;
  const setHeightFtIn = (feet: number, inches: number) =>
    setField("height_cm", feet === 0 && inches === 0 ? "" : String(Math.round(feetInchesToCm(feet, inches))));

  const sendCode = async () => {
    if (phone.replace(/\D/g, "").length < 8) { toast.error("Enter a valid phone number"); return; }
    setBusy(true);
    try {
      await settingsApi.requestCode(phone);
      setStage("code");
      toast.success("We sent you a 6-digit code");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) { toast.error("Enter the 6-digit code"); return; }
    setBusy(true);
    try {
      const { token, profile: p } = await settingsApi.verifyCode(phone, code.trim());
      setSettingsToken(token);
      setProfile(p);
      setForm(profileToForm(p));
      setStage("profile");
      toast.success("Verified");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That code didn't work");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const { profile: p } = await settingsApi.update(formToUpdate(form));
      setProfile(p);
      setForm(profileToForm(p));
      toast.success("Saved — Grace will use this right away");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    clearSettingsToken();
    setProfile(null);
    setForm(null);
    setPhone("");
    setCode("");
    setStage("phone");
  };

  return (
    <div className="min-h-screen bg-background">
      <SEOHead title="Settings" description="Manage your Grace profile and preferences." noindex jsonLd={breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Settings", path: "/settings" }])} />
      <div className="max-w-2xl mx-auto px-5 py-10">
        <h1 className="font-serif text-3xl text-foreground mb-1">Your settings</h1>
        <p className="text-muted-foreground mb-8">Update your profile and preferences. Grace uses these right away.</p>

        {bootLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <AnimatePresence mode="wait">
            {stage === "phone" && (
              <motion.div key="phone" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-5">
                <p className="text-foreground">Enter your phone number and we'll text you a code to verify it's you.</p>
                <PhoneInput value={phone} onChange={setPhone} />
                <button onClick={sendCode} disabled={busy} className="h-12 px-6 rounded-full bg-primary text-white font-medium disabled:opacity-50">
                  {busy ? "Sending…" : "Send code"}
                </button>
              </motion.div>
            )}

            {stage === "code" && (
              <motion.div key="code" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-5">
                <p className="text-foreground">Enter the 6-digit code we sent to <span className="font-medium">{phone}</span>.</p>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" className={`${inputClass} tracking-[0.5em] text-2xl`} />
                <div className="flex items-center gap-4">
                  <button onClick={verify} disabled={busy} className="h-12 px-6 rounded-full bg-primary text-white font-medium disabled:opacity-50">
                    {busy ? "Verifying…" : "Verify"}
                  </button>
                  <button onClick={sendCode} disabled={busy} className="text-sm text-muted-foreground underline">Resend code</button>
                  <button onClick={() => setStage("phone")} className="text-sm text-muted-foreground underline">Change number</button>
                </div>
              </motion.div>
            )}

            {stage === "profile" && form && profile && (
              <motion.div key="profile" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-8">
                <div className="flex items-center justify-between rounded-xl bg-sand/30 px-4 py-3">
                  <div className="text-sm">
                    <span className="font-mono">{profile.phone}</span>
                    <span className="ml-2 text-muted-foreground">
                      {profile.is_pro ? "Pro" : profile.is_paid ? "Paid" : profile.trial_start ? "Trial" : "Free"}
                    </span>
                  </div>
                  <button onClick={logout} className="text-sm text-muted-foreground underline">Sign out</button>
                </div>

                <Section title="About you">
                  <Field label="First name"><input className={inputClass} value={form.first_name} onChange={(e) => setField("first_name", e.target.value)} placeholder="Your name" /></Field>
                  <Field label="Age"><input type="number" className={inputClass} value={form.age} onChange={(e) => setField("age", e.target.value)} /></Field>
                  <SelectField label="Sex" value={form.sex} onChange={(v) => setField("sex", v)} options={[["", "—"], ["female", "Female"], ["male", "Male"], ["other", "Other"]]} />
                  <Field label={<span className="flex items-center justify-between">Height <UnitToggle options={[["cm", "cm"], ["ftin", "ft/in"]]} value={hUnit} onChange={(v) => pickHUnit(v as HeightUnit)} /></span>}>
                    {hUnit === "cm" ? (
                      <input type="number" className={inputClass} value={form.height_cm} onChange={(e) => setField("height_cm", e.target.value)} placeholder="cm" />
                    ) : (
                      <div className="flex gap-2">
                        <input type="number" min={0} max={8} className={inputClass} value={form.height_cm ? String(heightFt) : ""} onChange={(e) => setHeightFtIn(Number(e.target.value) || 0, heightIn)} placeholder="ft" />
                        <input type="number" min={0} max={11} className={inputClass} value={form.height_cm ? String(heightIn) : ""} onChange={(e) => setHeightFtIn(heightFt, Number(e.target.value) || 0)} placeholder="in" />
                      </div>
                    )}
                  </Field>
                  <SelectField label="Timezone" value={form.timezone} onChange={(v) => setField("timezone", v)} options={TIMEZONES.map((t) => [t, t])} />
                </Section>

                <Section title="Medication">
                  <SelectField label="Medication" value={form.medication} onChange={(v) => setField("medication", v)} options={[["", "—"], ...MEDICATIONS.map((m) => [m, m] as [string, string])]} />
                  <SelectField label="Frequency" value={form.medication_frequency} onChange={(v) => setField("medication_frequency", v)} options={[["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["daily", "Daily"]]} />
                  <Field label="Dose (mg)"><input type="number" step="0.05" className={inputClass} value={form.dose_mg} onChange={(e) => setField("dose_mg", e.target.value)} /></Field>
                  <SelectField label="Injection day" value={form.injection_day} onChange={(v) => setField("injection_day", v)} options={[["", "—"], ...DAYS.map((d) => [d, d] as [string, string])]} />
                  <Field label="GLP-1 start date"><input type="date" className={inputClass} value={form.glp1_start_date} onChange={(e) => setField("glp1_start_date", e.target.value)} /></Field>
                </Section>

                <Section title="Body & goals">
                  <div className="sm:col-span-2 -mb-2 flex justify-end">
                    <UnitToggle options={[["lbs", "lbs"], ["kg", "kg"]]} value={wUnit} onChange={(v) => pickWUnit(v as WeightUnit)} />
                  </div>
                  <Field label={`Starting weight (${wUnit})`}><input type="number" className={inputClass} value={wDisplay(form.starting_weight)} onChange={(e) => wOnChange("starting_weight", e.target.value)} /></Field>
                  <Field label={`Current weight (${wUnit})`}><input type="number" className={inputClass} value={wDisplay(form.current_weight)} onChange={(e) => wOnChange("current_weight", e.target.value)} /></Field>
                  <Field label={`Goal weight (${wUnit})`}><input type="number" className={inputClass} value={wDisplay(form.goal_weight)} onChange={(e) => wOnChange("goal_weight", e.target.value)} /></Field>
                  <SelectField label="Primary goal" value={form.primary_goal} onChange={(v) => setField("primary_goal", v)} options={[["", "—"], ["fat_loss", "Fat loss"], ["muscle_gain", "Muscle gain"], ["maintenance", "Maintenance"], ["recomposition", "Recomposition"]]} />
                  <SelectField label="Activity level" value={form.activity_level} onChange={(v) => setField("activity_level", v)} options={[["", "—"], ["sedentary", "Sedentary"], ["light", "Light"], ["moderate", "Moderate"], ["active", "Active"], ["very_active", "Very active"]]} />
                  <Field label="Protein goal (g/day)"><input type="number" className={inputClass} value={form.protein_goal_grams} onChange={(e) => setField("protein_goal_grams", e.target.value)} /></Field>
                  <Field label="Calorie goal (kcal/day)"><input type="number" className={inputClass} value={form.calorie_goal_kcal} onChange={(e) => setField("calorie_goal_kcal", e.target.value)} /></Field>
                </Section>

                <Section title="Diet">
                  <SelectField label="Diet" value={form.dietary_pattern} onChange={(v) => setField("dietary_pattern", v)} options={[["", "No restriction"], ["vegan", "Vegan"], ["vegetarian", "Vegetarian"], ["pescatarian", "Pescatarian"]]} />
                  <Field label="Other diet (kosher, halal, gluten-free…)"><input className={inputClass} value={form.dietary_restriction} onChange={(e) => setField("dietary_restriction", e.target.value)} /></Field>
                  <Field label="Foods to avoid (comma-separated)" full><input className={inputClass} value={form.food_dislikes} onChange={(e) => setField("food_dislikes", e.target.value)} placeholder="broccoli, mushrooms" /></Field>
                  <Field label="Goals (comma-separated)" full><input className={inputClass} value={form.goals} onChange={(e) => setField("goals", e.target.value)} placeholder="Losing weight, Eating enough protein" /></Field>
                </Section>

                <Section title="Check-ins & reminders">
                  <Field label="Wake time"><input type="time" className={inputClass} value={form.wake_time} onChange={(e) => setField("wake_time", e.target.value)} /></Field>
                  <Field label="Sleep time"><input type="time" className={inputClass} value={form.sleep_time} onChange={(e) => setField("sleep_time", e.target.value)} /></Field>
                  <Field label="Check-ins per day (1–3)"><input type="number" min={1} max={3} className={inputClass} value={form.checkin_count_per_day} onChange={(e) => setField("checkin_count_per_day", e.target.value)} /></Field>
                  <Field label="Every N days (1–14)"><input type="number" min={1} max={14} className={inputClass} value={form.checkin_days_interval} onChange={(e) => setField("checkin_days_interval", e.target.value)} /></Field>
                </Section>

                <div className="sticky bottom-0 bg-background py-4 border-t border-sand">
                  <button onClick={save} disabled={busy} className="h-12 w-full rounded-full bg-primary text-white font-medium disabled:opacity-50">
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
      <LegalFooter />
    </div>
  );
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-serif text-xl text-foreground mb-4">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">{children}</div>
    </section>
  );
}

function Field({ label, children, full }: { label: React.ReactNode; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className={labelClass}>{label}</label>
      {children}
    </div>
  );
}

function UnitToggle({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-flex rounded-full bg-secondary p-0.5 text-xs normal-case tracking-normal">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`rounded-full px-2.5 py-0.5 transition-colors ${value === v ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>{l}</button>
      ))}
    </span>
  );
}

function SelectField({ label, value, onChange, options, full }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className={labelClass}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} appearance-none cursor-pointer`}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </div>
  );
}

export default Settings;
