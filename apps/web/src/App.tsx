import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import ScrollToTop from "./components/ScrollToTop";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminAuthProvider } from "@/components/admin/AdminAuth";
import Index from "./pages/Index.tsx";

// Lazy-loaded routes for smaller initial bundle
const Onboarding = lazy(() => import("./pages/Onboarding.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));
const Privacy = lazy(() => import("./pages/Privacy.tsx"));
const Terms = lazy(() => import("./pages/Terms.tsx"));
const Disclaimer = lazy(() => import("./pages/Disclaimer.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Admin dashboard (auth-gated)
const AdminLogin = lazy(() => import("./pages/admin/AdminLogin.tsx"));
const AdminLayout = lazy(() => import("./components/admin/AdminLayout.tsx"));
const MetricsPage = lazy(() => import("./pages/admin/MetricsPage.tsx"));
const ConversationsPage = lazy(() => import("./pages/admin/ConversationsPage.tsx"));
const FeedbackPage = lazy(() => import("./pages/admin/FeedbackPage.tsx"));
const PromptsPage = lazy(() => import("./pages/admin/PromptsPage.tsx"));
const ToolsPage = lazy(() => import("./pages/admin/ToolsPage.tsx"));
const UsersPage = lazy(() => import("./pages/admin/UsersPage.tsx"));
const BusinessPage = lazy(() => import("./pages/admin/BusinessPage.tsx"));
const SchedulerPage = lazy(() => import("./pages/admin/SchedulerPage.tsx"));
const AIQualityPage = lazy(() => import("./pages/admin/AIQualityPage.tsx"));
const ContentRulesPage = lazy(() => import("./pages/admin/ContentRulesPage.tsx"));
const SubscriptionMessagesPage = lazy(() => import("./pages/admin/SubscriptionMessagesPage.tsx"));
const SystemHealthPage = lazy(() => import("./pages/admin/SystemHealthPage.tsx"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AdminAuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <ScrollToTop />
          <Suspense fallback={<div className="min-h-screen bg-background" />}>
            <Routes>
              {/* Public marketing + end-user routes */}
              <Route path="/" element={<Index />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/disclaimer" element={<Disclaimer />} />

              {/* Admin dashboard */}
              <Route path="/admin/login" element={<AdminLogin />} />
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<MetricsPage />} />
                <Route path="conversations" element={<ConversationsPage />} />
                <Route path="feedback" element={<FeedbackPage />} />
                <Route path="prompts" element={<PromptsPage />} />
                <Route path="tools" element={<ToolsPage />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="business" element={<BusinessPage />} />
                <Route path="scheduler" element={<SchedulerPage />} />
                <Route path="ai-quality" element={<AIQualityPage />} />
                <Route path="content-rules" element={<ContentRulesPage />} />
                <Route path="subscription-messages" element={<SubscriptionMessagesPage />} />
                <Route path="system-health" element={<SystemHealthPage />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
    </AdminAuthProvider>
  </QueryClientProvider>
);

export default App;
