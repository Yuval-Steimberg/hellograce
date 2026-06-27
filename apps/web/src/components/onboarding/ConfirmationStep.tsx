import { motion } from "framer-motion";
import { Check, MessageCircle, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  buildGraceChatHref,
  buildGraceImessageHref,
  imessageDisplayNumber,
  isSandboxMode,
  WHATSAPP_JOIN_CODE,
} from "@/lib/chatLinks";

interface ConfirmationStepProps {
  firstName: string;
  phone: string;
}

const ConfirmationStep = ({ firstName, phone }: ConfirmationStepProps) => {
  const navigate = useNavigate();

  // Format phone for display (mask middle digits)
  const displayPhone = phone.length > 4
    ? phone.slice(0, phone.length - 4).replace(/./g, "•") + phone.slice(-4)
    : phone;

  const sandboxMode = isSandboxMode;
  // iMessage-first: primary CTA opens Messages to the grace line with a warm
  // opener prefilled. WhatsApp stays as a fallback link for non-Apple users.
  const imessageHref = buildGraceImessageHref();
  const whatsappHref = buildGraceChatHref();

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

        {/* iMessage CTA — primary action (iMessage-first) */}
        {imessageHref && (
          <motion.a
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55 }}
            href={imessageHref}
            className="grace-btn w-full flex items-center justify-center gap-2 text-base py-3 mb-2"
          >
            <MessageCircle className="h-5 w-5" />
            Message grace on iMessage
          </motion.a>
        )}

        {/* WhatsApp CTA — primary when no iMessage line, else a small fallback link */}
        {whatsappHref && (
          imessageHref ? (
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 mb-4"
            >
              Prefer WhatsApp? Open it here
            </a>
          ) : (
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
          )
        )}

        {/* What to expect card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="w-full rounded-2xl bg-secondary p-6 text-center mt-2"
        >
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <MessageCircle className="h-4 w-4 text-primary" />
            </div>
            <span className="text-sm font-medium text-foreground">
              {imessageHref || whatsappHref ? "One quick step" : "Check your messages"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {imessageHref
              ? `Tap the button above to open Messages with a quick hello ready to send — or just text grace at ${imessageDisplayNumber}. Tap send and she takes it from there.`
              : sandboxMode
                ? `Tap the button above to open WhatsApp — it'll pre-fill "join ${WHATSAPP_JOIN_CODE}". Send it and grace will reply.`
                : whatsappHref
                  ? "Tap the button above — it'll open WhatsApp with a quick hello ready to send. Tap send and grace takes it from there."
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
