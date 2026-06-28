import { lazy, Suspense } from "react";
import MarketingLayout from "@/components/landing/MarketingLayout";
import SEOHead from "@/components/SEOHead";
import FeatureGrid from "@/components/landing/FeatureGrid";

const FeatureSpread = lazy(() => import("@/components/landing/FeatureSpread"));
const TestimonialsSection = lazy(() => import("@/components/landing/TestimonialsSection"));

const Features = () => (
  <MarketingLayout>
    <SEOHead canonical="/features" />
    <div className="pt-20 lg:pt-28">
      <FeatureGrid />
      <Suspense fallback={null}>
        <FeatureSpread />
        <TestimonialsSection />
      </Suspense>
    </div>
  </MarketingLayout>
);

export default Features;
