import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
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
    <div className="fixed bottom-0 left-0 right-0 z-50 lg:hidden bg-background/95 backdrop-blur-sm border-t border-border px-4 py-3 safe-bottom">
      <button
        onClick={() => navigate("/onboarding")}
        className="grace-btn text-base w-full py-3.5"
      >
        Start Your Free Week
        <ChevronRight className="ml-1 h-4 w-4" />
      </button>
    </div>
  );
};

export default StickyMobileCTA;
