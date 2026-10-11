import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Parse message formatting without accepting HTML supplied by a thread. */
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => href
        ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
    }}>
      {text}
    </Markdown>
  );
}
