import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
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
  Shield,
  Activity,
  Menu,
  X,
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
  { to: '/admin/content-rules', label: 'Content Rules', icon: Shield, end: false },
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

function SidebarContent({
  handleLogout,
  onNavClick,
}: {
  handleLogout: () => void;
  onNavClick?: () => void;
}) {
  return (
    <>
      {/* Logo */}
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

      {/* Nav */}
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
              onClick={onNavClick}
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

      {/* Sign out */}
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
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!isAuthed) {
    navigate('/admin/login');
    return null;
  }

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  return (
    <div className="admin-shell flex h-screen bg-background overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex w-56 flex-shrink-0 flex-col border-r"
        style={SIDEBAR_STYLE}
      >
        <SidebarContent handleLogout={handleLogout} />
      </aside>

      {/* Mobile: overlay + slide-in drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/60 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              key="drawer"
              initial={{ x: -224 }}
              animate={{ x: 0 }}
              exit={{ x: -224 }}
              transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              className="fixed inset-y-0 left-0 z-50 w-56 flex flex-col border-r md:hidden"
              style={SIDEBAR_STYLE}
            >
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-4 right-3 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </button>
              <SidebarContent handleLogout={handleLogout} onNavClick={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div
          className="md:hidden flex items-center gap-3 px-4 h-14 border-b flex-shrink-0"
          style={{
            background: 'rgba(15,23,42,0.97)',
            borderColor: 'rgba(255,255,255,0.06)',
          }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-primary/90 flex items-center justify-center shadow-md shadow-primary/30">
              <Zap className="h-3 w-3 text-white" strokeWidth={2.5} />
            </div>
            <span className="font-semibold text-sm text-foreground" style={{ letterSpacing: '-0.02em' }}>
              grace admin
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
