import { useNavigate, Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

const FooterCTA = () => {
  const navigate = useNavigate();

  return (
    <>
      {/* Final CTA */}
      <section className="py-16 md:py-32 flex flex-col items-center text-center px-6 md:px-10">
        <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-semibold mb-4 md:mb-5">
          Ready?
        </span>
        <h2 className="font-serif text-3xl md:text-5xl text-foreground mb-5 md:mb-6 tracking-tight max-w-[20ch] mx-auto leading-tight">
          Your first morning text is waiting.
        </h2>
        <p className="text-muted-foreground mb-8 md:mb-10 max-w-[44ch] mx-auto text-base md:text-lg leading-relaxed">
          Set up in 2 minutes. Try it free for 3 days. If it doesn't feel right, just text STOP.
        </p>
        <button
          onClick={() => navigate("/onboarding")}
          className="grace-btn text-base md:text-lg px-10 md:px-12 py-4 md:py-5 w-full sm:w-auto"
        >
          Start for free
          <ChevronRight className="ml-1 h-5 w-5" />
        </button>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 md:py-12 px-6 text-center">
        <div className="max-w-6xl mx-auto flex flex-col items-center gap-4 text-muted-foreground">
          <span className="font-serif text-lg md:text-xl text-foreground">grace</span>
          <p className="text-xs md:text-sm">© {new Date().getFullYear()} STEIMBROS, LLC. All rights reserved.</p>
          <div className="flex items-center gap-4 text-[13px] md:text-sm">
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
            <Link to="/disclaimer" className="hover:text-foreground transition-colors">Medical Disclaimer</Link>
          </div>
        </div>
      </footer>
    </>
  );
};

export default FooterCTA;
