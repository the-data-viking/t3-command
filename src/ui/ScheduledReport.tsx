import { useState, type ReactNode } from 'react';
import { timeAgo } from './util';

/** Preserve the complete report, rendering its potentially large body only on demand. */
export function ScheduledReport({ title, createdAt, children }: { title: string; createdAt: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="msg scheduled-report" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Scheduled report · {title} <span className="muted">{timeAgo(createdAt)}</span></summary>
    {open && <div className="msg-text markdown">{children}</div>}
  </details>;
}
