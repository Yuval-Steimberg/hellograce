import { useState } from "react";
import QuizButton from "./QuizButton";
import {
  getWeightUnit, setWeightUnit as persistWeightUnit, getHeightUnit, setHeightUnit as persistHeightUnit,
  toLbs, fromLbs, cmToFeetInches, feetInchesToCm, type WeightUnit, type HeightUnit,
} from "@/lib/units";

function UnitToggle({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-flex rounded-full bg-secondary p-0.5 text-xs">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`rounded-full px-2.5 py-0.5 transition-colors ${value === v ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>{l}</button>
      ))}
    </span>
  );
}

interface AboutYouData {
  sex?: string;
  currentWeight?: string;
  goalWeight?: string;
  /** Optional baseline weight at start of GLP-1 journey. Added 2026-06-06
   *  per the coverage audit (Area 8). Empty string = leave NULL — Grace
   *  must never fabricate a baseline. */
  startingWeight?: string;
  heightCm?: string;
  age?: string;
  activityLevel?: string;
}

interface AboutYouProps {
  sex: string;
  currentWeight: string;
  goalWeight: string;
  startingWeight?: string;
  heightCm: string;
  age: string;
  activityLevel: string;
  onChange: (data: AboutYouData) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const errorInputClass =
  "h-16 w-full border-b-2 border-destructive focus:border-destructive outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const SEX_OPTIONS: { value: string; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'nonbinary', label: 'Non-binary' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const ACTIVITY_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: 'sedentary', label: 'Sedentary', description: 'Little or no exercise' },
  { value: 'lightly_active', label: 'Lightly Active', description: 'Light exercise 1-3 days/week' },
  { value: 'moderate', label: 'Moderate', description: 'Moderate exercise 3-5 days/week' },
  { value: 'very_active', label: 'Very Active', description: 'Hard exercise 6-7 days/week' },
];

