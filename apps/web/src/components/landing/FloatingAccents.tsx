import { motion, useReducedMotion } from "framer-motion";

/**
 * Subtle decorative pills + sparkles that float gently around the hero.
 * Pointer-events disabled so they never interfere with clicks.
 */
const FloatingAccents = () => {
  const reduce = useReducedMotion();
  if (reduce) return null;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* Top right — small mint pill */}
      <motion.div
        className="absolute top-[8%] right-[6%] w-14 h-7 rounded-full bg-gradient-to-br from-[#a8e6cf] to-[#7ed4b2] opacity-60 blur-[0.5px] shadow-lg shadow-emerald-300/30"
        animate={{ y: [0, -14, 0], rotate: [0, 8, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Mid left — soft coral pill */}
      <motion.div
        className="absolute top-[42%] left-[3%] w-10 h-5 rounded-full bg-gradient-to-br from-[#ffd4c4] to-[#f5a896] opacity-55 blur-[0.5px] shadow-lg shadow-rose-300/30"
        animate={{ y: [0, 16, 0], x: [0, 6, 0], rotate: [0, -10, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut", delay: 1.2 }}
      />

      {/* Bottom left — small lavender pill */}
      <motion.div
        className="absolute bottom-[12%] left-[10%] w-12 h-6 rounded-full bg-gradient-to-br from-[#d4c4f0] to-[#a896e8] opacity-50 blur-[0.5px] shadow-lg shadow-violet-300/30"
        animate={{ y: [0, -10, 0], rotate: [0, 6, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
      />

      {/* Sparkle dots */}
      <motion.div
        className="absolute top-[20%] left-[40%] w-2 h-2 rounded-full bg-accent/70"
        animate={{ opacity: [0.2, 1, 0.2], scale: [0.6, 1.2, 0.6] }}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-[68%] right-[12%] w-1.5 h-1.5 rounded-full bg-primary/70"
        animate={{ opacity: [0.2, 1, 0.2], scale: [0.6, 1.4, 0.6] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: 0.8 }}
      />
      <motion.div
        className="absolute top-[32%] right-[35%] w-1 h-1 rounded-full bg-accent/80"
        animate={{ opacity: [0.3, 1, 0.3], scale: [0.5, 1, 0.5] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
      />
    </div>
  );
};

export default FloatingAccents;
