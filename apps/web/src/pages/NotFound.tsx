import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import SEOHead from "@/components/SEOHead";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <>
      <SEOHead
        title="Page Not Found"
        description="The page you're looking for doesn't exist. Return to grace — your daily GLP-1 text companion."
        noindex
      />
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <div className="w-full max-w-md bg-card rounded-[2.5rem] shadow-[0_24px_64px_-12px_rgba(59,31,30,0.1)] ring-1 ring-border/40 p-10 text-center">
          <h1 className="mb-4 text-5xl font-serif text-foreground">404</h1>
          <p className="mb-6 text-lg text-muted-foreground">Oops! Page not found</p>
          <a href="/" className="text-accent underline underline-offset-4 hover:text-accent/80 font-medium">
            Return to Home
          </a>
        </div>
      </div>
    </>
  );
};

export default NotFound;