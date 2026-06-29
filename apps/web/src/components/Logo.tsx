interface LogoProps {
  /** Visual size — small (text-lg) | default (text-2xl) | large (text-4xl). */
  size?: "small" | "default" | "large";
  /** Kept for API compatibility; the mark is now wordmark-only, so this is a no-op. */
  markOnly?: boolean;
  className?: string;
}

const SIZES = {
  small: "text-lg",
  default: "text-2xl",
  large: "text-4xl md:text-5xl",
} as const;

/**
 * Grace logo — a clean serif wordmark, no icon. The brand mark is simply the
 * word "Grace" set in the site serif, used consistently across the nav, header,
 * menu, and footer.
 */
const Logo = ({ size = "default", className = "" }: LogoProps) => (
  <span
    className={`font-serif ${SIZES[size]} text-foreground leading-none ${className}`}
    style={{ letterSpacing: "-0.02em" }}
    aria-label="Grace"
  >
    Grace
  </span>
);

export default Logo;
