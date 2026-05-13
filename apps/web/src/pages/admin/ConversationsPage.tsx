import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Conversation, type Message } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Radio, MessageSquare } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

const cardStyle = {
  background: 'hsl(217 33% 11%)',
  border: '1px solid rgba(255,255,255,0.07)',
  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
};

export default function ConversationsPage() {
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamMessages, setStreamMessages] = useState<Message[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setStreaming(false);
    setStreamMessages([]);
  }, [selected?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgData, streamMessages]);

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
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
          Conversations
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Live view of user threads</p>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Conversation list */}
        <div className="w-72 flex-shrink-0 flex flex-col rounded-xl overflow-hidden" style={cardStyle}>
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Active conversations
            </p>
          </div>
          <ScrollArea className="flex-1">
            {isLoading && (
              <div className="p-4 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i}>
                    <Skeleton className="h-4 w-32 mb-1.5" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                ))}
              </div>
            )}
            {convData?.conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className={cn(
                  'w-full text-left px-4 py-3 transition-all duration-150',
                  selected?.id === c.id
                    ? 'bg-primary/10 border-l-2 border-primary'
                    : 'border-l-2 border-transparent hover:bg-white/4',
                )}
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <p className="text-[13px] font-medium text-foreground truncate">{c.user_id}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {c.message_count} msgs ·{' '}
                  {c.last_message_at
                    ? formatDistanceToNow(new Date(c.last_message_at), { addSuffix: true })
                    : 'no messages'}
                </p>
              </button>
            ))}
            {convData?.conversations.length === 0 && !isLoading && (
              <div className="p-6 text-center">
                <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No conversations yet.</p>
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Thread pane */}
        <div className="flex-1 flex flex-col min-w-0 rounded-xl overflow-hidden" style={cardStyle}>
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <p className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
              {selected ? `Thread — ${selected.user_id}` : 'Select a conversation'}
            </p>
            {selected && (
              <button
                onClick={streaming ? stopStream : startStream}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 active:scale-[0.97]',
                  streaming
                    ? 'bg-destructive/15 text-red-400 hover:bg-destructive/20'
                    : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15',
                )}
              >
                <Radio className={cn('h-3 w-3', streaming && 'animate-pulse')} />
                {streaming ? 'Stop live' : 'Go live'}
              </button>
            )}
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-3">
              {!selected && (
                <div className="h-full flex flex-col items-center justify-center py-16 text-center">
                  <MessageSquare className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Select a conversation to view messages.</p>
                </div>
              )}
              {allMessages.map((m, i) => (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.2 }}
                  className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[72%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed',
                      m.role === 'user'
                        ? 'rounded-tr-sm text-white'
                        : 'rounded-tl-sm text-foreground',
                    )}
                    style={
                      m.role === 'user'
                        ? { background: 'hsl(239 84% 67%)' }
                        : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.06)' }
                    }
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    <p className="text-[10px] opacity-50 mt-1 text-right tabular-nums">
                      {new Date(m.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                </motion.div>
              ))}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
