import MarketingLayout from "@/components/landing/MarketingLayout";
import HeroSection from "@/components/landing/HeroSection";

/**
 * Home — a single screen, no scroll: just the editorial hero. Everything else
 * lives on its own routed page (Features / How it works / Pricing / FAQ).
 */
const Landing = () => (
  <MarketingLayout hideFooter>
    <HeroSection />
  </MarketingLayout>
);

export default Landing;
