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
import PhoneStep from "@/components/onboarding/PhoneStep";
import MedicationStep from "@/components/onboarding/MedicationStep";
import InjectionDayStep from "@/components/onboarding/InjectionDayStep";
import MedicationTimeStep from "@/components/onboarding/MedicationTimeStep";
import GoalsStep from "@/components/onboarding/GoalsStep";
import ScheduleStep from "@/components/onboarding/ScheduleStep";
import FoodStep from "@/components/onboarding/FoodStep";
import WeightStep from "@/components/onboarding/WeightStep";
import PaymentStep from "@/components/onboarding/PaymentStep";
import ConfirmationStep from "@/components/onboarding/ConfirmationStep";

const TOTAL_STEPS = 11;

const Onboarding = () => {
  const seoJsonLd = breadcrumbSchema([
    { name: "Home", path: "/" },
    { name: "Get Started", path: "/onboarding" },
  ]);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState("");
  const [searchParams] = useSearchParams();

  // User data
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
  const [foodDislikes, setFoodDislikes] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  const [checkinCountPerDay, setCheckinCountPerDay] = useState(2);
  const [checkinDaysInterval, setCheckinDaysInterval] = useState(1);

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [step]);

  // Handle Stripe checkout return
  useEffect(() => {
    const checkoutStatus = searchParams.get("checkout");
    if (checkoutStatus === "success") {
      // User completed checkout — confirm payment and trigger welcome SMS
      const storedId = localStorage.getItem("grace_user_id");
      if (storedId) {
        setUserId(storedId);
        supabase.functions.invoke("confirm-checkout", {
          body: { userId: storedId },
        }).catch((err) => console.error("Confirm checkout error:", err));
      }
      setStep(TOTAL_STEPS);
    } else if (checkoutStatus === "cancel") {
      // User cancelled checkout, stay on payment step
      const storedId = localStorage.getItem("grace_user_id");
      if (storedId) {
        setUserId(storedId);
        setStep(10); // payment step
      }
    }
  }, [searchParams]);

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
      const { data, error } = await supabase.functions.invoke("complete-onboarding", {
        body: {
          firstName: firstName.trim(),
          phone: phone.trim(),
          medication,
          medicationFrequency,
          injectionDay: medicationFrequency === "daily" ? null : injectionDay,
          medicationTime: medicationFrequency === "daily" ? medicationTime : null,
          wakeTime,
          sleepTime,
          foodDislikes: foodDislikes.trim() || null,
          currentWeight: currentWeight ? Number(currentWeight) : null,
          goalWeight: goalWeight ? Number(goalWeight) : null,
          goals,
          timezone,
          checkinCountPerDay,
          checkinDaysInterval,
        },
      });

      if (error) {
        console.error("Error saving user:", error);
        toast.error("Something went wrong saving your info. Please try again.");
        return;
      }

      // Store userId so Settings page can skip verification
      if (data?.userId) {
        localStorage.setItem("grace_user_id", data.userId);
        setUserId(data.userId);
      }

      next(); // Go to payment step (step 10)
    } catch (err) {
      console.error("Unexpected error:", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // Flow: Welcome → Name → Medication → Injection Day → Goals → Schedule → Food → Weight → Phone → Payment → Confirmation
  return (
    <>
      <SEOHead
        title="Get Started"
        description="Set up your personalized GLP-1 text companion in 2 minutes. Tell us about your medication, goals, and schedule."
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
        {step === 2 && <NameStep value={firstName} onChange={setFirstName} onNext={next} />}
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
        {step === 5 && <GoalsStep selected={goals} onChange={setGoals} onNext={next} />}
        {step === 6 && (
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
        {step === 7 && <FoodStep value={foodDislikes} onChange={setFoodDislikes} onNext={next} />}
        {step === 8 && (
          <WeightStep
            currentWeight={currentWeight}
            goalWeight={goalWeight}
            onChange={(d) => {
              if (d.currentWeight !== undefined) setCurrentWeight(d.currentWeight);
              if (d.goalWeight !== undefined) setGoalWeight(d.goalWeight);
            }}
            onNext={next}
          />
        )}
        {step === 9 && (
          <PhoneStep
            phone={phone}
            smsConsent={smsConsent}
            onChangePhone={setPhone}
            onChangeConsent={setSmsConsent}
            onNext={handleComplete}
            saving={saving}
          />
        )}
        {step === 10 && (
          <PaymentStep
            userId={userId}
            firstName={firstName}
            onNext={next}
          />
        )}
        {step === 11 && <ConfirmationStep firstName={firstName} phone={phone} />}
      </QuizLayout>
      <LegalFooter />
    </>
  );
};

export default Onboarding;
