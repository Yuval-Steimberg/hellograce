import MarketingLayout from "@/components/landing/MarketingLayout";
import HeroSection from "@/components/landing/HeroSection";
import MedicationsBar from "@/components/landing/MedicationsBar";
import StickyMobileCTA from "@/components/landing/StickyMobileCTA";

/**
 * Home — intentionally minimal: the hero (dreamy desktop scene / mobile chat)
 * plus the medications trust strip. Everything else lives on its own routed
 * page (Features / How it works / Pricing / FAQ) — navigation moves between
 * pages, not by scrolling one long page.
 */
const Landing = () => (
  <MarketingLayout>
    <HeroSection />
    <MedicationsBar />
    <StickyMobileCTA />
    <div className="h-20 lg:hidden" aria-hidden="true" />
  </MarketingLayout>
);

export default Landing;
