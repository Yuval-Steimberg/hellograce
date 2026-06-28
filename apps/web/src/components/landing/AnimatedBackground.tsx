/**
 * Calm "dawn over cream paper" backdrop — a soft warm gradient (faint peach/gold
 * at the top fading into the cream page, a whisper of mint near the base). Echoes
 * the serene, atmospheric feel of a friendly companion app without any loud
 * color blobs. Static (no animation, no will-change) so it stays cheap on
 * mobile. Scoped via the `isolate` wrapper on the Landing page.
 */
const AnimatedBackground = () => (
  <div
    className="fixed inset-0 pointer-events-none hidden lg:block"
    style={{ zIndex: -1 }}
    aria-hidden="true"
  >
    {/* Warm dawn wash */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: [
          "radial-gradient(ellipse 1200px 620px at 50% -16%, hsl(30 40% 86% / 0.45) 0%, transparent 66%)",
          "radial-gradient(ellipse 1000px 700px at 50% 118%, hsl(36 28% 82% / 0.4) 0%, transparent 66%)",
        ].join(", "),
      }}
    />
    {/* Faint dotted paper grain near the top */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage:
          "radial-gradient(hsl(30 30% 40% / 0.045) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
        maskImage:
          "radial-gradient(ellipse 100% 60% at 50% 0%, #000 0%, transparent 72%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 100% 60% at 50% 0%, #000 0%, transparent 72%)",
      }}
    />
  </div>
);

export default AnimatedBackground;
