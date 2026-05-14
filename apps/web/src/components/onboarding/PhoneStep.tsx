import { useState } from "react";
import { Link } from "react-router-dom";
import QuizButton from "./QuizButton";
import PhoneInput from "./PhoneInput";

interface PhoneStepProps {
  phone: string;
  smsConsent: boolean;
  rlhfConsent: boolean;
  onChangePhone: (phone: string) => void;
  onChangeConsent: (consent: boolean) => void;
  onChangeRlhfConsent: (consent: boolean) => void;
  onNext: () => void;
  saving?: boolean;
}

const PhoneStep = ({
  phone,
  smsConsent,
  rlhfConsent,
  onChangePhone,
  onChangeConsent,
  onChangeRlhfConsent,
  onNext,
  saving,
}: PhoneStepProps) => {
  const [error, setError] = useState("");

  const isIL = phone.startsWith("+972");
  const isUS = phone.startsWith("+1");
  const digits = phone.replace(/\D/g, "");

  let localDigits = "";
  let isValidPhone = false;
  if (isIL) {
    localDigits = digits.slice(3); // strip 972
    if (localDigits.startsWith("0")) localDigits = localDigits.slice(1);
    // IL mobile: 9 digits, starts with 5
    isValidPhone = localDigits.length === 9 && /^5\d{8}$/.test(localDigits);
  } else {
    localDigits = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
    isValidPhone = localDigits.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(localDigits);
  }

  const handleNext = () => {
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
    onNext();
  };

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

        <label className="flex items-start gap-4 cursor-pointer mt-5">
          <div className="mt-0.5 shrink-0">
            <input
              type="checkbox"
              checked={rlhfConsent}
              onChange={(e) => onChangeRlhfConsent(e.target.checked)}
              className="sr-only peer"
            />
            <div className={`w-6 h-6 rounded-lg border-2 transition-all duration-200 flex items-center justify-center ${rlhfConsent ? "border-primary bg-primary" : "border-sand bg-card"}`}>
              {rlhfConsent && (
                <svg className="w-3.5 h-3.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          </div>
          <span className="text-sm text-muted-foreground leading-snug">
            Help improve Grace by rating her replies (optional). She'll occasionally ask if a message was helpful — your feedback shapes the model.
          </span>
        </label>

        {error && <p className="text-destructive text-sm mt-4">{error}</p>}
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={handleNext} disabled={saving}>
          {saving ? "Setting things up…" : "Continue"}
        </QuizButton>
      </div>
    </>
  );
};

export default PhoneStep;
