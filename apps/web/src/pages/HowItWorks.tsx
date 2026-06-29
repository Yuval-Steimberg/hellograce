import { lazy, Suspense } from "react";
import MarketingLayout from "@/components/landing/MarketingLayout";
import SEOHead from "@/components/SEOHead";
import ProblemSection from "@/components/landing/ProblemSection";
import SolutionSection from "@/components/landing/SolutionSection";

const HowItWorksSection = lazy(() => import("@/components/landing/HowItWorks"));
const ConversationShowcase = lazy(() => import("@/components/landing/ConversationShowcase"));

const HowItWorks = () => (
  <MarketingLayout>
    <SEOHead canonical="/how-it-works" />
    <div className="lg:pt-28">
      <ProblemSection />
      <SolutionSection />
      <Suspense fallback={null}>
        <HowItWorksSection />
        <ConversationShowcase />
      </Suspense>
    </div>
  </MarketingLayout>
);

export default HowItWorks;
