import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ToolSetting } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  log_food: 'Parses food descriptions via LLM and writes protein/calorie estimates to food_logs.',
  log_weight: 'Validates weight input (60–700) and writes to weight_logs.',
  log_mood: 'Validates mood score (1–10) and writes to check_ins.',
  knowledge_search: 'Retrieves GLP-1 knowledge from the pgvector embedding store (RAG).',
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

  if (isLoading) {
    return (
      <div className="p-6">
        <h1 className="font-serif text-2xl mb-6">Tool Settings</h1>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="font-serif text-2xl mb-2">Tool Settings</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Enable or disable tools and set their execution priority. Changes take effect on the next
        message — no restart needed.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(data?.tools ?? []).map((tool) => (
          <ToolCard
            key={tool.tool_name}
            tool={tool}
            onUpdate={(enabled, priority) =>
              updateMutation.mutate({ name: tool.tool_name, enabled, priority })
            }
            saving={updateMutation.isPending}
          />
        ))}
        {(data?.tools ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground col-span-2">
            No tool settings found. Run the Phase 4 migration to seed defaults.
          </p>
        )}
      </div>
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
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base font-medium font-mono">{tool.tool_name}</CardTitle>
            <Badge variant={tool.enabled ? 'default' : 'secondary'} className="text-xs">
              {tool.enabled ? 'enabled' : 'disabled'}
            </Badge>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => onUpdate(checked, tool.priority)}
            disabled={saving}
          />
        </div>
        <CardDescription className="text-xs mt-1">
          {TOOL_DESCRIPTIONS[tool.tool_name] ?? 'Custom tool.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-2">
          <Label htmlFor={`priority-${tool.tool_name}`} className="text-xs text-muted-foreground whitespace-nowrap">
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
            className="h-7 text-xs w-24"
            disabled={saving}
          />
          <span className="text-xs text-muted-foreground ml-auto">
            Updated {formatDistanceToNow(new Date(tool.updated_at), { addSuffix: true })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
