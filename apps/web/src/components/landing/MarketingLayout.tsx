import { useNavigate, NavLink } from "react-router-dom";
import { useState, useEffect } from "react";
import { startWithGrace } from "@/lib/chatLinks";
import { ChevronRight, Menu } from "lucide-react";
import Logo from "@/components/Logo";
import MobileMenu from "@/components/landing/MobileMenu";
import AnimatedBackground from "@/components/landing/AnimatedBackground";
import SiteFooter from "@/components/landing/SiteFooter";

/** Top-level marketing pages — each is its OWN route (no in-page scrolling
 *  between sections). The nav navigates between them. */
export const NAV_LINKS = [
  { label: "Features", to: "/features" },
  { label: "How it works", to: "/how-it-works" },
  { label: "Pricing", to: "/pricing" },
  { label: "FAQ", to: "/faq" },
];

/**
 * Shared shell for every marketing page: dawn background, sticky desktop nav +
 * mobile header/menu, the page's content, and the footer. The nav links route
 * between discrete pages (React Router) rather than scrolling one long page.
 */
const MarketingLayout = ({
  children,
  hideFooter = false,
}: {
  children: React.ReactNode;
  /** Home uses this for a strict single-screen (no footer, no scroll). */
  hideFooter?: boolean;
}) => {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-semibold transition-colors ${
      isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div
      className={`relative isolate flex flex-col text-foreground font-sans ${
        hideFooter ? "h-[100svh] overflow-hidden" : "min-h-screen"
      }`}
      style={{ overflowX: "clip" }}
    >
      <AnimatedBackground />

      {/* Sticky Nav — desktop */}
      <header
        className={`hidden lg:block fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled ? "bg-background/85 backdrop-blur-md shadow-[0_1px_0_hsl(var(--border))] py-3.5" : "bg-transparent py-6"
        }`}
        role="banner"
      >
        <div className="px-10 flex items-center justify-between max-w-[1320px] mx-auto">
          <button onClick={() => navigate("/")} aria-label="Grace home">
            <Logo size="default" />
          </button>
          <nav className="flex items-center gap-8" aria-label="Primary">
            {NAV_LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={navLinkClass}>
                {l.label}
              </NavLink>
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
              onClick={() => startWithGrace(() => navigate("/onboarding"))}
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

      {/* Mobile header */}
      <div className="lg:hidden px-5 sm:px-8 py-4 flex items-center justify-between" role="banner">
        <button onClick={() => navigate("/")} aria-label="Grace home">
          <Logo size="default" />
        </button>
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/8 text-foreground transition-colors hover:bg-foreground/12"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />

      <main className="flex-1">{children}</main>

      {!hideFooter && <SiteFooter />}
    </div>
  );
};

export default MarketingLayout;
