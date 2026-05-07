import { useState, useEffect } from "react";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";
import LegalFooter from "@/components/LegalFooter";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import QuizButton from "@/components/onboarding/QuizButton";
import QuizTile from "@/components/onboarding/QuizTile";
import PhoneInput from "@/components/onboarding/PhoneInput";

const DAYS = [
  { label: "Monday", short: "Mon" },
  { label: "Tuesday", short: "Tue" },
  { label: "Wednesday", short: "Wed" },
  { label: "Thursday", short: "Thu" },
  { label: "Friday", short: "Fri" },
  { label: "Saturday", short: "Sat" },
  { label: "Sunday", short: "Sun" },
];

const MEDICATIONS = [
  "Ozempic", "Wegovy", "Mounjaro", "Zepbound",
  "Compounded semaglutide", "Compounded tirzepatide", "Other",
];

const GOALS = [
  { label: "Losing weight", subtitle: "Sustainable progress at a healthy pace" },
  { label: "Eating enough protein", subtitle: "Staying nourished and strong" },
  { label: "Protecting my muscle", subtitle: "Staying strong while losing weight" },
  { label: "Staying hydrated", subtitle: "Building a consistent water habit" },
  { label: "Managing side effects", subtitle: "Navigating nausea, fatigue, and more" },
  { label: "Building better habits", subtitle: "Small daily wins that compound" },
  { label: "Feeling less alone in this", subtitle: "Having someone in your corner" },
  { label: "Hitting my fiber goals", subtitle: "Keeping digestion on track" },
];

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Phoenix",
  "America/Toronto", "America/Vancouver", "America/Mexico_City",
  "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
  "Europe/Amsterdam", "Europe/Stockholm", "Europe/Athens", "Europe/Moscow",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Singapore",
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Sydney", "Australia/Melbourne", "Australia/Perth",
  "Pacific/Auckland", "Africa/Johannesburg", "Africa/Cairo",
];

interface UserData {
  id: string;
  first_name: string;
  phone: string;
  email: string | null;
  medication: string;
  injection_day: string;
  goals: string[] | null;
  wake_time: string;
  sleep_time: string;
  food_dislikes: string | null;
  current_weight: number | null;
  goal_weight: number | null;
  timezone: string;
  is_pro: boolean;
  is_paid: boolean;
  checkin_frequency: string | null;
  checkin_count_per_day: number | null;
  checkin_days_interval: number | null;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const Settings = () => {
  const [verified, setVerified] = useState(false);
  const [phone, setPhone] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginMethod, setLoginMethod] = useState<"phone" | "email">("phone");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(true);

  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [userPhone, setUserPhone] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [medication, setMedication] = useState("");
  const [injectionDay, setInjectionDay] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [wakeTime, setWakeTime] = useState("07:00");
  const [sleepTime, setSleepTime] = useState("22:00");
  const [foodDislikes, setFoodDislikes] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [saving, setSaving] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [originalPhone, setOriginalPhone] = useState("");
  const [isPro, setIsPro] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [checkinFrequency, setCheckinFrequency] = useState("normal");
  const [checkinCountPerDay, setCheckinCountPerDay] = useState(2);
  const [checkinDaysInterval, setCheckinDaysInterval] = useState(1);

  // Try loading user from stored session on mount
  useEffect(() => {
    const storedId = localStorage.getItem("grace_user_id");
    if (storedId) {
      loadUserById(storedId);
    } else {
      setLoading(false);
    }
  }, []);

  const loadUserById = async (id: string) => {
    try {
      const { data, error } = await supabase.functions.invoke("get-user", {
        body: { userId: id },
      });
      if (error || !data?.user) {
        localStorage.removeItem("grace_user_id");
        setLoading(false);
        return;
      }
      populateUser(data.user as UserData);
      setVerified(true);
    } catch {
      localStorage.removeItem("grace_user_id");
    } finally {
      setLoading(false);
    }
  };

