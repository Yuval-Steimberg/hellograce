import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";
import LegalFooter from "@/components/LegalFooter";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import QuizLayout from "@/components/onboarding/QuizLayout";
import WelcomeStep from "@/components/onboarding/WelcomeStep";
import NameStep from "@/components/onboarding/NameStep";
import MedicationStep from "@/components/onboarding/MedicationStep";
import InjectionDayStep from "@/components/onboarding/InjectionDayStep";
import MedicationTimeStep from "@/components/onboarding/MedicationTimeStep";
import GoalsStep from "@/components/onboarding/GoalsStep";
import ScheduleStep from "@/components/onboarding/ScheduleStep";
import FoodStep from "@/components/onboarding/FoodStep";
import PhoneStep from "@/components/onboarding/PhoneStep";
import PaymentStep from "@/components/onboarding/PaymentStep";
import ConfirmationStep from "@/components/onboarding/ConfirmationStep";

// Fast, essentials-first onboarding:
// 1. Welcome
// 2. Name
// 3. Medication
// 4. Injection Day / Med Time
// 5. Goals
// 6. Food safety + preferences
// 7. Schedule
// 8. Phone + consent
// 9. Payment/trial
// 10. Confirmation
// Body metrics and deeper context are learned later, only when useful.
const TOTAL_STEPS = 10;

