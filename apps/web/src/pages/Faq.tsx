import MarketingLayout from "@/components/landing/MarketingLayout";
import SEOHead from "@/components/SEOHead";
import { faqSchema } from "@/lib/seo-schemas";
import FAQSection from "@/components/landing/FAQSection";

const Faq = () => (
  <MarketingLayout>
    <SEOHead canonical="/faq" jsonLd={[faqSchema]} />
    <div className="pt-20 lg:pt-28">
      <FAQSection />
    </div>
  </MarketingLayout>
);

export default Faq;
