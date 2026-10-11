import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';
import { imageResource } from '../t3/assets';
import { ThreadImage } from './ThreadImage';

/** Parse message formatting without accepting HTML supplied by a thread. */
export function MessageMarkdown({ text, envId, threadId, onImageLoad }: { text: string; envId: string; threadId: string; onImageLoad?: () => void }) {
  // Streaming updates must not remount images or re-mint their URLs on every text delta.
  const components = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => href
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => <ThreadImage envId={envId}
      resource={imageResource(src ?? '', threadId)} src={src} alt={alt} title={title} onLoad={onImageLoad} />,
  }), [envId, threadId, onImageLoad]);
  return (
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) =>
      key === 'src' && imageResource(url, threadId) ? url : defaultUrlTransform(url)
    } components={components}>
      {text}
    </Markdown>
  );
}
