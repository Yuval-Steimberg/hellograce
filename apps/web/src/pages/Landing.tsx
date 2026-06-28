import MarketingLayout from "@/components/landing/MarketingLayout";
import MobileHero from "@/components/landing/MobileHero";
import DesktopDeck from "@/components/landing/DesktopDeck";

/**
 * Home — phone keeps the chat-led iMessage hero (unchanged); desktop renders the
 * full "Grace Landing" slide deck (Claude Design handoff), which owns its own
 * header/nav, so the shared desktop nav is hidden.
 */
const Landing = () => (
  <MarketingLayout hideFooter hideDesktopNav>
    <MobileHero />
    <DesktopDeck />
  </MarketingLayout>
);

export default Landing;
