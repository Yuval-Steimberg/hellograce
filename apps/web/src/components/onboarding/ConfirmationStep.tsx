import { motion } from "framer-motion";
import { Check, MessageCircle, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface ConfirmationStepProps {
  firstName: string;
  phone: string;
}

const WHATSAPP_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER as string | undefined) ?? "";
const WHATSAPP_JOIN_CODE = (import.meta.env.VITE_WHATSAPP_JOIN_CODE as string | undefined) ?? "";

const ConfirmationStep = ({ firstName, phone }: ConfirmationStepProps) => {
  const navigate = useNavigate();

  // Format phone for display (mask middle digits)
  const displayPhone = phone.length > 4
    ? phone.slice(0, phone.length - 4).replace(/./g, "•") + phone.slice(-4)
    : phone;

  const sandboxMode = WHATSAPP_JOIN_CODE.length > 0;
  const whatsappHref = WHATSAPP_NUMBER
    ? `https://wa.me/${WHATSAPP_NUMBER.replace(/\D/g, "")}${
        sandboxMode ? `?text=${encodeURIComponent(`join ${WHATSAPP_JOIN_CODE}`)}` : ""
      }`
    : "";

  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center pt-8">
        {/* Success badge */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 180, damping: 14 }}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 mb-6"
        >
          <Check className="h-8 w-8 text-success" strokeWidth={2.5} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="text-3xl font-serif text-foreground leading-tight mb-3 text-center"
        >
          You're all set{firstName ? `, ${firstName}` : ""}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45 }}
          className="text-muted-foreground text-center max-w-[280px] mb-2"
        >
          Your first message arrives soon. Check your texts.
        </motion.p>

        {/* Phone display with update link */}
        {phone && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="flex flex-col items-center mb-8"
          >
            <span className="text-foreground font-medium text-sm tracking-wide">
              {displayPhone}
            </span>
            <button
              onClick={() => navigate("/settings")}
              className="text-xs text-accent hover:text-accent/80 transition-colors mt-1 underline underline-offset-2"
            >
              Update phone number
            </button>
          </motion.div>
        )}

        {/* WhatsApp CTA — primary action */}
        {whatsappHref && (
          <motion.a
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55 }}
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="grace-btn w-full flex items-center justify-center gap-2 text-base py-3 mb-4"
          >
            <MessageCircle className="h-5 w-5" />
            Start chatting with grace on WhatsApp
          </motion.a>
        )}

        {/* What to expect card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="w-full rounded-2xl bg-secondary p-6 text-center"
        >
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <MessageCircle className="h-4 w-4 text-primary" />
            </div>
            <span className="text-sm font-medium text-foreground">
              {sandboxMode ? "One quick step" : "Check your WhatsApp"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {sandboxMode
              ? `Tap the button above to open WhatsApp — it'll pre-fill "join ${WHATSAPP_JOIN_CODE}". Send it and grace will reply.`
              : "Look for a welcome message from grace. That's where she'll check in with you — no app needed."}
          </p>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="mt-auto pt-6 flex flex-col items-center gap-3"
      >
        <button
          onClick={() => navigate("/settings")}
          className="flex items-center gap-2 text-sm text-accent hover:text-accent/80 transition-colors font-medium"
        >
          <Settings className="h-4 w-4" />
          Your settings
        </button>
        <p className="text-xs text-muted-foreground/60">
          Questions? Reply to any text we send.
        </p>
      </motion.div>
    </>
  );
};

export default ConfirmationStep;
