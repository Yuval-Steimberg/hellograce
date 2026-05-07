import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import heroImage from "@/assets/editorial-hero.jpg";

const HeroSection = () => {
  const navigate = useNavigate();

  return (
    <section className="px-5 sm:px-8 md:px-10 max-w-[1440px] mx-auto min-h-[calc(100dvh-58px)] lg:min-h-[calc(100dvh-88px)] flex items-center">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-20 items-center w-full py-10 lg:py-0">
        {/* Image — desktop only */}
        <div className="lg:col-span-5 lg:col-start-1 relative order-2 lg:order-1 hidden lg:block">
          <div className="bg-secondary rounded-[2rem] overflow-hidden">
            <img
              src={heroImage}
              alt="A woman peacefully enjoying her morning with a warm mug"
              className="w-full aspect-[3/4] object-cover"
              fetchPriority="high"
              width={1200}
              height={1600}
            />
          </div>
        </div>

        {/* Copy */}
        <div className="lg:col-span-6 lg:col-start-7 order-1 lg:order-2 text-left">
          <span className="inline-block text-sm sm:text-base md:text-lg uppercase tracking-[0.2em] text-accent font-semibold mb-5 md:mb-6">
            Your daily GLP-1 companion
          </span>
          <h1 className="font-serif text-5xl sm:text-6xl md:text-7xl lg:text-7xl leading-[1.08] tracking-tight text-balance mb-6 md:mb-7 text-foreground">
            Feel supported{" "}
            <br className="hidden md:block" />
            <span className="italic text-accent">every single day.</span>
          </h1>
          <p className="text-lg sm:text-xl md:text-xl text-muted-foreground leading-relaxed max-w-[44ch] lg:mx-0 mb-10 md:mb-12">
            Personalized daily texts — hydration, meals, injection reminders — tailored to your medication. No app needed.
          </p>

          <div className="w-fit">
            <button
              onClick={() => navigate("/onboarding")}
              className="grace-btn text-lg md:text-lg px-12 py-5 md:py-5 w-full"
            >
              Start for free
              <ChevronRight className="ml-1 h-5 w-5" />
            </button>
            <div className="mt-5 flex items-center gap-2 bg-secondary/80 rounded-full px-5 py-2.5 w-full justify-center">
              <span className="text-accent text-base tracking-wide">★★★★★</span>
              <span className="text-sm sm:text-base text-foreground/70 font-medium whitespace-nowrap">Trusted by 12,000+ on GLP-1</span>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
};

export default HeroSection;
