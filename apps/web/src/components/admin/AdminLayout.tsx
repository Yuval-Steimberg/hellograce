import { useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAdminAuth } from './AdminAuth';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart3,
  MessageSquare,
  ThumbsUp,
  FileText,
  Wrench,
  Users,
  LogOut,
  Zap,
  TrendingUp,
  Calendar,
  Cpu,
  FlaskConical,
  CheckSquare,
  GitCompare,
  Shield,
  CreditCard,
  Activity,
  Menu,
  X,
  ChevronRight,
} from 'lucide-react';

const NAV = [
  { to: '/admin', label: 'Metrics', icon: BarChart3, end: true },
  { to: '/admin/conversations', label: 'Conversations', icon: MessageSquare, end: false },
  { to: '/admin/users', label: 'Users', icon: Users, end: false },
  { to: '/admin/feedback', label: 'RLHF Feedback', icon: ThumbsUp, end: false },
  { to: '/admin/prompts', label: 'Prompt Manager', icon: FileText, end: false },
  { to: '/admin/tools', label: 'Tool Settings', icon: Wrench, end: false },
  { to: '/admin/business', label: 'Business', icon: TrendingUp, end: false },
  { to: '/admin/scheduler', label: 'Scheduler', icon: Calendar, end: false },
  { to: '/admin/ai-quality', label: 'AI Quality', icon: Cpu, end: false },
  { to: '/admin/auto-eval', label: 'Auto-Eval', icon: FlaskConical, end: false },
  { to: '/admin/regression', label: 'Regression Tests', icon: CheckSquare, end: false },
  { to: '/admin/replay', label: 'Replay & Diff', icon: GitCompare, end: false },
  { to: '/admin/content-rules', label: 'Content Rules', icon: Shield, end: false },
  { to: '/admin/subscription-messages', label: 'Subscription Messages', icon: CreditCard, end: false },
  { to: '/admin/system-health', label: 'System Health', icon: Activity, end: false },
];

const stagger = {
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, x: -12 },
  show: { opacity: 1, x: 0, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] } },
};

const SIDEBAR_STYLE = {
  background: 'linear-gradient(180deg, rgba(15,23,42,0.95) 0%, rgba(15,23,42,0.9) 100%)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderColor: 'rgba(255,255,255,0.06)',
};

function DesktopSidebarContent({ handleLogout }: { handleLogout: () => void }) {
  return (
    <>
      <div
        className="px-5 py-5 flex items-center gap-2.5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="w-7 h-7 rounded-lg bg-primary/90 flex items-center justify-center shadow-lg shadow-primary/30">
          <Zap className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
        </div>
        <div className="leading-none">
          <span className="font-semibold text-sm tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>
            grace
          </span>
          <span className="block text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
            Admin
          </span>
        </div>
      </div>

      <motion.nav
        className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <motion.div key={to} variants={item}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-200 group min-h-[44px]',
                  isActive
                    ? 'bg-primary/15 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn(
                      'h-4 w-4 flex-shrink-0 transition-colors duration-200',
                      isActive ? 'text-primary' : 'group-hover:text-foreground',
                    )}
                  />
                  {label}
                  {isActive && (
                    <motion.div
                      layoutId="nav-indicator"
                      className="ml-auto w-1 h-4 rounded-full bg-primary"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                </>
              )}
            </NavLink>
          </motion.div>
        ))}
      </motion.nav>

      <div
        className="px-2 pb-4 pt-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all duration-200 min-h-[44px]"
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          Sign out
        </button>
      </div>
    </>
  );
}

export default function AdminLayout() {
  const { isAuthed, logout } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!isAuthed) {
    navigate('/admin/login');
    return null;
  }

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const currentPage = NAV.find((n) =>
    n.end ? location.pathname === n.to : location.pathname.startsWith(n.to),
  );

  return (
    <div className="admin-shell flex h-screen bg-background overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex w-56 flex-shrink-0 flex-col border-r"
        style={SIDEBAR_STYLE}
      >
        <DesktopSidebarContent handleLogout={handleLogout} />
      </aside>

      {/* Mobile: full-screen overlay nav — portal at document.body root */}
      {mobileOpen && createPortal(
        <div
          className="admin-shell fixed inset-0 flex flex-col"
          style={{
            zIndex: 9999,
            background: 'linear-gradient(160deg, hsl(217 33% 8%) 0%, hsl(217 33% 6%) 100%)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg"
                style={{ background: '#6366f1', boxShadow: '0 4px 12px rgba(99,102,241,0.35)' }}
              >
                <Zap className="h-4 w-4 text-white" strokeWidth={2.5} />
              </div>
              <div className="leading-tight">
                <div className="font-semibold text-base" style={{ color: '#e2e8f0', letterSpacing: '-0.02em' }}>
                  grace
                </div>
                <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Admin
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              style={{
                width: 44, height: 44,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.08)',
                border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#94a3b8',
                cursor: 'pointer',
                WebkitAppearance: 'none',
              }}
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          </div>

          {/* Nav items */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setMobileOpen(false)}
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 16,
                  padding: '14px 16px',
                  borderRadius: 12,
                  fontSize: 15, fontWeight: 500,
                  textDecoration: 'none',
                  marginBottom: 2,
                  background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
                  color: isActive ? '#818cf8' : '#94a3b8',
                })}
              >
                {({ isActive }) => (
                  <>
                    <Icon size={20} style={{ flexShrink: 0, color: isActive ? '#818cf8' : '#64748b' }} />
                    <span style={{ flex: 1 }}>{label}</span>
                    {isActive && <ChevronRight size={16} style={{ color: '#818cf8', opacity: 0.6 }} />}
                  </>
                )}
              </NavLink>
            ))}
          </div>

          {/* Sign out */}
          <div
            style={{ padding: '12px 12px 40px', borderTop: '1px solid rgba(255,255,255,0.08)' }}
          >
            <button
              type="button"
              onClick={handleLogout}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 16,
                padding: '14px 16px', borderRadius: 12,
                fontSize: 15, fontWeight: 500,
                color: '#64748b', background: 'none', border: 'none',
                cursor: 'pointer', WebkitAppearance: 'none',
                minHeight: 52,
              }}
            >
              <LogOut size={20} style={{ flexShrink: 0 }} />
              Sign out
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div
          className="md:hidden flex items-center gap-3 px-4 h-14 flex-shrink-0"
          style={{
            background: 'rgba(10,17,32,0.98)',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground"
            style={{ background: 'rgba(255,255,255,0.07)' }}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-primary/90 flex items-center justify-center flex-shrink-0">
              <Zap className="h-3 w-3 text-white" strokeWidth={2.5} />
            </div>
            <span
              className="font-semibold text-sm text-foreground truncate"
              style={{ letterSpacing: '-0.02em' }}
            >
              {currentPage?.label ?? 'Admin'}
            </span>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
