import { motion, AnimatePresence } from "framer-motion";
import { ReactNode } from "react";

interface QuizLayoutProps {
  children: ReactNode;
  currentStep: number;
  totalSteps: number;
  onBack?: () => void;
  showBack?: boolean;
}

const QuizLayout = ({ children, currentStep, totalSteps, onBack, showBack = true }: QuizLayoutProps) => {
  const progress = (currentStep / totalSteps) * 100;

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md min-h-[85dvh] bg-card rounded-[2.5rem] shadow-[0_24px_64px_-12px_rgba(59,31,30,0.1)] ring-1 ring-border/40 flex flex-col overflow-hidden relative">
        {/* Progress bar */}
        <div className="w-full h-1.5 bg-sand/50">
          <motion.div
            className="h-full bg-peach"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>

        {/* Back button + step label */}
        <div className="px-8 pt-6 pb-2 flex items-center justify-between">
          {showBack && onBack ? (
            <button
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground transition-colors text-xs font-semibold tracking-widest uppercase"
            >
              ← Back
            </button>
          ) : (
            <div />
          )}
          <span className="text-xs font-semibold tracking-widest text-muted-foreground/60 uppercase">
            {currentStep} / {totalSteps}
          </span>
        </div>

        {/* Content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="flex-1 flex flex-col px-8 pb-8"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

export default QuizLayout;