  const populateUser = (user: UserData) => {
    setUserId(user.id);
    setName(user.first_name);
    setUserPhone(user.phone || "");
    setOriginalPhone(user.phone || "");
    setUserEmail(user.email || "");
    setMedication(user.medication || "");
    setInjectionDay(user.injection_day);
    setGoals(user.goals || []);
    setWakeTime(user.wake_time?.slice(0, 5) || "07:00");
    setSleepTime(user.sleep_time?.slice(0, 5) || "22:00");
    setFoodDislikes(user.food_dislikes || "");
    setCurrentWeight(user.current_weight?.toString() || "");
    setGoalWeight(user.goal_weight?.toString() || "");
    setTimezone(user.timezone || "America/New_York");
    setIsPro(user.is_pro || false);
    setCheckinFrequency(user.checkin_frequency || "normal");
    setCheckinCountPerDay(user.checkin_count_per_day || 2);
    setCheckinDaysInterval(user.checkin_days_interval || 1);
  };

  const handleSendCode = async () => {
    if (loginMethod === "phone" && !phone.trim()) return;
    if (loginMethod === "email" && !loginEmail.trim()) return;
    setSending(true);
    try {
      const body = loginMethod === "phone"
        ? { phone: phone.trim() }
        : { email: loginEmail.trim().toLowerCase() };
      const { data, error } = await supabase.functions.invoke("send-verification-code", { body });
      if (error || (data && data.error)) {
        toast.error(data?.error || (loginMethod === "phone"
          ? "Couldn't send code. Is this the right number?"
          : "Couldn't send code. Is this the right email?"));
        setSending(false);
        return;
      }
      setCodeSent(true);
      toast.success(loginMethod === "phone"
        ? "Code sent! Check your messages 📱"
        : "Code sent! Check your email 📧");
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6) return;
    setVerifying(true);
    try {
      const body = loginMethod === "phone"
        ? { phone: phone.trim(), code }
        : { email: loginEmail.trim().toLowerCase(), code };
      const { data, error } = await supabase.functions.invoke("verify-code", { body });
      if (error || (data && data.error)) {
        toast.error(data?.error || "Invalid code. Try again.");
        setVerifying(false);
        return;
      }
      const user = data.user as UserData;
      populateUser(user);
      localStorage.setItem("grace_user_id", user.id);
      setVerified(true);
      toast.success(`Welcome back, ${user.first_name}!`);
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setVerifying(false);
    }
  };

  const handleGoalToggle = (goal: string) => {
    setGoals((prev) =>
      prev.includes(goal) ? prev.filter((g) => g !== goal) : [...prev, goal]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("update-user", {
        body: {
          userId,
          updates: {
            first_name: name.trim(),
            phone: userPhone.trim(),
            email: userEmail.trim().toLowerCase() || null,
            medication,
            injection_day: injectionDay,
            goals,
            wake_time: wakeTime + ":00",
            sleep_time: sleepTime + ":00",
            food_dislikes: foodDislikes.trim() || null,
            current_weight: currentWeight ? Number(currentWeight) : null,
            goal_weight: goalWeight ? Number(goalWeight) : null,
            timezone,
            checkin_frequency: checkinFrequency,
            checkin_count_per_day: checkinCountPerDay,
            checkin_days_interval: checkinDaysInterval,
          },
        },
      });
      if (error || (data && data.error)) {
        toast.error("Couldn't save. Try again.");
        setSaving(false);
        return;
      }
      const phoneChanged = userPhone.trim() !== originalPhone;
      if (phoneChanged) {
        setOriginalPhone(userPhone.trim());
        toast.success("Phone number updated — it may take a couple of hours for texts to arrive at your new number.", { duration: 6000 });
      } else {
        toast.success("Saved! You're all set ✓");
      }
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("customer-portal", {
        body: { userId },
      });
      if (error || !data?.url) {
        toast.error("Couldn't open subscription manager. Try again.");
        return;
      }
      window.open(data.url, "_blank");
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setPortalLoading(false);
    }
  };

