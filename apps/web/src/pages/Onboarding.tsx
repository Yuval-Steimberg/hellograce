import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";
import LegalFooter from "@/components/LegalFooter";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import QuizLayout from "@/components/onboarding/QuizLayout";
import WelcomeStep from "@/components/onboarding/WelcomeStep";
import PhoneStep from "@/components/onboarding/PhoneStep";
import MedicationStep from "@/components/onboarding/MedicationStep";
import InjectionDayStep from "@/components/onboarding/InjectionDayStep";
import MedicationTimeStep from "@/components/onboarding/MedicationTimeStep";
import FoodStep from "@/components/onboarding/FoodStep";
import WeightStep from "@/components/onboarding/WeightStep";
import PaymentStep from "@/components/onboarding/PaymentStep";
import ConfirmationStep from "@/components/onboarding/ConfirmationStep";

// Minimal onboarding spec — only the fields Grace truly needs to start safely.
// Everything else (name, goals, schedule, age, primary goal, GLP-1 start date)
// gets learned naturally through conversation. Defaults are used for the
// scheduler-required fields (wake_time, sleep_time) and the user can change
// them via chat ("text me at 8am", "text me less").
const TOTAL_STEPS = 8;

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
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [rlhfConsent, setRlhfConsent] = useState(false);
  const [medication, setMedication] = useState("");
  const [medicationFrequency, setMedicationFrequency] = useState("weekly");
  const [injectionDay, setInjectionDay] = useState("");
  const [medicationTime, setMedicationTime] = useState("");
  const [sex, setSex] = useState("");
  const [foodDislikes, setFoodDislikes] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  const [heightCm, setHeightCm] = useState("");

  // Defaults — used by the scheduler if the user doesn't change them.
  // User can adjust via chat ("text me at 7am", "text me less").
  const wakeTime = "08:00";
  const sleepTime = "22:00";
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
        setStep(7); // payment step
      }
    }
  }, [searchParams]);

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
      const onboardBody = {
        // firstName intentionally omitted — Grace asks naturally in chat.
        phone: phone.trim(),
        medication,
        medicationFrequency,
        injectionDay: medicationFrequency === "daily" ? null : injectionDay,
        sex: sex || null,
        wakeTime,
        sleepTime,
        foodDislikes: foodDislikes.trim() || null,
        currentWeight: currentWeight ? Number(currentWeight) : null,
        goalWeight: goalWeight ? Number(goalWeight) : null,
        heightCm: heightCm ? Number(heightCm) : null,
        // age, primaryGoal, glp1StartDate, goals — all deferred to chat.
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

  // Minimal flow (8 steps):
  // Welcome → About You → Medication → Injection Day / Med Time → Food → Phone → Payment → Confirmation
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
        {step === 1 && <WelcomeStep onNext={next} />}
        {step === 2 && (
          <WeightStep
            sex={sex}
            currentWeight={currentWeight}
            goalWeight={goalWeight}
            heightCm={heightCm}
            onChange={(d) => {
              if (d.sex !== undefined) setSex(d.sex);
              if (d.currentWeight !== undefined) setCurrentWeight(d.currentWeight);
              if (d.goalWeight !== undefined) setGoalWeight(d.goalWeight);
              if (d.heightCm !== undefined) setHeightCm(d.heightCm);
            }}
            onNext={next}
          />
        )}
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
        {step === 4 && (
          medicationFrequency === "daily" ? (
            <MedicationTimeStep selected={medicationTime} onSelect={setMedicationTime} onNext={next} />
          ) : (
            <InjectionDayStep selected={injectionDay} onSelect={setInjectionDay} onNext={next} />
          )
        )}
        {step === 5 && <FoodStep value={foodDislikes} onChange={setFoodDislikes} onNext={next} />}
        {step === 6 && (
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
        {step === 7 && (
          <PaymentStep
            userId={userId}
            firstName=""
            onNext={next}
          />
        )}
        {step === 8 && <ConfirmationStep firstName="" phone={phone} />}
      </QuizLayout>
      <LegalFooter />
    </>
  );
};

export default Onboarding;
