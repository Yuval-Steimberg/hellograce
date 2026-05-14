interface LogoProps {
  /** Visual size — small (24px mark) | default (32px) | large (44px). */
  size?: "small" | "default" | "large";
  /** Disable the wordmark for compact contexts (favicon-style). */
  markOnly?: boolean;
  className?: string;
}

const SIZES = {
  small: { mark: 24, text: "text-lg", gap: "gap-2" },
  default: { mark: 32, text: "text-2xl", gap: "gap-2.5" },
  large: { mark: 44, text: "text-4xl md:text-5xl", gap: "gap-3" },
} as const;

/**
 * grace logo — refined botanical sprig + wordmark.
 *
 * The mark uses two design tokens:
 * - text-primary  →  sage stem and the inner leaf veins
 * - text-accent   →  terracotta leaves (warm contrast against sage)
 *
 * SVG is hand-tuned to look balanced at 24-44px. Wordmark is set in the
 * site's serif (Cormorant) with negative tracking and a hair more weight
 * than the body text for confidence.
 */
const Logo = ({ size = "default", markOnly = false, className = "" }: LogoProps) => {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center ${s.gap} ${className}`} aria-label="grace">
      <svg
        width={s.mark}
        height={s.mark}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
        aria-hidden="true"
        style={{
          // Resolve design tokens to actual hsl colors for SVG-friendly use.
          ["--mark-primary" as never]: "hsl(var(--primary))",
          ["--mark-accent" as never]: "hsl(var(--accent))",
        }}
      >
        {/* Soft circular halo — barely visible, gives the mark grounding */}
        <circle cx="16" cy="16" r="15" fill="var(--mark-accent)" opacity="0.08" />

        {/* Stem — sage primary, gently S-curved like a young sprout */}
        <path
          d="M16 27 C 16 22 14.5 18 15.5 13 C 16.5 8.5 16 5 16.5 4"
          stroke="var(--mark-primary)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />

        {/* Right leaf (upper) — terracotta */}
        <path
          d="M16 8 C 19 7 22 5 24 3.5 C 23.2 7 20 9.5 16 10 Z"
          fill="var(--mark-accent)"
        />
        <path
          d="M16 9 C 18 7.5 20 6 22 5"
          stroke="var(--mark-primary)"
          strokeOpacity="0.4"
          strokeWidth="0.7"
          strokeLinecap="round"
        />

        {/* Left leaf (lower) — terracotta, slightly larger */}
        <path
          d="M15.6 17 C 11.5 17 7.8 15 5.5 12.5 C 7 16.5 10.5 19 15.6 19 Z"
          fill="var(--mark-accent)"
        />
        <path
          d="M15 18 C 12 16.8 9.5 15.5 7.5 13.8"
          stroke="var(--mark-primary)"
          strokeOpacity="0.4"
          strokeWidth="0.7"
          strokeLinecap="round"
        />
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
