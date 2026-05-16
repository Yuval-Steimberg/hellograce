import { useState } from "react";
import { Shield, Check, Star, CreditCard, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import QuizButton from "./QuizButton";

const stripePromise = loadStripe("pk_test_51TWfwcLMk6wjvxD9YRSKqpEGOd93kuzD1g29iK67bvdlkfpdvriGGdeGXwpuoPJf3DwxyOZ77MimOIvzc4kOXCxK00Ny75zsRB");

interface PaymentStepProps {
  userId: string;
  firstName: string;
  onNext: () => void;
}

/* ─── Phase 1: Trial Timeline ─────────────────────────────────────── */

const TrialTimeline = ({
  firstName,
  onContinue,
  loading,
}: {
  firstName: string;
  onContinue: () => void;
  loading: boolean;
}) => {
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 3);
  const trialEndStr = trialEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="flex flex-col items-center w-full max-w-lg mx-auto">
      <div className="text-center mb-8">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-3">
          Almost there{firstName ? `, ${firstName}` : ""}
        </span>
        <h1 className="text-3xl md:text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-3">
          How your free trial works
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed max-w-sm mx-auto">
          No charge until your trial ends. Cancel anytime.
        </p>
      </div>

      {/* Timeline */}
      <div className="w-full px-2 mb-8">
        <div className="relative pl-8">
          {/* Vertical line */}
          <div className="absolute left-[11px] top-3 bottom-3 w-[2px] bg-gradient-to-b from-peach to-peach/30 rounded-full" />

          {/* Today */}
          <div className="relative pb-8">
            <div className="absolute left-[-25px] top-1 w-5 h-5 rounded-full bg-peach ring-4 ring-background flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
            <div>
              <p className="font-semibold text-foreground text-base">Today</p>
              <p className="text-muted-foreground text-sm leading-relaxed mt-1">
                Get instant access to personalized daily check-ins, meal ideas, and encouragement — all via text.
              </p>
            </div>
          </div>

          {/* Day 2 */}
          <div className="relative pb-8">
            <div className="absolute left-[-25px] top-1 w-5 h-5 rounded-full bg-peach/60 ring-4 ring-background flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
            <div>
              <p className="font-semibold text-foreground text-base">Day 2</p>
              <p className="text-muted-foreground text-sm leading-relaxed mt-1">
                We'll remind you that your free trial ends tomorrow. You can cancel anytime — no questions asked.
              </p>
            </div>
          </div>

          {/* Day 3 */}
          <div className="relative">
            <div className="absolute left-[-25px] top-1 w-5 h-5 rounded-full bg-peach/40 ring-4 ring-background flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
            <div>
              <p className="font-semibold text-foreground text-base">Day 3 — {trialEndStr}</p>
              <p className="text-muted-foreground text-sm leading-relaxed mt-1">
                Your subscription starts at $12/mo. You can cancel anytime from your settings.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom section */}
      <div className="w-full bg-secondary/50 rounded-2xl p-5 ring-1 ring-border/40 mb-6 text-center">
        <p className="text-foreground font-serif text-2xl mb-1">$0 due today</p>
        <p className="text-muted-foreground text-sm">No charge until your trial ends</p>
      </div>

      <div className="w-full mb-4">
        <QuizButton onClick={onContinue} disabled={loading}>
          {loading ? "Setting up..." : "Continue"}
        </QuizButton>
      </div>

      {/* Trust signals */}
      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Shield className="w-3.5 h-3.5" /> Cancel anytime
        </span>
        <span>•</span>
        <span>No charge today</span>
      </div>
    </div>
  );
};

/* ─── Phase 2: Payment Form (inside Elements) ────────────────────── */

