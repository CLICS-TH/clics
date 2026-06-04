interface Message {
  role: string; content: string;
  refs?: { source: string; title?: string }[];
  socratic_question?: string;
}
export function TranscriptView({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-3 max-h-[60vh] overflow-y-auto p-4 bg-secondary rounded-lg">
      {messages.map((m, i) => (
        <div key={i} className={`rounded-xl p-3 text-sm max-w-[85%] ${
          m.role === 'physician' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-card border border-border'
        }`}>
          <p className="whitespace-pre-wrap">{m.content}</p>
          {m.refs?.length ? (
            <p className="mt-1 text-xs opacity-70">📎 {m.refs.map(r => r.source ?? r.title).join(' · ')}</p>
          ) : null}
          {m.socratic_question && (
            <p className="mt-1 text-xs italic text-primary">❓ {m.socratic_question}</p>
          )}
        </div>
      ))}
    </div>
  );
}
