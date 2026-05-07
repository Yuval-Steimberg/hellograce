import { Link } from "react-router-dom";

const LegalFooter = () => (
  <footer className="w-full py-6 px-5 sm:px-8">
    <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-[14px] text-muted-foreground">
      <span>© 2026 STEIMBROS, LLC. All rights reserved.</span>
      <span className="hidden sm:inline">|</span>
      <div className="flex items-center gap-4">
        <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
        <Link to="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
        <Link to="/disclaimer" className="hover:text-foreground transition-colors">Medical Disclaimer</Link>
      </div>
    </div>
  </footer>
);

export default LegalFooter;
