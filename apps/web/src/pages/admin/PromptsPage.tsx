import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Prompt } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Plus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

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
      toast.success('Prompt activated — takes effect on next SIGHUP or restart');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const prompts = data?.prompts ?? [];

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-serif text-2xl">Prompt Manager</h1>
        <Button size="sm" onClick={() => setShowNew((v) => !v)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          New version
        </Button>
      </div>

      {showNew && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-sm font-medium">New prompt version</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={10}
              placeholder="Enter the full system prompt…"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate(newContent)}
                disabled={newContent.trim().length < 20 || createMutation.isPending}
              >
                {createMutation.isPending ? 'Saving…' : 'Save draft'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Version list */}
        <Card className="w-64 flex-shrink-0 flex flex-col">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Versions</CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1">
            <CardContent className="p-0">
              {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
              {prompts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreview(p)}
                  className={`w-full text-left px-4 py-3 border-b border-border hover:bg-muted/50 transition-colors ${
                    preview?.id === p.id ? 'bg-primary/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-sm font-medium">v{p.version}</span>
                    {p.active && (
                      <Badge className="text-xs bg-green-100 text-green-700 border-0">active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                  </p>
                </button>
              ))}
            </CardContent>
          </ScrollArea>
        </Card>

        {/* Preview pane */}
        <Card className="flex-1 flex flex-col min-w-0">
          <CardHeader className="py-3 flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">
              {preview ? `Version ${preview.version}` : 'Select a version'}
            </CardTitle>
            {preview && !preview.active && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => activateMutation.mutate(preview.id)}
                disabled={activateMutation.isPending}
                className="gap-1.5"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Set active
              </Button>
            )}
            {preview?.active && (
              <Badge className="bg-green-100 text-green-700 border-0 gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Active
              </Badge>
            )}
          </CardHeader>
          <Separator />
          <ScrollArea className="flex-1">
            <CardContent className="pt-4">
              {!preview && (
                <p className="text-sm text-muted-foreground">Select a prompt version to preview.</p>
              )}
              {preview && (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(preview.created_at).toLocaleString()}
                    </span>
                    <span>{preview.content.length} chars</span>
                  </div>
                  <pre className="font-mono text-xs whitespace-pre-wrap text-foreground leading-relaxed">
                    {preview.content}
                  </pre>
                </>
              )}
            </CardContent>
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}
