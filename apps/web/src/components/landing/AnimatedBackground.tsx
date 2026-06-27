/**
 * Calm tech-health backdrop — a soft mint/teal radial mesh on cool white,
 * plus a faint dotted grid for a subtle "product" texture. Static (no
 * animation, no will-change) so it stays cheap on mobile. Scoped via the
 * `isolate` wrapper on the Landing page.
 */
const AnimatedBackground = () => (
  <div
    className="fixed inset-0 pointer-events-none"
    style={{ zIndex: -1 }}
    aria-hidden="true"
  >
    {/* Color mesh */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: [
          "radial-gradient(ellipse 900px 720px at 88% -10%, hsl(153 71% 70% / 0.20) 0%, transparent 62%)",
          "radial-gradient(ellipse 820px 700px at -6% 8%, hsl(188 55% 55% / 0.14) 0%, transparent 60%)",
          "radial-gradient(ellipse 1000px 800px at 50% 118%, hsl(158 64% 60% / 0.16) 0%, transparent 64%)",
        ].join(", "),
      }}
    />
    {/* Faint dotted grid */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage:
          "radial-gradient(hsl(188 30% 40% / 0.06) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
        maskImage:
          "radial-gradient(ellipse 100% 70% at 50% 0%, #000 0%, transparent 75%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 100% 70% at 50% 0%, #000 0%, transparent 75%)",
      }}
    />
  </div>
);

export default AnimatedBackground;
