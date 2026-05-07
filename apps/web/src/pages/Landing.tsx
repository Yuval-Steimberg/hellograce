import { useNavigate } from "react-router-dom";
import { useState, useEffect, lazy, Suspense } from "react";
import { ChevronRight } from "lucide-react";
import HeroSection from "@/components/landing/HeroSection";
import QuoteSection from "@/components/landing/QuoteSection";
import PhilosophySection from "@/components/landing/PhilosophySection";
import FeatureSpread from "@/components/landing/FeatureSpread";

// Lazy load below-fold sections
const TestimonialsSection = lazy(() => import("@/components/landing/TestimonialsSection"));
const FAQSection = lazy(() => import("@/components/landing/FAQSection"));
const FooterCTA = lazy(() => import("@/components/landing/FooterCTA"));

import StickyMobileCTA from "@/components/landing/StickyMobileCTA";

const Landing = () => {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 10);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Sticky Nav — desktop only */}
      <header
        className={`hidden lg:block fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? "bg-background/95 backdrop-blur-md shadow-sm py-4"
            : "bg-transparent py-8"
        }`}
        role="banner"
      >
        <div className="px-10 flex items-center justify-between max-w-[1440px] mx-auto">
          <span className="font-serif text-2xl text-foreground tracking-tight">grace</span>
          <div className="flex items-center gap-6">
            <button
              onClick={() => navigate("/settings")}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Log in
            </button>
            <button
              onClick={() => navigate("/onboarding")}
              aria-label="Start your free week of grace"
              className="grace-btn text-sm px-6 py-2.5"
            >
              Start Now
              <ChevronRight className="ml-1 h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile header — static */}
      <div className="lg:hidden px-5 sm:px-8 py-5 flex items-center justify-between" role="banner">
        <span className="font-serif text-2xl text-foreground tracking-tight">grace</span>
        <button
          onClick={() => navigate("/settings")}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Log in
        </button>
      </div>

      {/* Spacer for fixed nav — desktop only */}
      <div className="hidden lg:block h-[88px]" aria-hidden="true" />

      <main>
        <HeroSection />
        <QuoteSection />
        <PhilosophySection />
        <FeatureSpread />
        <Suspense fallback={null}>
          <TestimonialsSection />
          <FAQSection />
          <FooterCTA />
        </Suspense>
      </main>
      <StickyMobileCTA />
      <div className="h-16 lg:hidden" aria-hidden="true" />
    </div>
  );
};

export default Landing;
