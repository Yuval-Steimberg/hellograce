import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import LegalFooter from "./LegalFooter";

interface LegalPageLayoutProps {
  children: ReactNode;
  banner?: ReactNode;
}

const LegalPageLayout = ({ children, banner }: LegalPageLayoutProps) => (
  <div className="min-h-screen bg-background text-foreground font-sans">
    <div className="max-w-3xl mx-auto px-5 sm:px-8 py-10 sm:py-16">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to grace
      </Link>
      {banner}
      <article className="prose prose-lg max-w-none text-foreground [&_h1]:font-serif [&_h1]:text-3xl [&_h1]:sm:text-4xl [&_h1]:tracking-tight [&_h1]:mb-2 [&_h2]:font-serif [&_h2]:text-xl [&_h2]:sm:text-2xl [&_h2]:mt-10 [&_h2]:mb-4 [&_p]:text-base [&_p]:sm:text-[17px] [&_p]:leading-relaxed [&_p]:text-foreground [&_ul]:text-base [&_ul]:sm:text-[17px] [&_ul]:leading-relaxed [&_li]:text-foreground [&_strong]:text-foreground [&_a]:text-accent [&_a]:underline">
        {children}
      </article>
    </div>
    <LegalFooter />
  </div>
);

export default LegalPageLayout;
