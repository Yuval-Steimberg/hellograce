import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Shield, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import PhoneInput from "@/components/onboarding/PhoneInput";
import QuizButton from "@/components/onboarding/QuizButton";
import PaymentStep from "@/components/onboarding/PaymentStep";
import SEOHead from "@/components/SEOHead";

type Phase = "verify-phone" | "enter-code" | "payment" | "already-paid";

interface UserInfo {
  id: string;
  first_name: string | null;
  is_paid: boolean;
  is_pro: boolean;
}

export default function Upgrade() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const phoneFromUrl = searchParams.get("phone") ?? "";

  const [phase, setPhase] = useState<Phase>("verify-phone");
  const [phone, setPhone] = useState(phoneFromUrl);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);

  // If there's already a stored session, skip straight to payment check
  useEffect(() => {
    const storedId = localStorage.getItem("grace_user_id");
    if (!storedId) return;
    supabase.functions
      .invoke("get-user", { body: { userId: storedId } })
      .then(({ data }) => {
        if (!data?.user) return;
        handleUserVerified(data.user as UserInfo);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleUserVerified(u: UserInfo) {
    localStorage.setItem("grace_user_id", u.id);
    setUser(u);
    if (u.is_paid || u.is_pro) {
      setPhase("already-paid");
    } else {
      setPhase("payment");
    }
  }

  const handleSendCode = async () => {
    if (!phone.trim()) return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-verification-code", {
        body: { phone: phone.trim() },
      });
      if (error || data?.error) {
        toast.error(data?.error ?? "Couldn't send code. Is this the right number?");
        return;
      }
      setPhase("enter-code");
      toast.success("Code sent! Check your messages 📱");
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
      const { data, error } = await supabase.functions.invoke("verify-code", {
        body: { phone: phone.trim(), code },
      });
      if (error || data?.error) {
        toast.error(data?.error ?? "Invalid code. Try again.");
        return;
      }
      handleUserVerified(data.user as UserInfo);
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setVerifying(false);
    }
  };

  const handleManageSubscription = async () => {
    if (!user) return;
    await openCustomerPortal(user.id, /* attempt */ 1);
  };

  // Stripe's customers.search() takes ~30-60s to index newly-created customers.
  // If the user JUST subscribed and clicks "Manage", the first call returns
  // `no_stripe_customer`. We auto-retry once after a short delay before
  // surfacing the error. Frontend retry is faster than asking the user to wait.
  const openCustomerPortal = async (userId: string, attempt: number): Promise<void> => {
    try {
      const { data, error } = await supabase.functions.invoke("customer-portal", {
        body: { userId },
      });

      if (!error && data?.url) {
        window.open(data.url, "_blank");
        return;
      }

      // Edge function now returns { error, code } — read both.
      const code = (data as { code?: string } | null | undefined)?.code
        || (error as { context?: { code?: string } } | null | undefined)?.context?.code;
      const message = (data as { error?: string } | null | undefined)?.error
        || error?.message
        || "Couldn't open subscription manager. Try again.";

      if (code === "no_stripe_customer" && attempt < 2) {
        toast.info("Just a moment — finalizing your subscription…");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await openCustomerPortal(userId, attempt + 1);
        return;
      }

      if (code === "portal_not_configured") {
        toast.error("Subscription manager isn't configured yet. Please contact support.");
        return;
      }

      toast.error(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  const inputClass =
    "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

  return (
    <>
      <SEOHead
        title="Subscribe to Grace"
        description="Start your Grace subscription and continue your GLP-1 journey."
        canonical="/upgrade"
        noindex
      />
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md min-h-[85dvh] bg-card rounded-[2.5rem] shadow-[0_24px_64px_-12px_rgba(59,31,30,0.1)] ring-1 ring-border/40 flex flex-col overflow-hidden relative">
          {/* Header */}
          <div className="px-8 pt-6 pb-2 flex items-center justify-between">
            <div />
            <span className="text-xs font-semibold tracking-widest text-muted-foreground/60 uppercase">
              Subscribe
            </span>
          </div>

          <AnimatePresence mode="wait">
            {/* Step 1: enter phone */}
            {phase === "verify-phone" && (
              <motion.div
                key="phone"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="flex-1 flex flex-col px-8 pb-8"
              >
                <div className="flex-1 pt-8">
                  <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
                    Verify your identity
                  </span>
                  <h1 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
                    Let's pick up where you left off.
                  </h1>
                  <p className="text-muted-foreground text-base leading-relaxed mb-10">
                    Enter the phone number you signed up with and we'll send you a code.
                  </p>
                  <PhoneInput value={phone} onChange={setPhone} />
                </div>
                <div className="mt-auto pt-6">
                  <QuizButton onClick={handleSendCode} disabled={sending || !phone.trim()}>
                    {sending ? "Sending..." : "Send verification code"}
                  </QuizButton>
                </div>
              </motion.div>
            )}

            {/* Step 2: enter OTP */}
            {phase === "enter-code" && (
              <motion.div
                key="code"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="flex-1 flex flex-col px-8 pb-8"
              >
                <div className="flex-1 pt-8">
                  <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
                    Enter your code
                  </span>
                  <h1 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
                    Check your messages.
                  </h1>
                  <p className="text-muted-foreground text-base leading-relaxed mb-10">
                    We just sent a 6-digit code to {phone}.
                  </p>
                  <input
                    type="text"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full h-16 border-b-2 border-sand focus:border-primary outline-none bg-transparent font-serif text-3xl text-foreground tracking-[0.3em] text-center placeholder:text-muted-foreground/30 transition-colors rounded-none"
                  />
                </div>
                <div className="mt-auto pt-6 space-y-3">
                  <QuizButton onClick={handleVerify} disabled={code.length !== 6 || verifying}>
                    {verifying ? "Verifying..." : "Continue"}
                  </QuizButton>
                  <button
                    type="button"
                    onClick={() => { setPhase("verify-phone"); setCode(""); }}
                    className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
                  >
                    Back
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Payment */}
            {phase === "payment" && user && (
              <motion.div
                key="payment"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.3 }}
                className="flex-1 overflow-y-auto px-8 pb-8 pt-4"
              >
                <PaymentStep
                  userId={user.id}
                  firstName={user.first_name ?? ""}
                  onNext={() => setPhase("already-paid")}
                />
              </motion.div>
            )}

            {/* Already paid / success */}
            {phase === "already-paid" && (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35 }}
                className="flex-1 flex flex-col items-center justify-center px-8 pb-8 text-center"
              >
                <CheckCircle className="h-14 w-14 text-primary mb-6" strokeWidth={1.5} />
                <h1 className="text-4xl font-serif text-foreground tracking-tight mb-3">
                  You're all set.
                </h1>
                <p className="text-muted-foreground text-base leading-relaxed mb-10 max-w-xs">
                  Your Grace subscription is active. Head back to WhatsApp — I'm here whenever you need me.
                </p>
                <div className="w-full space-y-3">
                  <button
                    onClick={handleManageSubscription}
                    className="w-full h-14 rounded-full ring-1 ring-border/60 bg-secondary/50 hover:bg-secondary text-foreground font-medium text-sm transition-colors"
                  >
                    Manage subscription →
                  </button>
                  <button
                    onClick={() => navigate("/settings")}
                    className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
                  >
                    Go to settings
                  </button>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-8">
                  <Shield className="w-3.5 h-3.5" />
                  Cancel anytime from Settings
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
