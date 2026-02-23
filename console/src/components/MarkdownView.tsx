import ReactMarkdown from 'react-markdown';

interface Props {
  children: string;
  className?: string;
}

/**
 * Renders markdown content with dark-theme-aware typography.
 * Uses react-markdown for safe, standards-compliant rendering.
 */
export function MarkdownView({ children, className }: Props) {
  return (
    <div className={`markdown-view ${className ?? ''}`}>
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
