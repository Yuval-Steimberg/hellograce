import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type MessageTemplate } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { CreditCard, Save, Eye, RotateCcw } from 'lucide-react';

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

const TEMPLATE_LABELS: Record<string, string> = {
  paywall: 'Paywall (trial expired)',
  trial_reminder: 'Trial Day 2 Reminder',
  welcome: 'Welcome Message',
  upgrade_nudge: 'Upgrade Nudge',
};

const PREVIEW_VARS: Record<string, Record<string, string>> = {
  paywall: { upgrade_url: 'https://grace-admin-silk.vercel.app/upgrade?phone=+15551234567', first_name: 'Sam' },
  trial_reminder: { upgrade_url: 'https://grace-admin-silk.vercel.app/upgrade?phone=+15551234567' },
  welcome: { first_name: 'Sam', medication: 'Mounjaro', goal: 'losing weight', upgrade_url: '' },
  upgrade_nudge: { upgrade_url: 'https://grace-admin-silk.vercel.app/upgrade?phone=+15551234567', first_name: 'Sam' },
};

function TemplateCard({ template }: { template: MessageTemplate }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(template.template);
  const [previewing, setPreviewing] = useState(false);

  const dirty = draft !== template.template;

  const updateMut = useMutation({
    mutationFn: () => api.messageTemplates.update(template.key, draft),
    onSuccess: () => {
      toast.success(`${TEMPLATE_LABELS[template.key] ?? template.key} updated`);
      qc.invalidateQueries({ queryKey: ['admin', 'message-templates'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const previewQuery = useQuery({
    queryKey: ['admin', 'message-templates', 'preview', template.key, draft],
    queryFn: () => api.messageTemplates.preview(template.key, PREVIEW_VARS[template.key] ?? {}),
    enabled: previewing,
  });

  return (
    <motion.div
      variants={fadeUp}
      className="rounded-2xl border p-5 flex flex-col gap-4"
      style={CARD_STYLE}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <CreditCard className="h-4 w-4 text-primary" />
            <h3 className="text-base font-semibold tracking-tight">
              {TEMPLATE_LABELS[template.key] ?? template.key}
            </h3>
          </div>
          {template.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{template.description}</p>
          )}
        </div>
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: 'rgba(99,102,241,0.15)', color: 'rgb(165,180,252)' }}
        >
          {template.key}
        </span>
      </div>

      {template.variables.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {template.variables.map((v) => (
            <code
              key={v}
              className="px-2 py-0.5 rounded text-[11px] font-mono"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgb(165,180,252)' }}
            >
              {'{' + v + '}'}
            </code>
          ))}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        className="bg-white/5 border rounded-lg px-3 py-2 text-sm font-mono leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-y"
        style={{ borderColor: 'rgba(255,255,255,0.1)' }}
      />

      {previewing && previewQuery.data && (
        <div
          className="rounded-lg p-3 text-sm leading-relaxed"
          style={{
            background: 'rgba(34,197,94,0.08)',
            borderLeft: '3px solid rgb(74,222,128)',
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">
            Preview (with sample vars)
          </div>
          <div className="text-foreground whitespace-pre-wrap">{previewQuery.data.rendered}</div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => updateMut.mutate()}
          disabled={!dirty || updateMut.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          <Save className="h-3.5 w-3.5" />
          {updateMut.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => setPreviewing((p) => !p)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border text-foreground hover:bg-white/5 transition-colors"
          style={{ borderColor: 'rgba(255,255,255,0.1)' }}
        >
          <Eye className="h-3.5 w-3.5" />
          {previewing ? 'Hide preview' : 'Preview'}
        </button>
        {dirty && (
          <button
            onClick={() => setDraft(template.template)}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Revert
          </button>
        )}
        <div className="ml-auto text-[11px] text-muted-foreground">
          Updated {new Date(template.updated_at).toLocaleString()}
        </div>
      </div>
    </motion.div>
  );
}

export default function SubscriptionMessagesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'message-templates'],
    queryFn: () => api.messageTemplates.list(),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border p-6" style={CARD_STYLE}>
        <p className="text-sm text-rose-400">
          Failed to load templates: {(error as Error).message}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          The <code>message_templates</code> table may not exist yet. Run migration{' '}
          <code>20260520000001_message_templates.sql</code> in Supabase.
        </p>
      </div>
    );
  }

  const templates = data?.templates ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Subscription Messages</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-relaxed">
          Edit the four user-facing subscription messages. Changes apply within 60 seconds
          (cache TTL), no deploy needed. Variables in curly braces ({'{first_name}'}) are
          substituted at send time; preview shows the rendered output with sample values.
        </p>
      </div>

      <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
        {templates.length === 0 ? (
          <div className="rounded-2xl border p-6 text-sm text-muted-foreground" style={CARD_STYLE}>
            No templates found. Run the migration to seed defaults.
          </div>
        ) : (
          templates.map((tpl) => <TemplateCard key={tpl.id} template={tpl} />)
        )}
      </motion.div>
    </div>
  );
}
