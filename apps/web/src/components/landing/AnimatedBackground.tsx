/**
 * Animated mesh background — floats colorful blurred orbs behind the landing
 * content. Pure CSS keyframes (transform-only) so it stays GPU-cheap.
 * Honors prefers-reduced-motion via the .motion-safe variant in index.css.
 */
const AnimatedBackground = () => {
  return (
    <div
      className="grace-bg fixed inset-0 -z-10 overflow-hidden pointer-events-none"
      aria-hidden="true"
    >
      {/* Soft cream wash so blobs read clearly on light surfaces */}
      <div className="grace-bg-wash" />

      {/* Five drifting gradient orbs */}
      <div className="grace-blob grace-blob-coral" />
      <div className="grace-blob grace-blob-mint" />
      <div className="grace-blob grace-blob-lavender" />
      <div className="grace-blob grace-blob-gold" />
      <div className="grace-blob grace-blob-sky" />

      {/* Subtle SVG grain for texture */}
      <svg className="grace-bg-grain" aria-hidden="true">
        <filter id="grace-noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.6 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grace-noise)" />
      </svg>
    </div>
  );
};

export default AnimatedBackground;
