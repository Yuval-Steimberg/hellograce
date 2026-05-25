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
import WeightStep from "@/components/onboarding/WeightStep";
import GLP1DetailStep from "@/components/onboarding/GLP1DetailStep";
import PersonalContextStep from "@/components/onboarding/PersonalContextStep";
import LifestyleStep from "@/components/onboarding/LifestyleStep";
import PhoneStep from "@/components/onboarding/PhoneStep";
import PaymentStep from "@/components/onboarding/PaymentStep";
import ConfirmationStep from "@/components/onboarding/ConfirmationStep";

// 14-step onboarding flow:
// 1. Welcome
// 2. Name
// 3. About you (sex, height, age, weight, goal weight, activity level) — all required
// 4. Medication
// 5. Injection Day / Med Time
// 6. GLP-1 details (start date, dose)
// 7. Goals
// 8. Your story (biggest challenge, why started, support style)
// 9. Food preferences (dietary style + dislikes — one screen)
// 10. Schedule (wake/sleep)
// 11. Daily life (exercise)
// 12. Phone + consent
// 13. Payment/trial
// 14. Confirmation
const TOTAL_STEPS = 14;

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
  const [rlhfConsent, setRlhfConsent] = useState(false);
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
        setStep(13); // payment step
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
        sex: sex || null,
        goals: goals.length > 0 ? goals : undefined,
        wakeTime,
        sleepTime,
        foodDislikes: foodDislikes.trim() || null,
        currentWeight: currentWeight ? Number(currentWeight) : null,
        goalWeight: goalWeight ? Number(goalWeight) : null,
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
        rlhfEnabled: rlhfConsent,
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

        {/* Step 3: About you (sex, height, age, weight, goal, activity) — all required */}
        {step === 3 && (
          <WeightStep
            sex={sex}
            currentWeight={currentWeight}
            goalWeight={goalWeight}
            heightCm={heightCm}
            age={age}
            activityLevel={activityLevel}
            onChange={(d) => {
              if (d.sex !== undefined) setSex(d.sex);
              if (d.currentWeight !== undefined) setCurrentWeight(d.currentWeight);
              if (d.goalWeight !== undefined) setGoalWeight(d.goalWeight);
              if (d.heightCm !== undefined) setHeightCm(d.heightCm);
              if (d.age !== undefined) setAge(d.age);
              if (d.activityLevel !== undefined) setActivityLevel(d.activityLevel);
            }}
            onNext={next}
          />
        )}

        {/* Step 4: Medication */}
        {step === 4 && (
          <MedicationStep
            selected={medication}
            onSelect={(med, freq) => {
              setMedication(med);
              setMedicationFrequency(freq);
            }}
            onNext={next}
          />
        )}

        {/* Step 5: Injection Day or Med Time */}
        {step === 5 && (
          medicationFrequency === "daily" ? (
            <MedicationTimeStep selected={medicationTime} onSelect={setMedicationTime} onNext={next} />
          ) : (
            <InjectionDayStep selected={injectionDay} onSelect={setInjectionDay} onNext={next} />
          )
        )}

        {/* Step 6: GLP-1 details (start date, dose) */}
        {step === 6 && (
          <GLP1DetailStep
            glp1StartDate={glp1StartDate}
            doseMg={doseMg}
            onChange={(d) => {
              if (d.glp1StartDate !== undefined) setGlp1StartDate(d.glp1StartDate);
              if (d.doseMg !== undefined) setDoseMg(d.doseMg);
            }}
            onNext={next}
          />
        )}

        {/* Step 7: Goals */}
        {step === 7 && (
          <GoalsStep
            selected={goals}
            onChange={setGoals}
            onNext={next}
          />
        )}

        {/* Step 8: Your story (challenge, why, support style) */}
        {step === 8 && (
          <PersonalContextStep
            biggestChallenge={biggestChallenge}
            whyStarted={whyStarted}
            supportStyle={supportStyle}
            onChange={(d) => {
              if (d.biggestChallenge !== undefined) setBiggestChallenge(d.biggestChallenge);
              if (d.whyStarted !== undefined) setWhyStarted(d.whyStarted);
              if (d.supportStyle !== undefined) setSupportStyle(d.supportStyle);
            }}
            onNext={next}
          />
        )}

        {/* Step 9: Food preferences (dietary style + dislikes) */}
        {step === 9 && (
          <FoodStep
            foodDislikes={foodDislikes}
            dietaryRestriction={dietaryRestriction}
            onChangeDislikes={setFoodDislikes}
            onChangeDietary={setDietaryRestriction}
            onNext={next}
          />
        )}

        {/* Step 10: Schedule (wake/sleep) */}
        {step === 10 && (
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

        {/* Step 11: Daily life (exercise) */}
        {step === 11 && (
          <LifestyleStep
            exerciseHabits={exerciseHabits}
            onChange={(d) => {
              if (d.exerciseHabits) setExerciseHabits(d.exerciseHabits);
            }}
            onNext={next}
          />
        )}

        {/* Step 12: Phone + consent */}
        {step === 12 && (
          <PhoneStep
            phone={phone}
            smsConsent={smsConsent}
            rlhfConsent={rlhfConsent}
            onChangePhone={setPhone}
            onChangeConsent={setSmsConsent}
            onChangeRlhfConsent={setRlhfConsent}
            onNext={handleComplete}
            saving={saving}
          />
        )}

        {/* Step 13: Payment/trial */}
        {step === 13 && (
          <PaymentStep
            userId={userId}
            firstName={firstName}
            onNext={next}
          />
        )}

        {/* Step 14: Confirmation */}
        {step === 14 && <ConfirmationStep firstName={firstName} phone={phone} />}
      </QuizLayout>
      <LegalFooter />
    </>
  );
};

export default Onboarding;
