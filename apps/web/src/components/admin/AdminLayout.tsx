import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAdminAuth } from './AdminAuth';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  MessageSquare,
  ThumbsUp,
  FileText,
  Wrench,
  LogOut,
} from 'lucide-react';

const NAV = [
  { to: '/admin', label: 'Metrics', icon: BarChart3, end: true },
  { to: '/admin/conversations', label: 'Conversations', icon: MessageSquare, end: false },
  { to: '/admin/feedback', label: 'RLHF Feedback', icon: ThumbsUp, end: false },
  { to: '/admin/prompts', label: 'Prompt Manager', icon: FileText, end: false },
  { to: '/admin/tools', label: 'Tool Settings', icon: Wrench, end: false },
];

export default function AdminLayout() {
  const { isAuthed, logout } = useAdminAuth();
  const navigate = useNavigate();

  if (!isAuthed) {
    navigate('/admin/login');
    return null;
  }

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-card border-r border-border flex flex-col">
        <div className="px-4 py-5 border-b border-border">
          <span className="font-serif text-xl text-foreground">Grace</span>
          <span className="ml-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">Admin</span>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-2 pb-4">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
