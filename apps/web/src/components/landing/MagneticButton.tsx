import { useRef, type ButtonHTMLAttributes, type PropsWithChildren } from "react";
import { motion, useMotionValue, useSpring, useReducedMotion } from "framer-motion";

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & {
  /** How much the button moves toward the cursor in px. */
  strength?: number;
};

const MagneticButton = ({ children, strength = 14, className, ...rest }: Props) => {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLButtonElement>(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 220, damping: 18, mass: 0.4 });
  const springY = useSpring(y, { stiffness: 220, damping: 18, mass: 0.4 });

  const onMove = (e: React.MouseEvent) => {
    if (reduce || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = ((e.clientX - cx) / rect.width) * 2;  // -1..1
    const dy = ((e.clientY - cy) / rect.height) * 2;
    x.set(dx * strength);
    y.set(dy * strength);
  };

  const onLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.button
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ x: springX, y: springY }}
      className={className}
      {...(rest as never)}
    >
      {children}
    </motion.button>
  );
};

export default MagneticButton;