const Onboarding = () => {
  const seoJsonLd = breadcrumbSchema([
    { name: "Home", path: "/" },
    { name: "Get Started", path: "/onboarding" },
  ]);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState("");
  const [searchParams] = useSearchParams();

  // Core profile fields — collected in the form.
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [medication, setMedication] = useState("");
  const [medicationFrequency, setMedicationFrequency] = useState("weekly");
  const [injectionDay, setInjectionDay] = useState("");
  const [medicationTime, setMedicationTime] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [wakeTime, setWakeTime] = useState("07:00");
  const [sleepTime, setSleepTime] = useState("22:00");
  const [sex, setSex] = useState("");
  const [foodDislikes, setFoodDislikes] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  /** Optional baseline weight at start of GLP-1 journey. Added 2026-06-06
   *  per coverage audit. Empty string = leave NULL in the DB. */
  const [startingWeight, setStartingWeight] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [age, setAge] = useState("");
  const [activityLevel, setActivityLevel] = useState("");
  const [glp1StartDate, setGlp1StartDate] = useState("");
  const [doseMg, setDoseMg] = useState("");
  const [dietaryRestriction, setDietaryRestriction] = useState("");
  const [biggestChallenge, setBiggestChallenge] = useState("");
  const [whyStarted, setWhyStarted] = useState("");
  const [supportStyle, setSupportStyle] = useState("");
  const [exerciseHabits, setExerciseHabits] = useState<string[]>([]);

  const checkinCountPerDay = 2;
  const checkinDaysInterval = 1;

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [step]);

  // Handle Stripe checkout return
  useEffect(() => {
    const checkoutStatus = searchParams.get("checkout");
    if (checkoutStatus === "success") {
      const storedId = localStorage.getItem("grace_user_id");
      if (storedId) {
        setUserId(storedId);
        supabase.functions.invoke("confirm-checkout", {
          body: { userId: storedId },
        }).catch((err) => console.error("Confirm checkout error:", err));
      }
      setStep(TOTAL_STEPS);
    } else if (checkoutStatus === "cancel") {
      const storedId = localStorage.getItem("grace_user_id");
      if (storedId) {
        setUserId(storedId);
        setStep(9); // payment step
      }
    }
  }, [searchParams]);

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
      const onboardBody = {
        firstName: firstName.trim() || undefined,
        phone: phone.trim(),
        medication,
        medicationFrequency,
        injectionDay: medicationFrequency === "daily" ? null : injectionDay,
        medicationTime: medicationFrequency === "daily" ? (medicationTime || null) : null,
        smsConsent,
        sex: sex || null,
        goals: goals.length > 0 ? goals : undefined,
        wakeTime,
        sleepTime,
        foodDislikes: foodDislikes.trim() || null,
        currentWeight: currentWeight ? Number(currentWeight) : null,
        goalWeight: goalWeight ? Number(goalWeight) : null,
        startingWeight: startingWeight ? Number(startingWeight) : null,
        heightCm: heightCm ? Number(heightCm) : null,
        age: age ? Number(age) : null,
        activityLevel: activityLevel || null,
        glp1StartDate: glp1StartDate || null,
        doseMg: doseMg ? Number(doseMg) : null,
        dietaryRestriction: dietaryRestriction && dietaryRestriction !== "none" ? dietaryRestriction : null,
        biggestChallenge: biggestChallenge || null,
        whyStarted: whyStarted || null,
        supportStyle: supportStyle || null,
        exerciseHabits: exerciseHabits.length > 0 ? exerciseHabits.join(',') : null,
        timezone,
        checkinCountPerDay,
        checkinDaysInterval,
      };

      let resultUserId: string | undefined;
      const v2ApiUrl = import.meta.env.VITE_API_URL as string | undefined;

      if (v2ApiUrl) {
        const resp = await fetch(`${v2ApiUrl}/users/onboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(onboardBody),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({})) as { message?: string };
          throw new Error(err.message ?? `HTTP ${resp.status}`);
        }
        const data = await resp.json() as { ok: boolean; userId: string };
        resultUserId = data.userId;
      } else {
        const { data, error } = await supabase.functions.invoke("complete-onboarding", {
          body: onboardBody,
        });
        if (error) throw new Error(error.message ?? "Supabase error");
        resultUserId = (data as { userId?: string })?.userId;
      }

      if (resultUserId) {
        localStorage.setItem("grace_user_id", resultUserId);
        setUserId(resultUserId);
      }

      next(); // Go to payment step
    } catch (err) {
      console.error("Onboarding error:", err);
      toast.error("Something went wrong saving your info. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SEOHead
        title="Get Started"
        description="Set up your personalized GLP-1 text companion in under 2 minutes. Just the essentials — Grace learns the rest as you chat."
        canonical="/onboarding"
        noindex
        jsonLd={seoJsonLd}
      />
      <QuizLayout
        currentStep={step}
        totalSteps={TOTAL_STEPS}
        onBack={back}
        showBack={step > 1 && step < TOTAL_STEPS}
      >
        {/* Step 1: Welcome */}
        {step === 1 && <WelcomeStep onNext={next} />}

        {/* Step 2: Name */}
        {step === 2 && (
          <NameStep
            value={firstName}
            onChange={setFirstName}
            onNext={next}
          />
        )}

        {/* Step 3: Medication */}
        {step === 3 && (
          <MedicationStep
            selected={medication}
            onSelect={(med, freq) => {
              setMedication(med);
              setMedicationFrequency(freq);
            }}
            onNext={next}
          />
        )}

        {/* Step 4: Injection Day or Med Time */}
        {step === 4 && (
          medicationFrequency === "daily" ? (
            <MedicationTimeStep selected={medicationTime} onSelect={setMedicationTime} onNext={next} />
          ) : (
            <InjectionDayStep selected={injectionDay} onSelect={setInjectionDay} onNext={next} />
          )
        )}

        {/* Step 5: Goals */}
        {step === 5 && (
          <GoalsStep selected={goals} onChange={setGoals} onNext={next} />
        )}

        {/* Step 6: Food preferences */}
        {step === 6 && (
          <FoodStep
            foodDislikes={foodDislikes}
            dietaryRestriction={dietaryRestriction}
            onChangeDislikes={setFoodDislikes}
            onChangeDietary={setDietaryRestriction}
            onNext={next}
          />
        )}

        {/* Step 7: Schedule */}
        {step === 7 && (
          <ScheduleStep
            wakeTime={wakeTime}
            sleepTime={sleepTime}
            onChange={(d) => {
              if (d.wakeTime !== undefined) setWakeTime(d.wakeTime);
              if (d.sleepTime !== undefined) setSleepTime(d.sleepTime);
            }}
            onNext={next}
          />
        )}

        {/* Step 8: Phone + consent */}
        {step === 8 && (
          <PhoneStep
            phone={phone}
            smsConsent={smsConsent}
            onChangePhone={setPhone}
            onChangeConsent={setSmsConsent}
            onNext={handleComplete}
            saving={saving}
          />
        )}

        {/* Step 9: Payment/trial */}
        {step === 9 && (
          <PaymentStep
            userId={userId}
            firstName={firstName}
            onNext={next}
          />
        )}

        {/* Step 10: Confirmation */}
        {step === 10 && <ConfirmationStep firstName={firstName} phone={phone} />}
      </QuizLayout>
      <LegalFooter />
    </>
  );
};

export default Onboarding;
