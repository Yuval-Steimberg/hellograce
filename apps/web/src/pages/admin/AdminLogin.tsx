import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '@/components/admin/AdminAuth';
import { motion } from 'framer-motion';
import { Zap, Lock } from 'lucide-react';

export default function AdminLogin() {
  const { login } = useAdminAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(token.trim());
      navigate('/admin');
    } catch {
      setError('Invalid admin token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="admin-shell min-h-screen bg-background flex items-center justify-center p-4"
      style={{
        backgroundImage:
          'radial-gradient(ellipse 800px 600px at 50% 0%, hsl(239 84% 67% / 0.08) 0%, transparent 60%)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-sm"
      >
        {/* Logo mark */}
        <div className="flex justify-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-primary/90 flex items-center justify-center shadow-2xl shadow-primary/30">
            <Zap className="h-6 w-6 text-white" strokeWidth={2.5} />
          </div>
        </div>

        <div
          className="rounded-2xl p-8 bg-card border"
          style={{
            borderColor: 'rgba(255,255,255,0.07)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.04), 0 20px 40px rgba(0,0,0,0.4)',
          }}
        >
          <h1
            className="text-xl font-semibold text-foreground mb-1"
            style={{ letterSpacing: '-0.02em' }}
          >
            Admin access
          </h1>
          <p className="text-sm text-muted-foreground mb-6">Enter your admin token to continue.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="password"
                placeholder="Admin token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
                className="w-full rounded-xl border bg-secondary/50 px-4 py-3 pl-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              />
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-sm text-destructive"
              >
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={loading || !token}
              className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
              style={{ letterSpacing: '-0.01em' }}
            >
              {loading ? 'Verifying…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          grace admin · internal only
        </p>
      </motion.div>
    </div>
  );
}
