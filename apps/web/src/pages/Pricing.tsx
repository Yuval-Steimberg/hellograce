import { lazy, Suspense } from "react";
import MarketingLayout from "@/components/landing/MarketingLayout";
import SEOHead from "@/components/SEOHead";
import PricingSection from "@/components/landing/PricingSection";

const TrustSafety = lazy(() => import("@/components/landing/TrustSafety"));

const Pricing = () => (
  <MarketingLayout>
    <SEOHead canonical="/pricing" />
    <div className="lg:pt-28">
      <PricingSection />
      <Suspense fallback={null}>
        <TrustSafety />
      </Suspense>
    </div>
  </MarketingLayout>
);

export default Pricing;
