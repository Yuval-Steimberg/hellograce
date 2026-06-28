interface LogoProps {
  /** Visual size — small (28px mark) | default (36px) | large (48px). */
  size?: "small" | "default" | "large";
  /** Disable the wordmark for compact contexts (favicon-style). */
  markOnly?: boolean;
  className?: string;
}

const SIZES = {
  small: { mark: 28, text: "text-lg", gap: "gap-2" },
  default: { mark: 36, text: "text-2xl", gap: "gap-2.5" },
  large: { mark: 48, text: "text-4xl md:text-5xl", gap: "gap-3" },
} as const;

/**
 * grace logo — a cream disc with a serif "g" and a small clay underline accent.
 * Rendered as crisp SVG (the "g" uses the site serif) so it scales cleanly and
 * matches the brand mark exactly.
 */
const Logo = ({ size = "default", markOnly = false, className = "" }: LogoProps) => {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center ${s.gap} ${className}`} aria-label="grace">
      <svg
        width={s.mark}
        height={s.mark}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
        aria-hidden="true"
      >
        <circle cx="32" cy="32" r="31" fill="#F1E7DC" />
        <text
          x="32"
          y="44"
          textAnchor="middle"
          fontFamily="'Playfair Display', Georgia, serif"
          fontSize="40"
          fill="#3A2A21"
          style={{ fontStyle: "normal" }}
        >
          g
        </text>
        <rect x="27" y="49" width="10" height="2" rx="1" fill="#B05A41" />
      </svg>

      {!markOnly && (
        <span
          className={`font-serif ${s.text} text-foreground tracking-tight leading-none`}
          style={{ letterSpacing: "-0.02em" }}
        >
          grace
        </span>
      )}
    </span>
  );
};

export default Logo;
