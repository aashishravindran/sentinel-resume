import { Fragment, type ReactNode } from 'react';

export function Brand() {
  return (
    <span className="brand">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7z" fill="var(--pen)" />
        <path d="M10 13h12M10 17.5h8M10 22h10" stroke="var(--pen-ink)" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span>
        <strong>Resume assistant</strong>
        <small>Aashish Ravindran</small>
      </span>
    </span>
  );
}

/** Redaction bars: what a document you can't read looks like. Widths are fixed per document. */
export function Redacted({ widths, label }: { widths: number[]; label: string }) {
  return (
    <span className="redacted" role="img" aria-label={label}>
      {widths.map((w, i) => (
        <span key={i} style={{ width: `${w}rem` }} />
      ))}
    </span>
  );
}

/**
 * The answer subset of Markdown: paragraphs, "-" and "1." lists, **bold**, `code`, and [Title]
 * citations. Builds React elements, so model output can never inject HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`;
    } else {
      flushList();
      para.push(line.replace(/^#+\s*/, ''));
    }
  }
  flushPara();
  flushList();
  return <div className="answer">{blocks}</div>;
}

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\][]+\])/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('[') && part.endsWith(']'))
      return (
        <span key={i} className="cite">
          {part}
        </span>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}
