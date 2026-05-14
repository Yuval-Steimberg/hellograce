/**
 * Subtle static background — two soft radial gradients in brand colors
 * (terracotta top-right, sage bottom-left). No animation, no will-change,
 * no GPU pressure on mobile. Scoped via isolate on the Landing wrapper.
 */
const AnimatedBackground = () => (
  <div
    className="fixed inset-0 pointer-events-none"
    style={{ zIndex: -1 }}
    aria-hidden="true"
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: [
          "radial-gradient(ellipse 900px 700px at 92% -8%, hsl(16 55% 80% / 0.32) 0%, transparent 68%)",
          "radial-gradient(ellipse 800px 700px at -4% 108%, hsl(102 20% 72% / 0.22) 0%, transparent 68%)",
        ].join(", "),
      }}
    />
  </div>
);

export default AnimatedBackground;
