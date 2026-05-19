import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Prompt } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Plus, Sparkles, FileText } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';

const cardStyle = {
  background: 'hsl(217 33% 11%)',
  border: '1px solid rgba(255,255,255,0.07)',
};

export default function PromptsPage() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [preview, setPreview] = useState<Prompt | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: api.prompts.list,
  });

  const createMutation = useMutation({
    mutationFn: (content: string) => api.prompts.create(content),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prompts'] });
      setShowNew(false);
      setNewContent('');
      toast.success('Prompt version created');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => api.prompts.activate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['prompts'] });
      toast.success('Prompt activated — takes effect on next SIGHUP');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoImproveMutation = useMutation({
    mutationFn: api.prompts.autoImprove,
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['prompts'] });
      setPreview(data.prompt);
      const { positive, negative, approvalRate } = data.stats;
      const pct = approvalRate != null ? ` (${Math.round(approvalRate * 100)}% approval)` : '';
      toast.success(`AI draft from ${positive + negative} signals${pct}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const prompts = data?.prompts ?? [];

  return (
    <div className="p-4 md:p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4 md:mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
            Prompt Manager
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Version-control your system prompts</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => autoImproveMutation.mutate()}
            disabled={autoImproveMutation.isPending}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold text-muted-foreground border transition-all duration-200 hover:text-foreground hover:bg-white/5 active:scale-[0.97] disabled:opacity-40"
            style={{ borderColor: 'rgba(255,255,255,0.1)' }}
          >
            <Sparkles className="h-4 w-4" />
            {autoImproveMutation.isPending ? 'Improving…' : 'Auto-improve'}
          </button>
          <button
            onClick={() => setShowNew((v) => !v)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-[0.97] shadow-lg shadow-primary/20"
          >
            <Plus className="h-4 w-4" />
            New version
          </button>
        </div>
      </div>

      {showNew && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl p-5 mb-4 border"
          style={cardStyle}
        >
          <p className="text-sm font-semibold text-foreground mb-3" style={{ letterSpacing: '-0.01em' }}>
            New prompt version
          </p>
          <Textarea
            rows={10}
            placeholder="Enter the full system prompt…"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            className="font-mono text-xs bg-secondary/50 border-border resize-none mb-3"
          />
          <div className="flex gap-2">
            <button
              onClick={() => createMutation.mutate(newContent)}
              disabled={newContent.trim().length < 20 || createMutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-40"
            >
              {createMutation.isPending ? 'Saving…' : 'Save draft'}
            </button>
            <button
              onClick={() => setShowNew(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Version list */}
        <div className="w-60 flex-shrink-0 flex flex-col rounded-xl overflow-hidden" style={cardStyle}>
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Versions</p>
          </div>
          <ScrollArea className="flex-1">
            {isLoading && (
              <div className="p-4 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i}>
                    <Skeleton className="h-4 w-16 mb-1.5" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                ))}
              </div>
            )}
            {prompts.length === 0 && !isLoading && (
              <div className="p-6 text-center">
                <FileText className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No versions yet</p>
              </div>
            )}
            {prompts.map((p) => (
              <button
                key={p.id}
                onClick={() => setPreview(p)}
                className="w-full text-left px-4 py-3 transition-all duration-150"
                style={{
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  borderLeft: `2px solid ${preview?.id === p.id ? 'hsl(239 84% 67%)' : 'transparent'}`,
                  background: preview?.id === p.id ? 'rgba(99,102,241,0.08)' : undefined,
                }}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[13px] font-semibold text-foreground">v{p.version}</span>
                  {p.active && (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
                      style={{ background: 'rgba(52,211,153,0.12)', color: 'rgb(110,231,183)' }}
                    >
                      active
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                </p>
              </button>
            ))}
          </ScrollArea>
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col min-w-0 rounded-xl overflow-hidden" style={cardStyle}>
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <p className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
              {preview ? `Version ${preview.version}` : 'Select a version'}
            </p>
            <div className="flex items-center gap-2">
              {preview?.active && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold"
                  style={{ background: 'rgba(52,211,153,0.12)', color: 'rgb(110,231,183)' }}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Active
                </span>
              )}
              {preview && !preview.active && (
                <button
                  onClick={() => activateMutation.mutate(preview.id)}
                  disabled={activateMutation.isPending}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-40 shadow-md shadow-primary/20"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Set active
                </button>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1">
            {!preview ? (
              <div className="h-full flex flex-col items-center justify-center py-16 text-center">
                <FileText className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">Select a prompt version to preview.</p>
              </div>
            ) : (
              <div className="p-5">
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-4">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(preview.created_at).toLocaleString()}
                  </span>
                  <span className="tabular-nums">{preview.content.length.toLocaleString()} chars</span>
                </div>
                <pre
                  className="font-mono text-xs whitespace-pre-wrap leading-relaxed text-foreground/80 rounded-xl p-4"
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  {preview.content}
                </pre>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
