import MarketingLayout from "@/components/landing/MarketingLayout";
import MobileHero from "@/components/landing/MobileHero";
import DesktopLanding from "@/components/landing/DesktopLanding";

/**
 * Home — phone keeps the chat-led iMessage hero (single screen, no scroll);
 * desktop renders the full vertical-scrolling "Grace Landing" page (Claude
 * Design handoff), which owns its own header/nav and footer.
 *
 * The two are split by viewport so the desktop page can scroll freely without
 * MarketingLayout's single-screen clamp clipping it, and the phone hero stays
 * locked to one screen.
 */
const Landing = () => (
  <>
    {/* Phones + tablets (below lg): Grace-branded single-column hero that caps
        its width so it reads well on both, with the shared footer below. */}
    <div className="lg:hidden">
      <MarketingLayout hideDesktopNav>
        <MobileHero />
      </MarketingLayout>
    </div>
    {/* Desktop (lg+): the full vertical-scrolling landing. */}
    <DesktopLanding />
  </>
);

export default Landing;
