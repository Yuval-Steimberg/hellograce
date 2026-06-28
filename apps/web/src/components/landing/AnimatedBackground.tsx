/**
 * Calm "dawn over cream paper" backdrop — a soft warm gradient (faint peach/gold
 * at the top fading into the cream page, a whisper of mint near the base). Echoes
 * the serene, atmospheric feel of a friendly companion app without any loud
 * color blobs. Static (no animation, no will-change) so it stays cheap on
 * mobile. Scoped via the `isolate` wrapper on the Landing page.
 */
const AnimatedBackground = () => (
  <div
    className="fixed inset-0 pointer-events-none"
    style={{ zIndex: -1 }}
    aria-hidden="true"
  >
    {/* Warm dawn wash */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: [
          "radial-gradient(ellipse 1200px 620px at 50% -16%, hsl(28 78% 80% / 0.30) 0%, transparent 64%)",
          "radial-gradient(ellipse 900px 560px at 92% 2%, hsl(346 70% 84% / 0.16) 0%, transparent 60%)",
          "radial-gradient(ellipse 1100px 760px at 50% 116%, hsl(158 50% 66% / 0.16) 0%, transparent 64%)",
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