  const handleUpgradeToPro = async () => {
    setUpgrading(true);
    try {
      const { data, error } = await supabase.functions.invoke("upgrade-to-pro", {
        body: { userId },
      });
      if (error || (!data?.success && !data?.alreadyPro)) {
        toast.error("Couldn't upgrade. Please try again.");
        return;
      }
      if (data?.alreadyPro) {
        toast.info("You're already on the Pro plan!");
      } else {
        toast.success("You've been upgraded to Grace Pro! 🎉");
      }
      setIsPro(true);
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setUpgrading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("grace_user_id");
    setVerified(false);
    setCodeSent(false);
    setCode("");
    setPhone("");
    setLoginEmail("");
    setLoginMethod("phone");
  };

  if (loading) {
    return (
      <>
        <SEOHead title="Settings" description="Manage your grace profile, schedule, and preferences." canonical="/settings" noindex />
        <div className="min-h-dvh bg-background flex items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <SEOHead
        title="Settings"
        description="Manage your grace profile, schedule, and preferences. Update your medication, goals, and notification times."
        canonical="/settings"
        noindex
        jsonLd={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Settings", path: "/settings" },
        ])}
      />
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md min-h-[85dvh] bg-card rounded-[2.5rem] shadow-[0_24px_64px_-12px_rgba(59,31,30,0.1)] ring-1 ring-border/40 flex flex-col overflow-hidden relative">
        {/* Progress bar */}
        <div className="w-full h-1.5 bg-sand/50">
          <motion.div
            className="h-full bg-peach"
            initial={{ width: 0 }}
            animate={{ width: verified ? "100%" : codeSent ? "50%" : "10%" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>

        {/* Header */}
        <div className="px-8 pt-6 pb-2 flex items-center justify-between">
          {verified ? (
            <button
              onClick={handleLogout}
              className="text-muted-foreground hover:text-foreground transition-colors text-xs font-semibold tracking-widest uppercase"
            >
              ← Log out
            </button>
          ) : (
            <div />
          )}
          <span className="text-xs font-semibold tracking-widest text-muted-foreground/60 uppercase">
            Settings
          </span>
        </div>

        <AnimatePresence mode="wait">
          {!verified ? (
            <motion.div
              key="verify"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3 }}
              className="flex-1 flex flex-col px-8 pb-8"
            >
              <div className="flex-1 pt-8">
                <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
                  Verification
                </span>
                <h1 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
                  {!codeSent
                    ? (loginMethod === "phone" ? "Verify your phone." : "Verify your email.")
                    : "Enter your code."}
                </h1>
                <p className="text-muted-foreground text-base leading-relaxed mb-10">
                  {!codeSent
                    ? (loginMethod === "phone"
                        ? "We'll send a code to the number you signed up with."
                        : "We'll send a code to the email you used at checkout.")
                    : (loginMethod === "phone"
                        ? "Check your texts — we just sent you a 6-digit code."
                        : "Check your email — we just sent you a 6-digit code.")}
                </p>

                {!codeSent ? (
                  <div className="w-full space-y-4">
                    {loginMethod === "phone" ? (
                      <PhoneInput value={phone} onChange={setPhone} />
                    ) : (
                      <input
                        type="email"
                        placeholder="you@example.com"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        className={inputClass}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setLoginMethod(loginMethod === "phone" ? "email" : "phone");
                        setCodeSent(false);
                        setCode("");
                      }}
                      className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
                    >
                      {loginMethod === "phone" ? "Log in with email instead" : "Log in with phone instead"}
                    </button>
                  </div>
                ) : (
                  <div className="w-full">
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                      className="w-full h-16 border-b-2 border-sand focus:border-primary outline-none bg-transparent font-serif text-3xl text-foreground tracking-[0.3em] text-center placeholder:text-muted-foreground/30 transition-colors rounded-none"
                    />
                  </div>
                )}
              </div>

              <div className="mt-auto pt-6">
                {!codeSent ? (
                  <QuizButton onClick={handleSendCode} disabled={sending}>
                    {sending ? "Sending..." : "Send verification code"}
                  </QuizButton>
                ) : (
                  <QuizButton onClick={handleVerify} disabled={code.length !== 6 || verifying}>
                    {verifying ? "Verifying..." : "Verify"}
                  </QuizButton>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="settings"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3 }}
              className="flex-1 flex flex-col px-8 pb-8 overflow-y-auto"
            >
              <div className="flex-1 pt-4">
                <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
                  Your profile
                </span>
                <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-3">
                  Your settings
                </h2>
                <p className="text-muted-foreground text-base leading-relaxed mb-8">
                  Update anything you need, {name}.
                </p>

                <div className="space-y-8">
                  {/* Name */}
                  <label className="flex flex-col gap-2">
                    <span className="text-foreground font-medium text-sm px-1">First name</span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className={inputClass}
                    />
                  </label>

                  {/* Phone */}
                  <label className="flex flex-col gap-2">
                    <span className="text-foreground font-medium text-sm px-1">Phone number</span>
                    <PhoneInput value={userPhone} onChange={setUserPhone} />
                    <span className="text-xs text-muted-foreground px-1">
                      We'll text you at this number
                    </span>
                  </label>

                  {/* Email */}
                  <label className="flex flex-col gap-2">
                    <span className="text-foreground font-medium text-sm px-1">Email</span>
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={userEmail}
                      onChange={(e) => setUserEmail(e.target.value)}
                      className={inputClass}
                    />
                    <span className="text-xs text-muted-foreground px-1">
                      For login only — doesn't change your Stripe billing email
                    </span>
                  </label>

                  {/* Medication */}
                  <div className="space-y-3">
                    <span className="text-foreground font-medium text-sm px-1">Medication</span>
                    <div className="flex flex-col gap-2">
                      {MEDICATIONS.map((med, i) => (
                        <QuizTile
                          key={med}
                          label={med}
                          selected={medication === med}
                          onClick={() => setMedication(med)}
                          index={i}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Injection day */}
                  <div className="space-y-3">
                    <span className="text-foreground font-medium text-sm px-1">Injection day</span>
                    <div className="flex flex-col gap-2">
                      {DAYS.map((day, i) => (
                        <QuizTile
                          key={day.short}
                          label={day.label}
                          selected={injectionDay === day.short}
                          onClick={() => setInjectionDay(day.short)}
                          index={i}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Goals */}
                  <div className="space-y-3">
                    <span className="text-foreground font-medium text-sm px-1">Your goals</span>
                    <div className="flex flex-col gap-2">
                      {GOALS.map((goal, i) => (
                        <QuizTile
                          key={goal.label}
                          label={goal.label}
                          subtitle={goal.subtitle}
                          selected={goals.includes(goal.label)}
                          onClick={() => handleGoalToggle(goal.label)}
                          index={i}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Schedule */}
                  <div className="grid grid-cols-2 gap-6">
                    <label className="flex flex-col gap-2">
                      <span className="text-foreground font-medium text-sm px-1">Wake time</span>
                      <input
                        type="time"
                        value={wakeTime}
                        onChange={(e) => setWakeTime(e.target.value)}
                        className={inputClass}
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-foreground font-medium text-sm px-1">Bed time</span>
                      <input
                        type="time"
                        value={sleepTime}
                        onChange={(e) => setSleepTime(e.target.value)}
                        className={inputClass}
                      />
                    </label>
                  </div>

                  {/* Check-in frequency */}
                  <div className="space-y-3">
                    <span className="text-foreground font-medium text-sm px-1">How often should Grace check in?</span>
                    <div className="flex flex-col gap-2">
                      {[
                        { label: "Twice a day", count: 2, interval: 1, freq: "normal" },
                        { label: "Once a day", count: 1, interval: 1, freq: "less" },
                        { label: "Every other day", count: 1, interval: 2, freq: "less" },
                      ].map((option, i) => (
                        <QuizTile
                          key={option.label}
                          label={option.label}
                          selected={checkinCountPerDay === option.count && checkinDaysInterval === option.interval}
                          onClick={() => {
                            setCheckinFrequency(option.freq);
                            setCheckinCountPerDay(option.count);
                            setCheckinDaysInterval(option.interval);
                          }}
                          index={i}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground px-1">
                      You can also just tell Grace directly — she'll update this for you.
                    </span>
                  </div>

                  {/* Timezone */}
                  <label className="flex flex-col gap-2">
                    <span className="text-foreground font-medium text-sm px-1">Timezone</span>
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className={inputClass + " cursor-pointer"}
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz.replace(/_/g, " ")}
                        </option>
                      ))}
                      {!TIMEZONES.includes(timezone) && (
                        <option value={timezone}>{timezone}</option>
                      )}
                    </select>
                  </label>

                  {/* Food dislikes */}
                  <label className="flex flex-col gap-2">
                    <span className="text-foreground font-medium text-sm px-1">Foods you won't eat</span>
                    <input
                      type="text"
                      placeholder="e.g. I'm vegetarian, I hate fish"
                      value={foodDislikes}
                      onChange={(e) => setFoodDislikes(e.target.value)}
                      className={inputClass}
                    />
                    <span className="text-xs text-muted-foreground px-1">Optional</span>
                  </label>

                  {/* Weights */}
                  <div className="grid grid-cols-2 gap-6">
                    <label className="flex flex-col gap-2">
                      <span className="text-foreground font-medium text-sm px-1">Current weight (lbs)</span>
                      <input
                        type="number"
                        placeholder="Optional"
                        value={currentWeight}
                        onChange={(e) => setCurrentWeight(e.target.value)}
                        className={inputClass}
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-foreground font-medium text-sm px-1">Goal weight (lbs)</span>
                      <input
                        type="number"
                        placeholder="Optional"
                        value={goalWeight}
                        onChange={(e) => setGoalWeight(e.target.value)}
                        className={inputClass}
                      />
                    </label>
                  </div>

                  {/* Subscription */}
                  <div className="space-y-3 pt-2">
                    <span className="text-foreground font-medium text-sm px-1">Your plan</span>
                    <div className="w-full bg-secondary/50 rounded-2xl p-5 ring-1 ring-border/40">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-foreground font-serif text-xl">{isPro ? "Grace Pro" : "Grace Base"}</span>
                        <span className="text-foreground font-medium">{isPro ? "$24/mo" : "$12/mo"}</span>
                      </div>
                      <p className="text-muted-foreground text-xs mb-3">
                        {isPro
                          ? "Unlimited daily SMS check-ins"
                          : "Up to 10 SMS messages per day (inbound + outbound)"}
                      </p>
                      {!isPro && (
                        <button
                          onClick={handleUpgradeToPro}
                          disabled={upgrading}
                          className="w-full h-12 rounded-full bg-peach hover:brightness-95 text-white font-medium text-sm transition-all mb-3 disabled:opacity-50"
                        >
                          {upgrading ? "Upgrading..." : "Upgrade to Pro — $24/mo"}
                        </button>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs px-1">
                      Manage your billing, update payment method, or cancel your plan.
                    </p>
                    <button
                      onClick={handleManageSubscription}
                      disabled={portalLoading}
                      className="w-full h-14 rounded-full ring-1 ring-border/60 bg-secondary/50 hover:bg-secondary text-foreground font-medium text-sm transition-colors disabled:opacity-50"
                    >
                      {portalLoading ? "Opening..." : "Manage subscription →"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-auto pt-6 sticky bottom-0 bg-gradient-to-t from-card via-card to-transparent">
                <QuizButton onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save changes"}
                </QuizButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </div>
      <LegalFooter />
    </>
  );
};

export default Settings;
