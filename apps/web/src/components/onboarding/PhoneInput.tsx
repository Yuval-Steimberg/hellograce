import { useState, useRef } from "react";

const COUNTRIES = [
  { code: "+1", flag: "🇺🇸", label: "US", maxLen: 10 },
  { code: "+972", flag: "🇮🇱", label: "IL", maxLen: 9 },
];

interface PhoneInputProps {
  value: string;
  onChange: (fullPhone: string) => void;
  hasError?: boolean;
}

function formatUS(digits: string): string {
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function formatIL(digits: string): string {
  // Israeli mobile: 5X-XXX-XXXX (9 digits without leading 0)
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5, 9)}`;
}

const PhoneInput = ({ value, onChange, hasError }: PhoneInputProps) => {
  const detectInitial = () => {
    if (value?.startsWith("+972")) {
      return { country: COUNTRIES[1], local: value.slice(4).replace(/\D/g, "") };
    }
    if (value?.startsWith("+1")) {
      return { country: COUNTRIES[0], local: value.slice(2).replace(/\D/g, "") };
    }
    return { country: COUNTRIES[0], local: value?.replace(/\D/g, "") ?? "" };
  };

  const initial = useRef(detectInitial());
  const [country, setCountry] = useState(initial.current.country);
  const [localNumber, setLocalNumber] = useState(initial.current.local);
  const [open, setOpen] = useState(false);

  const handleLocalChange = (raw: string) => {
    let digits = raw.replace(/\D/g, "");
    // For IL, strip leading 0 (users often type 052... → store as 52...)
    if (country.code === "+972" && digits.startsWith("0")) {
      digits = digits.slice(1);
    }
    digits = digits.slice(0, country.maxLen);
    setLocalNumber(digits);
    onChange(`${country.code}${digits}`);
  };

  const handleSelectCountry = (c: typeof COUNTRIES[number]) => {
    setCountry(c);
    setOpen(false);
    const trimmed = localNumber.slice(0, c.maxLen);
    setLocalNumber(trimmed);
    onChange(`${c.code}${trimmed}`);
  };

  const formatted = country.code === "+972" ? formatIL(localNumber) : formatUS(localNumber);
  const placeholder = country.code === "+972" ? "52-123-4567" : "(555) 555-5555";

  return (
    <div className="relative">
      <div className={`flex items-center border-b-2 transition-colors ${hasError ? "border-destructive" : "border-sand focus-within:border-primary"}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2 py-4 text-lg shrink-0 hover:opacity-70 transition-opacity"
        >
          <span className="text-2xl">{country.flag}</span>
          <span className="text-muted-foreground text-base font-medium">{country.code}</span>
          <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <input
          type="tel"
          inputMode="numeric"
          placeholder={placeholder}
          value={formatted}
          onChange={(e) => handleLocalChange(e.target.value)}
          className="flex-1 h-16 outline-none bg-transparent font-serif text-2xl text-foreground placeholder:text-muted-foreground/30 transition-colors pl-2"
        />
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-2 bg-card border border-sand rounded-xl shadow-lg z-10 overflow-hidden min-w-[180px]">
          {COUNTRIES.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => handleSelectCountry(c)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors ${c.code === country.code ? "bg-muted/30" : ""}`}
            >
              <span className="text-2xl">{c.flag}</span>
              <span className="text-base text-foreground">{c.label}</span>
              <span className="text-sm text-muted-foreground ml-auto">{c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PhoneInput;
