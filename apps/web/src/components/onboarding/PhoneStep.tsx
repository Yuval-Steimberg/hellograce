import { useState } from "react";
import { Link } from "react-router-dom";
import QuizButton from "./QuizButton";
import PhoneInput from "./PhoneInput";

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const WHATSAPP_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER as string | undefined) ?? "";
const WHATSAPP_JOIN_CODE = (import.meta.env.VITE_WHATSAPP_JOIN_CODE as string | undefined) ?? "";

interface PhoneStepProps {
  phone: string;
  smsConsent: boolean;
  onChangePhone: (phone: string) => void;
  onChangeConsent: (consent: boolean) => void;
  onNext: () => void;
  saving?: boolean;
}

const PhoneStep = ({
  phone,
  smsConsent,
  onChangePhone,
  onChangeConsent,
  onNext,
  saving,
}: PhoneStepProps) => {
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

  const isIL = phone.startsWith("+972");
  const digits = phone.replace(/\D/g, "");

  let localDigits = "";
  let isValidPhone = false;
  if (isIL) {
    localDigits = digits.slice(3);
    if (localDigits.startsWith("0")) localDigits = localDigits.slice(1);
    isValidPhone = localDigits.length === 9 && /^5\d{8}$/.test(localDigits);
  } else {
    localDigits = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
    isValidPhone = localDigits.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(localDigits);
  }

  const handleNext = async () => {
    if (!phone.trim() || !isValidPhone) {
      setError(isIL
        ? "Please enter a valid Israeli mobile number (e.g. 52-123-4567)"
        : "Please enter a valid 10-digit US phone number");
      return;
    }
    if (!smsConsent) {
      setError("I need your permission to send you texts");
      return;
    }
    setError("");

    // Check if phone is already registered
    if (API_BASE) {
      setChecking(true);
      try {
        const res = await fetch(`${API_BASE}/users/exists?phone=${encodeURIComponent(phone)}`);
        if (res.ok) {
          const data = await res.json() as { exists: boolean };
          if (data.exists) {
            setAlreadyRegistered(true);
            return;
          }
        }
      } catch {
        // If check fails, let onboarding proceed — better to allow a duplicate attempt than block a valid user
      } finally {
        setChecking(false);
      }
    }

    onNext();
  };

  const whatsappHref = WHATSAPP_NUMBER
    ? `https://wa.me/${WHATSAPP_NUMBER.replace(/\D/g, "")}${WHATSAPP_JOIN_CODE ? `?text=${encodeURIComponent(`join ${WHATSAPP_JOIN_CODE}`)}` : ""}`
    : "https://wa.me/";

  if (alreadyRegistered) {
    return (
      <>
        <div className="flex-1 pt-4 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6 mt-4">
            <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
            Already registered
          </span>
          <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
            You're already set up
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed mb-3 max-w-sm">
            This phone number already has a Grace account. Jump back into WhatsApp to continue your journey.
          </p>
          <p className="text-muted-foreground/60 text-sm mb-10">
            Using a different number?{" "}
            <button
              type="button"
              className="underline text-foreground hover:text-primary transition-colors"
              onClick={() => { setAlreadyRegistered(false); onChangePhone(""); }}
            >
              Go back and change it
            </button>
          </p>
        </div>
        <div className="mt-auto pt-6 flex flex-col gap-3">
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-2xl bg-[#25D366] text-white text-center font-semibold text-lg py-4 shadow-sm hover:bg-[#1ebe5d] transition-colors"
          >
            Open WhatsApp
          </a>
          <button
            type="button"
            onClick={() => { setAlreadyRegistered(false); onChangePhone(""); }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
          >
            Use a different number
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Almost done
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Where should I text you?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          This is how we'll stay in touch — everything happens over text.
        </p>

        <div className="mb-8">
          <PhoneInput
            value={phone}
            onChange={(v) => { onChangePhone(v); setError(""); }}
            hasError={!!error && !isValidPhone}
          />
        </div>

        <label className="flex items-start gap-4 cursor-pointer">
          <div className="mt-0.5 shrink-0">
            <input
              type="checkbox"
              checked={smsConsent}
              onChange={(e) => { onChangeConsent(e.target.checked); setError(""); }}
              className="sr-only peer"
            />
            <div className={`w-6 h-6 rounded-lg border-2 transition-all duration-200 flex items-center justify-center ${smsConsent ? "border-primary bg-primary" : "border-sand bg-card"}`}>
              {smsConsent && (
                <svg className="w-3.5 h-3.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          </div>
          <span className="text-sm text-muted-foreground leading-snug">
            Yes, I'd like to receive recurring automated SMS wellness messages from Grace. Message and data rates may apply. Message frequency varies. Reply STOP to opt out, HELP for help. See our{" "}
            <Link to="/privacy" target="_blank" className="underline hover:text-foreground transition-colors">Privacy Policy</Link>
            {" "}and{" "}
            <Link to="/terms" target="_blank" className="underline hover:text-foreground transition-colors">Terms of Service</Link>.
          </span>
        </label>

        {error && <p className="text-destructive text-sm mt-4">{error}</p>}
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={handleNext} disabled={saving || checking}>
          {checking ? "Checking…" : saving ? "Setting things up…" : "Continue"}
        </QuizButton>
      </div>
    </>
  );
};

export default PhoneStep;
