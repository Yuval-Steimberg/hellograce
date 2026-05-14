import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ToolSetting } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';
import { Wrench } from 'lucide-react';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  log_food:       'Parses food descriptions via LLM; writes protein/calorie estimates to food_logs.',
  log_weight:     'Validates weight input (60–700 lbs) and writes to weight_logs.',
  log_mood:       'Validates mood score (1–10) and writes to check_ins.',
  knowledge_search: 'Retrieves GLP-1 knowledge from the pgvector embedding store (RAG).',
  log_side_effect: 'Sets side_effect_flow and schedules a 4-hour follow-up message.',
  get_user_profile: 'Returns the user\'s goals, medication, weight, and behavioral flags.',
  get_weight_trend: 'Last 10 weight entries plus up/down/stable trend.',
  get_food_summary: 'Today\'s protein + calories + protein_goal_met flag.',
};

const stagger = { show: { transition: { staggerChildren: 0.06 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

export default function ToolsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['tool-settings'],
    queryFn: api.toolSettings.list,
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, enabled, priority }: { name: string; enabled: boolean; priority: number }) =>
      api.toolSettings.update(name, enabled, priority),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tool-settings'] });
      toast.success('Tool setting saved');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
          Tool Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Toggle tools and adjust priority. Changes take effect immediately — no restart needed.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-xl border p-5" style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-center justify-between mb-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-6 w-10 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full mb-4" />
              <Skeleton className="h-7 w-24" />
            </div>
          ))}
        </div>
      ) : (data?.tools ?? []).length === 0 ? (
        <EmptyTools />
      ) : (
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          {(data?.tools ?? []).map((tool) => (
            <motion.div key={tool.tool_name} variants={fadeUp}>
              <ToolCard
                tool={tool}
                onUpdate={(enabled, priority) =>
                  updateMutation.mutate({ name: tool.tool_name, enabled, priority })
                }
                saving={updateMutation.isPending}
              />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

function ToolCard({
  tool,
  onUpdate,
  saving,
}: {
  tool: ToolSetting;
  onUpdate: (enabled: boolean, priority: number) => void;
  saving: boolean;
}) {
  const [priority, setPriority] = useState(String(tool.priority));

  return (
    <div
      className="rounded-xl p-5 border transition-all duration-200 hover:brightness-105"
      style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0 mr-3">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="font-mono text-[13px] font-semibold text-foreground"
              style={{ letterSpacing: '-0.01em' }}
            >
              {tool.tool_name}
            </span>
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
              style={
                tool.enabled
                  ? { background: 'rgba(52,211,153,0.12)', color: 'rgb(110,231,183)' }
                  : { background: 'rgba(100,116,139,0.12)', color: 'rgb(148,163,184)' }
              }
            >
              {tool.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {TOOL_DESCRIPTIONS[tool.tool_name] ?? 'Custom tool.'}
          </p>
        </div>
        <Switch
          checked={tool.enabled}
          onCheckedChange={(checked) => onUpdate(checked, tool.priority)}
          disabled={saving}
        />
      </div>

      <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Label
          htmlFor={`priority-${tool.tool_name}`}
          className="text-[11px] text-muted-foreground whitespace-nowrap font-medium uppercase tracking-wider"
        >
          Priority
        </Label>
        <Input
          id={`priority-${tool.tool_name}`}
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={() => {
            const p = parseInt(priority, 10);
            if (!isNaN(p)) onUpdate(tool.enabled, p);
          }}
          className="h-7 text-xs w-20 bg-secondary/50 border-border"
          disabled={saving}
        />
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
          {formatDistanceToNow(new Date(tool.updated_at), { addSuffix: true })}
        </span>
      </div>
    </div>
  );
}

function EmptyTools() {
  return (
    <div className="rounded-xl border py-16 flex flex-col items-center gap-3" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Wrench className="h-6 w-6 text-primary" />
      </div>
      <div className="text-center">
        <p className="font-semibold text-foreground mb-1">No tool settings found</p>
        <p className="text-sm text-muted-foreground">Run the Phase 4 migration to seed defaults.</p>
      </div>
    </div>
  );
}