const PaymentForm = ({
  firstName,
  userId,
  onSuccess,
  onBack,
}: {
  firstName: string;
  userId: string;
  onSuccess: () => void;
  onBack: () => void;
}) => {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [email, setEmail] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    try {
      // Save email to user record before confirming payment
      if (email.trim()) {
        await supabase.functions.invoke("update-user", {
          body: { userId, updates: { email: email.trim().toLowerCase() } },
        });
      }

      const { error } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/onboarding?checkout=success`,
          payment_method_data: {
            billing_details: {
              email: email.trim().toLowerCase() || undefined,
            },
          },
        },
      });

      if (error) {
        toast.error(error.message || "Payment setup failed. Please try again.");
      }
      // If no error, the user is redirected to return_url
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="flex flex-col items-center w-full max-w-lg mx-auto">
      <div className="text-center mb-6">
        <h1 className="text-3xl md:text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-3">
          Add payment method
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed max-w-sm mx-auto">
          You won't be charged today. Your 3-day free trial starts now.
        </p>
      </div>

      {/* Price summary */}
      <div className="w-full bg-secondary/50 rounded-2xl p-5 ring-1 ring-border/40 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-foreground font-medium">Due today</span>
          <span className="text-3xl font-serif text-foreground">$0</span>
        </div>
        <div className="h-px bg-border/60 mb-2" />
        <div className="flex items-center justify-between">
          <div>
            <span className="text-foreground text-sm font-medium block">After 3-day free trial</span>
            <span className="text-muted-foreground text-xs">Cancel anytime</span>
          </div>
          <span className="text-foreground font-serif text-lg">$12/mo</span>
        </div>
      </div>

      {/* Email input */}
      <form onSubmit={handleSubmit} className="w-full">
        <div className="w-full mb-4">
          <label className="text-foreground text-sm font-medium block mb-1.5">Email address</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full h-12 px-4 bg-card rounded-xl ring-1 ring-border/40 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-peach text-base font-sans"
          />
          <p className="text-muted-foreground text-xs mt-1">For your account & receipt</p>
        </div>

        <div className="w-full bg-card rounded-2xl p-5 ring-1 ring-border/40 mb-6">
          <PaymentElement
            options={{
              layout: "tabs",
            }}
          />
        </div>

        <div className="w-full mb-4">
          <button
            type="submit"
            disabled={!stripe || processing}
            className="w-full h-16 bg-primary hover:brightness-95 text-primary-foreground rounded-full text-lg font-medium tracking-wide transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Lock className="w-4 h-4 mr-2 inline" />
            {processing ? "Processing..." : "Start my free trial — $0 today"}
          </button>
        </div>
      </form>

      {/* Trust signals */}
      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground mb-6">
        <span className="flex items-center gap-1">
          <Shield className="w-3.5 h-3.5" /> Secure & encrypted
        </span>
        <span>•</span>
        <span>Cancel anytime</span>
        <span>•</span>
        <span>No charge today</span>
      </div>

      {/* Testimonial */}
      <div className="w-full bg-card rounded-2xl p-5 ring-1 ring-border/30 mb-4">
        <div className="flex gap-1 mb-2">
          {[1, 2, 3, 4, 5].map((s) => (
            <Star key={s} className="w-4 h-4 fill-peach text-peach" />
          ))}
        </div>
        <blockquote className="text-foreground text-sm leading-relaxed italic mb-2">
          "I wasn't sure about signing up, but the 3-day trial made it easy to try. By day 2, I was already looking forward to my morning check-in. It's like having a friend who actually gets what this journey is like."
        </blockquote>
        <cite className="text-muted-foreground text-xs not-italic">
          — Sarah M., on Mounjaro for 4 months
        </cite>
      </div>

      {/* Back link */}
      <button
        onClick={onBack}
        className="text-muted-foreground/60 hover:text-muted-foreground text-xs underline underline-offset-2 transition-colors mt-1"
      >
        Go back
      </button>
    </div>
  );
};

/* ─── Main PaymentStep ────────────────────────────────────────────── */

const PaymentStep = ({ userId, firstName, onNext }: PaymentStepProps) => {
  const [phase, setPhase] = useState<"timeline" | "payment">("timeline");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleContinueToPayment = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { userId },
      });
      if (error) {
        toast.error("Something went wrong. Please try again.");
        return;
      }
      if (data?.alreadyActive) {
        // Already paid — skip to confirmation
        onNext();
        return;
      }
      if (!data?.clientSecret) {
        toast.error("Something went wrong. Please try again.");
        return;
      }
      setClientSecret(data.clientSecret);
      setPhase("payment");
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (phase === "timeline" || !clientSecret) {
    return (
      <TrialTimeline
        firstName={firstName}
        onContinue={handleContinueToPayment}
        loading={loading}
      />
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#d4956a",
            colorBackground: "#faf5f0",
            colorText: "#3b2625",
            colorDanger: "#e53e3e",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            borderRadius: "12px",
            spacingUnit: "4px",
          },
          rules: {
            ".Input": {
              border: "1px solid hsl(20, 30%, 88%)",
              boxShadow: "none",
              padding: "12px 14px",
            },
            ".Input:focus": {
              border: "1px solid #d4956a",
              boxShadow: "0 0 0 1px #d4956a",
            },
            ".Tab": {
              border: "1px solid hsl(20, 30%, 88%)",
              boxShadow: "none",
            },
            ".Tab--selected": {
              border: "1px solid #d4956a",
              boxShadow: "0 0 0 1px #d4956a",
            },
          },
        },
      }}
    >
      <PaymentForm
        firstName={firstName}
        userId={userId}
        onSuccess={onNext}
        onBack={() => setPhase("timeline")}
      />
    </Elements>
  );
};

export default PaymentStep;
