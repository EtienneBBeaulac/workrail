import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ConsoleArtifact } from '../api/types';

interface Props {
  readonly artifacts: readonly ConsoleArtifact[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function parseAlert(children: React.ReactNode): { type: string; title: string; content: React.ReactNode } | null {
  const childrenArray = React.Children.toArray(children);
  if (childrenArray.length === 0) return null;

  const firstChild = childrenArray[0];
  if (!React.isValidElement(firstChild)) return null;

  if (firstChild.type === 'p') {
    const pChildren = React.Children.toArray((firstChild as React.ReactElement<any>).props.children);
    if (pChildren.length > 0 && typeof pChildren[0] === 'string') {
      const firstText = pChildren[0];
      const match = firstText.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)/i);
      if (match) {
        const type = match[1].toLowerCase();
        const title = match[1].toUpperCase();
        const remainingText = match[2];

        const newPChildren = [remainingText, ...pChildren.slice(1)];
        const newFirstChild = React.cloneElement(firstChild as React.ReactElement<any>, {}, ...newPChildren);

        return {
          type,
          title,
          content: [newFirstChild, ...childrenArray.slice(1)],
        };
      }
    }
  }
  return null;
}

const CustomBlockquote = ({ children }: any) => {
  const parsed = parseAlert(children);
  if (parsed) {
    const { type, title, content } = parsed;
    const colors: Record<string, { border: string; bg: string; text: string }> = {
      note: { border: 'border-l-4 border-blue-500', bg: 'bg-blue-500/10', text: 'text-blue-400' },
      tip: { border: 'border-l-4 border-emerald-500', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
      important: { border: 'border-l-4 border-purple-500', bg: 'bg-purple-500/10', text: 'text-purple-400' },
      warning: { border: 'border-l-4 border-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-400' },
      caution: { border: 'border-l-4 border-red-500', bg: 'bg-red-500/10', text: 'text-red-400' },
    };
    const c = colors[type] || colors.note;
    return (
      <div className={`p-3 my-3 rounded-r ${c.border} ${c.bg}`}>
        <div className={`font-semibold text-[10px] mb-1 uppercase tracking-wider ${c.text}`}>{title}</div>
        <div className="text-xs text-[var(--text-secondary)] leading-relaxed">{content}</div>
      </div>
    );
  }
  return (
    <blockquote className="border-l-4 border-[var(--border)] pl-4 my-2 italic text-[var(--text-secondary)]">
      {children}
    </blockquote>
  );
};

export function ArtifactsTab({ artifacts }: Props) {
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  if (artifacts.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm font-mono">
        // no artifacts produced in this step
      </div>
    );
  }

  const active = artifacts[activeIndex] ?? artifacts[0];
  if (!active) return null;

  const textContent = typeof active.content === 'object'
    ? JSON.stringify(active.content, null, 2)
    : String(active.content);

  const handleCopy = () => {
    navigator.clipboard.writeText(textContent);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([textContent], { type: active.contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = active.name || 'artifact';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-[450px] border-t border-[var(--border)] text-xs overflow-hidden">
      {/* Sidebar List */}
      <div className="w-[240px] border-r border-[var(--border)] bg-[rgba(15,19,31,0.4)] flex flex-col overflow-y-auto shrink-0 select-none">
        <div className="px-3 py-2 border-b border-[var(--border)] font-mono text-[9px] uppercase tracking-wider text-[var(--text-muted)] bg-[rgba(27,31,44,0.3)]">
          Files ({artifacts.length})
        </div>
        <div className="flex-1 divide-y divide-[var(--border)]/40">
          {artifacts.map((art, idx) => (
            <button
              key={art.sha256}
              onClick={() => {
                setActiveIndex(idx);
                setCopySuccess(false);
              }}
              className={`w-full text-left px-3 py-2.5 transition-colors duration-150 relative ${
                idx === activeIndex
                  ? 'bg-[rgba(244,196,48,0.08)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[rgba(255,255,255,0.02)] hover:text-[var(--text-primary)]'
              }`}
            >
              {idx === activeIndex && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--accent)]" />
              )}
              <div className="font-medium truncate mb-0.5 text-xs">
                {art.name}
              </div>
              <div className="flex justify-between font-mono text-[9px] text-[var(--text-muted)]">
                <span>{art.contentType.split(';')[0]}</span>
                <span>{formatBytes(art.byteLength)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Preview Pane */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[rgba(27,31,44,0.2)]">
        {/* Header toolbar */}
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[rgba(27,31,44,0.4)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">
              {active.name}
            </span>
            <span className="font-mono text-[9px] text-[var(--text-muted)]">
              {active.contentType} &middot; {formatBytes(active.byteLength)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleCopy}
              className="px-2 py-1 bg-[rgba(255,255,255,0.04)] border border-[var(--border)] text-[10px] hover:bg-[rgba(255,255,255,0.08)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors rounded select-none cursor-pointer"
            >
              {copySuccess ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              className="px-2 py-1 bg-[rgba(244,196,48,0.08)] border border-[rgba(244,196,48,0.3)] text-[10px] hover:bg-[rgba(244,196,48,0.16)] text-[var(--accent)] transition-colors rounded select-none cursor-pointer"
            >
              Download
            </button>
          </div>
        </div>

        {/* Preview Container */}
        <div className="flex-1 overflow-auto p-4 leading-relaxed text-[var(--text-secondary)]">
          {active.contentType === 'text/markdown' ? (
            <div className="markdown-view max-w-none text-xs">
              <ReactMarkdown components={{ blockquote: CustomBlockquote }}>
                {String(active.content)}
              </ReactMarkdown>
            </div>
          ) : active.contentType === 'text/html' ? (
            <div className="w-full h-full bg-white rounded overflow-hidden">
              <iframe
                srcDoc={String(active.content)}
                sandbox=""
                className="w-full h-full border-0"
                title={active.name}
              />
            </div>
          ) : active.contentType === 'application/json' || active.contentType.startsWith('application/json') ? (
            <pre className="font-mono text-[11px] whitespace-pre text-[var(--text-secondary)] max-w-full overflow-x-auto">
              {textContent}
            </pre>
          ) : (
            <pre className="font-mono text-[11px] whitespace-pre-wrap text-[var(--text-secondary)]">
              {textContent}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
