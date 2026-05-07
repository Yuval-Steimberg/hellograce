import Landing from "./Landing";
import SEOHead from "@/components/SEOHead";
import {
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
  faqSchema,
  serviceSchema,
} from "@/lib/seo-schemas";

const Index = () => (
  <>
    <SEOHead
      canonical="/"
      jsonLd={[
        organizationSchema,
        websiteSchema,
        softwareApplicationSchema,
        faqSchema,
        serviceSchema,
      ]}
    />
    <Landing />
  </>
);

export default Index;
