import { useNavigate, Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import Logo from "@/components/Logo";

const FooterCTA = () => {
  const navigate = useNavigate();

  return (
    <>
      {/* Final CTA */}
      <section className="px-4 sm:px-6 md:px-10 pt-8 pb-20 md:pb-28">
        <div className="relative max-w-[1320px] mx-auto overflow-hidden rounded-[2rem] md:rounded-[2.5rem] bg-ink text-primary-foreground px-6 md:px-10 py-16 md:py-24 text-center">
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden
            style={{
              background:
                "radial-gradient(ellipse 700px 480px at 50% -10%, hsl(153 71% 55% / 0.22) 0%, transparent 60%), radial-gradient(ellipse 600px 500px at 100% 100%, hsl(188 60% 50% / 0.18) 0%, transparent 60%)",
            }}
          />
          <div className="relative flex flex-col items-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-mint mb-6">
              Ready when you are
            </span>
            <h2 className="text-3xl md:text-6xl font-extrabold tracking-tight mb-5 max-w-[18ch] mx-auto leading-[1.05]">
              Your first check-in is{" "}
              <span className="font-serif italic font-medium text-mint">waiting.</span>
            </h2>
            <p className="text-white/70 mb-9 max-w-[46ch] mx-auto text-base md:text-lg leading-relaxed">
              Set up in two minutes. Try it free for 3 days. If it's not for you,
              just text STOP — no card, no catch.
            </p>
            <button
              onClick={() => navigate("/onboarding")}
              className="grace-btn-accent text-base md:text-lg px-10 py-5 w-full sm:w-auto"
            >
              Start with Grace
              <ChevronRight className="ml-0.5 h-5 w-5" />
            </button>
            <p className="mt-4 text-sm text-white/55">
              A supportive companion — not a replacement for medical care.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10 md:py-12 px-6 text-center">
        <div className="max-w-6xl mx-auto flex flex-col items-center gap-4 text-muted-foreground">
          <Logo size="small" />
          <p className="text-xs md:text-sm">© {new Date().getFullYear()} STEIMBROS, LLC. All rights reserved.</p>
          <div className="flex flex-wrap items-center justify-center gap-4 text-[13px] md:text-sm">
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
            <Link to="/disclaimer" className="hover:text-foreground transition-colors">Medical Disclaimer</Link>
          </div>
          <p className="text-[11px] md:text-xs text-muted-foreground/70 max-w-xl leading-relaxed">
            Grace provides general wellness support and is not a medical device or a
            substitute for professional medical advice, diagnosis, or treatment.
            Always consult your healthcare provider about your medication.
          </p>
        </div>
      </footer>
    </>
  );
};

export default FooterCTA;