const WeightStep = ({
  sex,
  currentWeight,
  goalWeight,
  startingWeight = '',
  heightCm,
  age,
  activityLevel,
  onChange,
  onNext,
}: AboutYouProps) => {
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const [wUnit, setWUnit] = useState<WeightUnit>(getWeightUnit());
  const [hUnit, setHUnit] = useState<HeightUnit>(getHeightUnit());

  // Parent state stays canonical (weights in lbs, height in cm); the user sees +
  // types in their chosen unit and we convert on the way in/out.
  const pickWUnit = (u: WeightUnit) => { setWUnit(u); persistWeightUnit(u); };
  const pickHUnit = (u: HeightUnit) => { setHUnit(u); persistHeightUnit(u); };
  const wDisplay = (lbsStr: string): string => (lbsStr.trim() === "" ? "" : String(fromLbs(Number(lbsStr), wUnit)));
  const wOnChange = (field: keyof AboutYouData, v: string) =>
    onChange({ [field]: v.trim() === "" ? "" : String(Math.round(toLbs(Number(v), wUnit) * 10) / 10) });
  const heightFt = heightCm ? cmToFeetInches(Number(heightCm)).feet : 0;
  const heightIn = heightCm ? cmToFeetInches(Number(heightCm)).inches : 0;
  const setHeightFtIn = (feet: number, inches: number) =>
    onChange({ heightCm: feet === 0 && inches === 0 ? "" : String(Math.round(feetInchesToCm(feet, inches))) });

  const missing: string[] = [];
  if (!sex) missing.push("sex");
  if (!heightCm) missing.push("height");
  if (!age) missing.push("age");
  if (!currentWeight) missing.push("current weight");
  if (!goalWeight) missing.push("goal weight");
  if (!activityLevel) missing.push("activity level");

  const handleNext = () => {
    setTouched(true);
    if (missing.length > 0) {
      setError("Please fill in all fields to continue");
      return;
    }
    const h = Number(heightCm);
    const a = Number(age);
    const cw = Number(currentWeight);
    const gw = Number(goalWeight);
    if (h < 100 || h > 260) { setError("Please enter a valid height"); return; }
    if (a < 13 || a > 120) { setError("Age should be between 13 and 120"); return; }
    if (cw < 50 || cw > 700) { setError("Please enter a valid current weight"); return; }
    if (gw < 50 || gw > 700) { setError("Please enter a valid goal weight"); return; }
    // Starting weight is optional — only validate if provided. Empty string
    // = leave the column NULL; Grace will say "not on file" rather than
    // fabricate. Per coverage audit 2026-06-06.
    if (startingWeight && startingWeight.trim().length > 0) {
      const sw = Number(startingWeight);
      if (!Number.isFinite(sw) || sw < 50 || sw > 700) {
        setError("Please enter a valid starting weight, or leave it blank");
        return;
      }
    }
    setError("");
    onNext();
  };

  const showFieldError = (field: string) => touched && missing.includes(field);

  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          About you
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Tell me a little about you
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          So every message I send feels made for you — your body, your goals, your pace. This stays just between us.
        </p>

        <div className="space-y-7">
          <div className="flex flex-col gap-3">
            <span className={`font-medium text-sm px-1 ${showFieldError("sex") ? "text-destructive" : "text-foreground"}`}>
              Sex {showFieldError("sex") && <span className="text-destructive text-xs ml-1">Required</span>}
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              {SEX_OPTIONS.map((opt) => {
                const active = sex === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => { onChange({ sex: active ? '' : opt.value }); setError(""); }}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
                      active
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : showFieldError("sex")
                          ? 'border-destructive/40 hover:border-primary/50 hover:bg-card/50'
                          : 'border-sand hover:border-primary/50 hover:bg-card/50'
                    }`}
                  >
                    <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <label className="flex flex-col gap-2">
              <span className={`flex items-center justify-between font-medium text-sm px-1 ${showFieldError("height") ? "text-destructive" : "text-foreground"}`}>
                <span>Height {showFieldError("height") && <span className="text-xs">*</span>}</span>
                <UnitToggle options={[["cm", "cm"], ["ftin", "ft/in"]]} value={hUnit} onChange={(v) => { pickHUnit(v as HeightUnit); setError(""); }} />
              </span>
              {hUnit === "cm" ? (
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="e.g. 168"
                  value={heightCm}
                  onChange={(e) => { onChange({ heightCm: e.target.value }); setError(""); }}
                  className={showFieldError("height") ? errorInputClass : inputClass}
                />
              ) : (
                <div className="flex gap-2">
                  <input type="number" inputMode="numeric" placeholder="ft" value={heightCm ? String(heightFt) : ""}
                    onChange={(e) => { setHeightFtIn(Number(e.target.value) || 0, heightIn); setError(""); }}
                    className={showFieldError("height") ? errorInputClass : inputClass} />
                  <input type="number" inputMode="numeric" placeholder="in" value={heightCm ? String(heightIn) : ""}
                    onChange={(e) => { setHeightFtIn(heightFt, Number(e.target.value) || 0); setError(""); }}
                    className={showFieldError("height") ? errorInputClass : inputClass} />
                </div>
              )}
            </label>
            <label className="flex flex-col gap-2">
              <span className={`font-medium text-sm px-1 ${showFieldError("age") ? "text-destructive" : "text-foreground"}`}>
                Age {showFieldError("age") && <span className="text-xs">*</span>}
              </span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 34"
                value={age}
                onChange={(e) => { onChange({ age: e.target.value }); setError(""); }}
                className={showFieldError("age") ? errorInputClass : inputClass}
              />
            </label>
          </div>

          <div className="flex justify-end -mb-3">
            <UnitToggle options={[["lbs", "lbs"], ["kg", "kg"]]} value={wUnit} onChange={(v) => { pickWUnit(v as WeightUnit); setError(""); }} />
          </div>
          <div className="grid grid-cols-2 gap-5">
            <label className="flex flex-col gap-2">
              <span className={`font-medium text-sm px-1 ${showFieldError("current weight") ? "text-destructive" : "text-foreground"}`}>
                Current weight ({wUnit}) {showFieldError("current weight") && <span className="text-xs">*</span>}
              </span>
              <input
                type="number"
                inputMode="numeric"
                placeholder={wUnit === "kg" ? "e.g. 80" : "e.g. 175"}
                value={wDisplay(currentWeight)}
                onChange={(e) => { wOnChange("currentWeight", e.target.value); setError(""); }}
                className={showFieldError("current weight") ? errorInputClass : inputClass}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className={`font-medium text-sm px-1 ${showFieldError("goal weight") ? "text-destructive" : "text-foreground"}`}>
                Goal weight ({wUnit}) {showFieldError("goal weight") && <span className="text-xs">*</span>}
              </span>
              <input
                type="number"
                inputMode="numeric"
                placeholder={wUnit === "kg" ? "e.g. 68" : "e.g. 150"}
                value={wDisplay(goalWeight)}
                onChange={(e) => { wOnChange("goalWeight", e.target.value); setError(""); }}
                className={showFieldError("goal weight") ? errorInputClass : inputClass}
              />
            </label>
          </div>

          {/* Optional starting weight — added 2026-06-06 per coverage audit.
              Defaults to empty; Grace will never invent a baseline if left blank. */}
          <label className="flex flex-col gap-2">
            <span className="font-medium text-sm px-1 text-foreground">
              Starting weight ({wUnit}) <span className="text-muted-foreground text-xs ml-1">— optional</span>
            </span>
            <input
              type="number"
              inputMode="numeric"
              placeholder="The weight you started at, if you remember"
              value={wDisplay(startingWeight)}
              onChange={(e) => { wOnChange("startingWeight", e.target.value); setError(""); }}
              className={inputClass}
            />
            <span className="text-xs text-muted-foreground/70 px-1">
              I'll use this to show your total loss. Leave blank if you'd rather not — I won't guess.
            </span>
          </label>

          <div className="flex flex-col gap-3">
            <span className={`font-medium text-sm px-1 ${showFieldError("activity level") ? "text-destructive" : "text-foreground"}`}>
              Activity level {showFieldError("activity level") && <span className="text-destructive text-xs ml-1">Required</span>}
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              {ACTIVITY_OPTIONS.map((opt) => {
                const active = activityLevel === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => { onChange({ activityLevel: active ? '' : opt.value }); setError(""); }}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
                      active
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : showFieldError("activity level")
                          ? 'border-destructive/40 hover:border-primary/50 hover:bg-card/50'
                          : 'border-sand hover:border-primary/50 hover:bg-card/50'
                    }`}
                  >
                    <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                    <div className="text-muted-foreground text-xs mt-0.5">{opt.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {error && <p className="text-destructive text-sm mt-5 px-1">{error}</p>}
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={handleNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default WeightStep;
