import React, { useState, useRef, useEffect } from 'react';
import { Bot, Sparkles, Send, Plus, Loader2, ArrowRight, Activity, AlertCircle, RefreshCcw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { AssistantProposalMarkers, isAssistantProposalMarker, type AssistantProposalMarker } from '@/components/assistant-proposal-marker';

const TOOL_LABELS: Record<string, string> = {
  get_pipeline_snapshot: "Checking pipeline metrics...",
  get_conversion_insights: "Analyzing conversion data...",
  get_appointments_stats: "Looking up appointments...",
  get_team_workload: "Reviewing team workload...",
  get_revenue_summary: "Calculating revenue...",
  get_stale_leads: "Finding stale leads..."
};

/** Maximum number of turns (user + assistant pairs) to keep. */
const MAX_TURNS = 20;

const SUGGESTIONS = [
  "What's our close rate this quarter?",
  "What's working in lead conversion?",
  "Any missed opportunities recently?",
  "Who's overloaded on the team?",
  "How are appointments looking this month?",
  "Give me a revenue pipeline summary"
];

type Message = {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  toolsRun?: string[];
  /** Actions the assistant proposed this turn; they await approval in Revenue Desk. */
  proposals?: AssistantProposalMarker[];
};

async function fetchHistory(): Promise<Message[]> {
  try {
    const res = await fetch('/api/v1/assistant/history', {
      credentials: 'include',
    });
    if (!res.ok) return [];
    const data = await res.json() as { messages: Message[] };
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    return [];
  }
}

async function persistHistory(messages: Message[]): Promise<void> {
  // Keep only the last MAX_TURNS pairs (2 messages per turn) and strip
  // error messages and empty assistant stubs before saving.
  const toSave = messages
    .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content && !m.error))
    .slice(-MAX_TURNS * 2)
    .map(({ role, content, toolsRun }) => ({ role, content, ...(toolsRun?.length ? { toolsRun } : {}) }));

  try {
    await fetch('/api/v1/assistant/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ messages: toSave }),
    });
  } catch {
    // Network error saving history — non-fatal, silently swallow.
  }
}

