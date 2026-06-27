import { useNavigate } from "react-router-dom";
import { useState, useEffect, lazy, Suspense } from "react";
import { ChevronRight } from "lucide-react";
import Logo from "@/components/Logo";
import HeroSection from "@/components/landing/HeroSection";
import MedicationsBar from "@/components/landing/MedicationsBar";
import ProblemSection from "@/components/landing/ProblemSection";
import SolutionSection from "@/components/landing/SolutionSection";
import FeatureGrid from "@/components/landing/FeatureGrid";
import AnimatedBackground from "@/components/landing/AnimatedBackground";
import ScrollProgress from "@/components/landing/ScrollProgress";

// Lazy load below-fold sections
const FeatureSpread = lazy(() => import("@/components/landing/FeatureSpread"));
const HowItWorks = lazy(() => import("@/components/landing/HowItWorks"));
const ConversationShowcase = lazy(() => import("@/components/landing/ConversationShowcase"));
const TestimonialsSection = lazy(() => import("@/components/landing/TestimonialsSection"));
const TrustSafety = lazy(() => import("@/components/landing/TrustSafety"));
const PricingSection = lazy(() => import("@/components/landing/PricingSection"));
const FAQSection = lazy(() => import("@/components/landing/FAQSection"));
const FooterCTA = lazy(() => import("@/components/landing/FooterCTA"));

import StickyMobileCTA from "@/components/landing/StickyMobileCTA";

const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

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
    <div className="relative isolate min-h-screen text-foreground font-sans" style={{ overflowX: "clip" }}>
      <ScrollProgress />
      <AnimatedBackground />

      {/* Sticky Nav — desktop only */}
      <header
        className={`hidden lg:block fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? "bg-background/85 backdrop-blur-md shadow-[0_1px_0_hsl(var(--border))] py-3.5"
            : "bg-transparent py-6"
        }`}
        role="banner"
      >
        <div className="px-10 flex items-center justify-between max-w-[1320px] mx-auto">
          <Logo size="default" />
          <nav className="flex items-center gap-8" aria-label="Primary">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-5">
            <button
              onClick={() => navigate("/settings")}
              className="text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              Log in
            </button>
            <button
              onClick={() => navigate("/onboarding")}
              aria-label="Start with Grace"
              className="grace-btn-accent text-sm px-6 py-2.5"
              style={{ minHeight: "auto" }}
            >
              Start free
              <ChevronRight className="ml-0.5 h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile header — static */}
      <div className="lg:hidden px-5 sm:px-8 py-4 flex items-center justify-between" role="banner">
        <Logo size="default" />
        <button
          onClick={() => navigate("/onboarding")}
          className="grace-btn-accent text-sm px-5 py-2.5"
          style={{ minHeight: "auto" }}
        >
          Start free
        </button>
      </div>

      {/* Spacer for fixed nav — desktop only */}
      <div className="hidden lg:block h-[80px]" aria-hidden="true" />

      <main>
        <HeroSection />
        <MedicationsBar />
        <ProblemSection />
        <SolutionSection />
        <FeatureGrid />
        <Suspense fallback={null}>
          <FeatureSpread />
          <HowItWorks />
          <ConversationShowcase />
          <TestimonialsSection />
          <TrustSafety />
          <PricingSection />
          <FAQSection />
          <FooterCTA />
        </Suspense>
      </main>
      <StickyMobileCTA />
      <div className="h-20 lg:hidden" aria-hidden="true" />
    </div>
  );
};

export default Landing;
