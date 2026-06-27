import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";
import { useEffect, useState } from "react";

const StickyMobileCTA = () => {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      // Show after scrolling past the hero CTA (~500px)
      setVisible(window.scrollY > 500);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 lg:hidden bg-background/90 backdrop-blur-md border-t border-border px-4 py-3 safe-bottom">
      <button
        onClick={() => startWithGrace(() => navigate("/onboarding"))}
        className="grace-btn-accent text-base w-full py-3.5"
      >
        Start with Grace — free for 3 days
        <ChevronRight className="ml-0.5 h-4 w-4" />
      </button>
    </div>
  );
};

export default StickyMobileCTA;
