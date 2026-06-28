import { Link } from "react-router-dom";
import Logo from "@/components/Logo";

/** Slim site footer (logo + legal links + disclaimer), shared across all
 *  marketing pages via MarketingLayout. */
const SiteFooter = () => (
  <footer className="border-t border-border py-10 md:py-12 px-6 text-center">
    <div className="max-w-6xl mx-auto flex flex-col items-center gap-4 text-muted-foreground">
      <Logo size="small" />
      <p className="text-xs md:text-sm">© {new Date().getFullYear()} STEIMBROS, LLC. All rights reserved.</p>
      <div className="flex flex-wrap items-center justify-center gap-4 text-[13px] md:text-sm">
        <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
        <Link to="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
        <Link to="/disclaimer" className="hover:text-foreground transition-colors">Medical Disclaimer</Link>
      </div>
      <p className="text-[11px] md:text-xs text-muted-foreground/70 max-w-xl leading-relaxed">
        Grace provides general wellness support and is not a medical device or a
        substitute for professional medical advice, diagnosis, or treatment.
        Always consult your healthcare provider about your medication.
      </p>
    </div>
  </footer>
);

export default SiteFooter;
