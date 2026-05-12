import { useNavigate } from "react-router-dom";
import { ChevronRight, ShieldCheck } from "lucide-react";
import ChatMockup from "./ChatMockup";

const HeroSection = () => {
  const navigate = useNavigate();

  return (
    <section className="px-5 sm:px-8 md:px-10 max-w-[1440px] mx-auto min-h-[calc(100dvh-58px)] lg:min-h-[calc(100dvh-88px)] flex items-center">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-20 items-center w-full py-10 lg:py-0">
        {/* Chat mockup — desktop left, mobile below copy */}
        <div className="lg:col-span-5 lg:col-start-1 order-2 lg:order-1">
          <ChatMockup />
        </div>

        {/* Copy */}
        <div className="lg:col-span-6 lg:col-start-7 order-1 lg:order-2 text-left">
          <span className="inline-block text-sm sm:text-base md:text-lg uppercase tracking-[0.2em] text-accent font-semibold mb-5 md:mb-6">
            For Wegovy · Ozempic · Mounjaro · Zepbound
          </span>
          <h1 className="font-serif text-5xl sm:text-6xl md:text-7xl lg:text-7xl leading-[1.08] tracking-tight text-balance mb-6 md:mb-7 text-foreground">
            The friend who knows{" "}
            <span className="italic text-accent">your medication.</span>
          </h1>
          <p className="text-lg sm:text-xl md:text-xl text-muted-foreground leading-relaxed max-w-[48ch] lg:mx-0 mb-10 md:mb-12">
            grace is a daily companion on WhatsApp — handling nausea, plateau weeks, protein targets, injection-day check-ins and the dozen small questions GLP-1 throws at you. No app. No login. Just text.
          </p>

          <div className="w-fit">
            <button
              onClick={() => navigate("/onboarding")}
              className="grace-btn text-lg md:text-lg px-12 py-5 md:py-5 w-full"
            >
              Start your free 3-day trial
              <ChevronRight className="ml-1 h-5 w-5" />
            </button>
            <div className="mt-5 flex items-center gap-2 bg-secondary/80 rounded-full px-5 py-2.5 w-full justify-center">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              <span className="text-sm sm:text-base text-foreground/70 font-medium whitespace-nowrap">
                No card required. Cancel any time by texting STOP.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
