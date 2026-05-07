import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Conversation, type Message } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Radio } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

export default function ConversationsPage() {
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamMessages, setStreamMessages] = useState<Message[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const { data: convData, isLoading } = useQuery({
    queryKey: ['conversations'],
    queryFn: api.conversations,
    refetchInterval: 15_000,
  });

  const { data: msgData } = useQuery({
    queryKey: ['messages', selected?.user_id],
    queryFn: () => api.messages(selected!.user_id),
    enabled: !!selected,
  });

  // Clean up SSE on conversation switch
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setStreaming(false);
    setStreamMessages([]);
  }, [selected?.id]);

  const startStream = () => {
    if (!selected || esRef.current) return;
    const es = new EventSource(`${BASE}/chat/stream/${selected.id}`);
    es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data) as Message;
      setStreamMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });
    esRef.current = es;
    setStreaming(true);
  };

  const stopStream = () => {
    esRef.current?.close();
    esRef.current = null;
    setStreaming(false);
  };

  const allMessages: Message[] = [
    ...(msgData?.messages ?? []),
    ...streamMessages.filter((sm) => !msgData?.messages.some((m) => m.id === sm.id)),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return (
    <div className="p-6 h-full flex flex-col">
      <h1 className="font-serif text-2xl mb-4">Conversations</h1>
      <div className="flex gap-4 flex-1 min-h-0">
        {/* List */}
        <Card className="w-72 flex-shrink-0 flex flex-col">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Active conversations</CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1">
            <CardContent className="p-0">
              {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
              {convData?.conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={cn(
                    'w-full text-left px-4 py-3 border-b border-border hover:bg-muted/50 transition-colors',
                    selected?.id === c.id && 'bg-primary/5',
                  )}
                >
                  <p className="text-sm font-medium truncate">{c.user_id}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {c.message_count} msgs ·{' '}
                    {c.last_message_at
                      ? formatDistanceToNow(new Date(c.last_message_at), { addSuffix: true })
                      : 'no messages'}
                  </p>
                </button>
              ))}
              {convData?.conversations.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">No conversations yet.</p>
              )}
            </CardContent>
          </ScrollArea>
        </Card>

        {/* Thread */}
        <Card className="flex-1 flex flex-col min-w-0">
          <CardHeader className="py-3 flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">
              {selected ? `Thread — ${selected.user_id}` : 'Select a conversation'}
            </CardTitle>
            {selected && (
              <Button
                size="sm"
                variant={streaming ? 'destructive' : 'outline'}
                onClick={streaming ? stopStream : startStream}
                className="gap-1.5"
              >
                <Radio className="h-3 w-3" />
                {streaming ? 'Stop live' : 'Live'}
              </Button>
            )}
          </CardHeader>
          <ScrollArea className="flex-1">
            <CardContent className="space-y-3">
              {!selected && (
                <p className="text-sm text-muted-foreground">Select a conversation on the left.</p>
              )}
              {allMessages.map((m) => (
                <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm',
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-sm'
                        : 'bg-muted text-foreground rounded-tl-sm',
                    )}
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    <p className="text-xs opacity-60 mt-1 text-right">
                      {new Date(m.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}