export default function Assistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load history from the server on mount.
  useEffect(() => {
    fetchHistory().then(loaded => {
      setMessages(loaded);
      setHistoryLoaded(true);
    });
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, currentTool]);

  // Persist history after each completed turn (not during streaming to avoid
  // writing partial assistant messages). Skip until history has been loaded
  // to prevent overwriting the server state with an empty array on mount.
  useEffect(() => {
    if (!historyLoaded) return;
    if (isGenerating) return;
    if (messages.length === 0) {
      // "New Chat" was triggered — clear history on the server too.
      persistHistory([]);
      return;
    }
    const hasComplete = messages.some(m => m.role === 'assistant' && m.content && !m.error);
    if (hasComplete) {
      persistHistory(messages);
    }
  }, [isGenerating, messages, historyLoaded]);

  const autoResizeTextarea = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const submitMessage = async (text: string) => {
    if (!text.trim() || isGenerating || !historyLoaded) return;
    
    const newMsg: Message = { role: 'user', content: text };
    const contextMessages = [...messages, newMsg].map(m => ({ role: m.role, content: m.content }));
    
    setMessages(prev => [...prev, newMsg, { role: 'assistant', content: '', toolsRun: [] }]);
    setInputValue('');
    setIsGenerating(true);
    setCurrentTool(null);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }

    try {
      const res = await fetch(`/api/v1/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: contextMessages })
      });

      if (res.status === 401) {
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], content: 'Your session has expired. Please sign in again.', error: true };
          return next;
        });
        setIsGenerating(false);
        return;
      }
      
      if (res.status === 503) {
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], content: 'Assistant is not configured on this server.', error: true };
          return next;
        });
        setIsGenerating(false);
        return;
      }
      
      if (!res.ok) throw new Error('API Error');

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No reader');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (!dataStr.trim()) continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.tool) {
                 setCurrentTool(data.tool);
                 setMessages(prev => {
                    const next = [...prev];
                    if (next.length === 0 || next[next.length - 1].role !== 'assistant') return prev;
                    const last = next[next.length - 1];
                    next[next.length - 1] = { ...last, toolsRun: [...(last.toolsRun || []), data.tool] };
                    return next;
                 });
              } else if (isAssistantProposalMarker(data.proposal)) {
                 const marker = data.proposal;
                 setMessages(prev => {
                    const next = [...prev];
                    if (next.length === 0 || next[next.length - 1].role !== 'assistant') return prev;
                    const last = next[next.length - 1];
                    next[next.length - 1] = { ...last, proposals: [...(last.proposals || []), marker] };
                    return next;
                 });
              } else if (data.content !== undefined) {
                 setCurrentTool(null);
                 setMessages(prev => {
                    const next = [...prev];
                    if (next.length === 0 || next[next.length - 1].role !== 'assistant') return prev;
                    const last = next[next.length - 1];
                    next[next.length - 1] = { ...last, content: last.content + data.content };
                    return next;
                 });
              } else if (data.error) {
                 setCurrentTool(null);
                 setMessages(prev => {
                    const next = [...prev];
                    if (next.length === 0 || next[next.length - 1].role !== 'assistant') return prev;
                    const last = next[next.length - 1];
                    next[next.length - 1] = { ...last, content: data.error, error: true };
                    return next;
                 });
              } else if (data.done) {
                 setCurrentTool(null);
              }
            } catch (e) {
              console.error('Failed to parse SSE data', dataStr);
            }
          }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], content: 'A network error occurred. Please try again.', error: true };
        return next;
      });
    } finally {
      setIsGenerating(false);
      setCurrentTool(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage(inputValue);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden relative">
      {/* Header */}
      <header className="h-14 border-b border-border flex items-center justify-between px-4 md:px-6 shrink-0 bg-background/80 backdrop-blur-md z-10 sticky top-0">
         <div className="flex items-center gap-2.5">
           <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
             <Sparkles className="w-4 h-4 text-primary" />
           </div>
           <div>
             <h1 className="font-semibold tracking-tight text-sm leading-tight text-foreground">Business Analyst</h1>
             <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">Always-On Intelligence</p>
           </div>
         </div>
         {messages.length > 0 && (
           <button 
             onClick={() => { setMessages([]); setInputValue(''); }}
             className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-muted border border-transparent hover:border-border" 
             aria-label="New chat"
           >
              <Plus className="w-3.5 h-3.5" />
              New Chat
           </button>
         )}
      </header>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-4 md:px-0 scroll-smooth">
         <div className="max-w-3xl mx-auto py-6 md:py-10 space-y-8 pb-40">
            {messages.length === 0 ? (
               <div className="flex flex-col items-center justify-center h-full min-h-[50vh] mt-10 md:mt-16 fade-in animate-in slide-in-from-bottom-4 duration-500">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-6 shadow-sm border border-primary/10">
                    <Sparkles className="w-8 h-8 text-primary" />
                  </div>
                  <h2 className="text-2xl font-bold tracking-tight mb-2 text-foreground text-center">Hello, how can I help?</h2>
                  <p className="text-muted-foreground text-sm max-w-sm text-center mb-10 leading-relaxed">
                    I can analyze your pipeline, review conversion rates, summarize appointments, or highlight team workload.
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl px-4 md:px-0">
                    {SUGGESTIONS.map((suggestion, i) => (
                      <button
                        key={i}
                        onClick={() => submitMessage(suggestion)}
                        disabled={!historyLoaded}
                        className="text-left p-4 rounded-xl border border-border bg-card/50 hover:bg-muted/50 hover:border-primary/30 transition-all flex items-start gap-3 group shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowRight className="w-4 h-4 text-primary/50 mt-0.5 group-hover:text-primary transition-colors shrink-0" />
                        <span className="text-sm font-medium text-foreground/80 group-hover:text-foreground">{suggestion}</span>
                      </button>
                    ))}
                  </div>
               </div>
            ) : (
               <div className="space-y-8">
                 {messages.map((msg, i) => (
                   <div key={i} className={cn(
                     "flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300",
                     msg.role === 'user' ? "justify-end" : "justify-start"
                   )}>
                     {msg.role === 'assistant' && (
                        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mr-4 mt-1">
                          <Bot className="w-4 h-4 text-primary" />
                        </div>
                     )}
                     
                     <div className={cn(
                        "relative max-w-[85%] md:max-w-[75%]",
                        msg.role === 'user' ? "bg-primary text-primary-foreground px-5 py-3.5 rounded-2xl rounded-tr-sm shadow-sm" : ""
                     )}>
                        {msg.role === 'user' ? (
                          <div className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</div>
                        ) : (
                          <div className="flex flex-col gap-2">
                             {/* Display what tools were run prior to the response */}
                             {msg.toolsRun && msg.toolsRun.length > 0 && (
                                <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground bg-muted/40 w-fit px-2.5 py-1 rounded-full border border-border/30 mb-1">
                                  <Activity className="w-3 h-3" />
                                  Analyzed {msg.toolsRun.length} {msg.toolsRun.length === 1 ? 'data source' : 'data sources'}
                                </div>
                             )}
                             <AssistantProposalMarkers proposals={msg.proposals} />
                             
                             <div className={cn(
                               "prose prose-sm md:prose-base dark:prose-invert max-w-none",
                               "prose-p:leading-relaxed prose-p:mb-4 last:prose-p:mb-0",
                               "prose-ul:list-disc prose-ul:pl-5 prose-ul:mb-4 prose-li:mb-1 last:prose-ul:mb-0",
                               "prose-ol:list-decimal prose-ol:pl-5 prose-ol:mb-4 prose-li:mb-1",
                               "prose-h3:text-sm prose-h3:font-bold prose-h3:uppercase prose-h3:tracking-wider prose-h3:text-muted-foreground prose-h3:mt-6 prose-h3:mb-2",
                               "prose-h2:text-lg prose-h2:font-bold prose-h2:tracking-tight prose-h2:mt-6 prose-h2:mb-3",
                               "prose-strong:font-bold prose-strong:text-foreground",
                               "prose-a:text-primary prose-a:underline prose-a:underline-offset-2",
                               "prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:bg-muted prose-code:text-foreground prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
                               "prose-table:w-full prose-table:my-4 prose-th:p-2 prose-th:text-left prose-th:font-semibold prose-th:border-b prose-th:border-border prose-td:p-2 prose-td:border-b prose-td:border-border/50 text-foreground/90",
                               msg.error ? "text-destructive" : ""
                             )}>
                               {msg.error && (
                                  <div className="flex items-center gap-2 mb-2 text-destructive font-semibold">
                                    <AlertCircle className="w-4 h-4" />
                                    Failed to generate response
                                  </div>
                               )}
                               {!msg.content && !msg.error && !currentTool && isGenerating && i === messages.length - 1 ? (
                                  <div className="flex items-center h-6">
                                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce mr-1" />
                                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce mr-1" style={{ animationDelay: '0.15s' }} />
                                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
                                  </div>
                               ) : (
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {msg.content}
                                  </ReactMarkdown>
                               )}
                             </div>
                          </div>
                        )}
                     </div>
                   </div>
                 ))}
               </div>
            )}
            <div ref={messagesEndRef} className="h-4" />
         </div>
      </div>

      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background/95 to-transparent pt-12 pb-4 md:pb-6 px-4 md:px-0">
        <div className="max-w-3xl mx-auto relative">
           
           {/* Current Tool Indicator */}
           {currentTool && (
              <div className="absolute -top-12 left-0 flex items-center gap-2 text-xs font-medium text-primary bg-primary/10 border border-primary/20 px-3 py-1.5 rounded-full shadow-sm animate-in fade-in slide-in-from-bottom-2">
                 <RefreshCcw className="w-3.5 h-3.5 animate-spin" />
                 {TOOL_LABELS[currentTool] || "Analyzing data..."}
              </div>
           )}
           
           <div className={cn(
              "relative flex items-end w-full rounded-2xl bg-card border shadow-sm transition-all overflow-hidden",
              isGenerating ? "border-border/50 bg-muted/30" : "border-border focus-within:ring-4 focus-within:ring-primary/10 focus-within:border-primary"
           )}>
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  autoResizeTextarea();
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask about pipeline, team workload, or metrics..."
                disabled={isGenerating || !historyLoaded}
                className="w-full max-h-[200px] bg-transparent text-sm resize-none outline-none py-4 pl-4 pr-14 disabled:opacity-50 min-h-[56px] leading-relaxed"
                rows={1}
              />
              <div className="absolute right-2 bottom-2">
                <button 
                  onClick={() => submitMessage(inputValue)}
                  disabled={!inputValue.trim() || isGenerating || !historyLoaded}
                  aria-label="Send message"
                  className={cn(
                    "w-10 h-10 flex items-center justify-center rounded-xl transition-all shadow-sm",
                    !inputValue.trim() || isGenerating
                      ? "bg-muted text-muted-foreground opacity-50 cursor-not-allowed"
                      : "bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 active:scale-95"
                  )}
                >
                  {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5 ml-0.5" />}
                </button>
              </div>
           </div>
           
           <div className="text-center mt-3 flex items-center justify-center gap-2">
             <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
             <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Ready to assist</span>
           </div>
        </div>
      </div>
    </div>
  );
}
