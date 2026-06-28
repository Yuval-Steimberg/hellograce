import { useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X, LogIn } from "lucide-react";
import Logo from "@/components/Logo";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Full-screen mobile menu — keeps the landing page itself minimal (Tomo-style)
 * while tucking ALL navigation here: primary actions as glassy bubbles, the
 * section links, and the legal/footer links. Dreamy warm backdrop, smooth
 * open/close. Body scroll is locked while open.
 */

const NAV_LINKS = [
  { label: "Features", to: "/features" },
  { label: "How it works", to: "/how-it-works" },
  { label: "Pricing", to: "/pricing" },
  { label: "FAQ", to: "/faq" },
];

const LEGAL = [
  { label: "Privacy", to: "/privacy" },
  { label: "Terms", to: "/terms" },
  { label: "Medical Disclaimer", to: "/disclaimer" },
];

const IMessageGlyph = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="white" aria-hidden>
    <path d="M12 3C6.9 3 3 6.4 3 10.6c0 2.4 1.3 4.5 3.3 5.9-.1.9-.6 2.2-1.5 3.1-.2.2 0 .5.3.5 1.9-.3 3.4-1 4.4-1.7.7.1 1.4.2 2.2.2 5.1 0 9-3.4 9-7.6S17.1 3 12 3z" />
  </svg>
);

const MobileMenu = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();

  // Lock body scroll while the menu is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const start = () => {
    onClose();
    startWithGrace(() => navigate("/onboarding"));
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="mobile-menu"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          {/* Dreamy warm backdrop */}
          <div
            className="absolute inset-0"
            style={{
              background: [
                "radial-gradient(ellipse 900px 500px at 50% -8%, hsl(28 82% 78% / 0.7) 0%, transparent 60%)",
                "radial-gradient(ellipse 800px 600px at 100% 12%, hsl(346 72% 82% / 0.45) 0%, transparent 60%)",
                "radial-gradient(ellipse 1000px 700px at 30% 112%, hsl(158 48% 64% / 0.5) 0%, transparent 62%)",
                "linear-gradient(180deg, hsl(44 38% 96%), hsl(40 30% 93%))",
              ].join(", "),
            }}
          />

          <motion.div
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="relative flex h-full flex-col px-6 pt-5 pb-8 safe-bottom"
          >
            {/* Top bar */}
            <div className="flex items-center justify-between">
              <Logo size="default" />
              <button
                onClick={onClose}
                aria-label="Close menu"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/8 text-foreground transition-colors hover:bg-foreground/12"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Primary actions — glassy bubbles */}
            <div className="mt-10 space-y-4">
              <button
                onClick={() => {
                  onClose();
                  navigate("/settings");
                }}
                className="flex w-full items-center gap-4 text-left"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-white/60 bg-white/45 text-foreground shadow-sm backdrop-blur-md">
                  <LogIn className="h-6 w-6" />
                </span>
                <span className="text-2xl font-bold text-foreground">Log in</span>
              </button>

              <button onClick={start} className="flex w-full items-center gap-4 text-left">
                <span
                  className="flex h-14 w-14 items-center justify-center rounded-full shadow-sm"
                  style={{ background: "linear-gradient(180deg, #5BF675, #1FD256)" }}
                >
                  <IMessageGlyph />
                </span>
                <span className="text-2xl font-bold text-foreground">Text Grace</span>
              </button>
            </div>

            {/* Page links */}
            <nav className="mt-10 flex flex-col gap-5" aria-label="Pages">
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={onClose}
                  className="text-lg font-semibold text-foreground/80 transition-colors hover:text-foreground"
                >
                  {l.label}
                </Link>
              ))}
            </nav>

            {/* Footer links pinned to bottom */}
            <div className="mt-auto flex flex-col gap-3 pt-10">
              {LEGAL.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={onClose}
                  className="text-base font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default MobileMenu;
