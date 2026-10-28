/**
 * Markdown from an agent (a supervisor's answer), rendered as untrusted:
 * src/shared/safe-markdown.ts reads it into blocks and runs, and this makes
 * React elements of them. No HTML is ever made from the text (React escapes
 * every string), no image is loaded, and the only links are the ones the
 * reader allowed: the dashboard's own routes, and the repository's host
 * (opened in a new tab, without a referrer).
 */
import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline, type LinkPolicy } from "../../shared/safe-markdown";

function runs(list: Inline[], key: string): ReactNode[] {
  return list.map((run, i) => {
    const k = `${key}.${i}`;
    switch (run.type) {
      case "text":
        return <Fragment key={k}>{run.text}</Fragment>;
      case "code":
        return <code key={k}>{run.text}</code>;
      case "strong":
        return <strong key={k}>{runs(run.children, k)}</strong>;
      case "em":
        return <em key={k}>{runs(run.children, k)}</em>;
      case "link":
        return run.href.startsWith("#/") ? (
          <a key={k} href={run.href}>
            {runs(run.children, k)}
          </a>
        ) : (
          <a key={k} href={run.href} target="_blank" rel="noopener noreferrer nofollow">
            {runs(run.children, k)}
          </a>
        );
      default:
        return null;
    }
  });
}

function block(b: Block, i: number): ReactNode {
  const k = `b${i}`;
  switch (b.type) {
    case "heading": {
      const children = runs(b.children, k);
      if (b.level === 1) return <h3 key={k}>{children}</h3>;
      if (b.level === 2) return <h4 key={k}>{children}</h4>;
      return <h5 key={k}>{children}</h5>;
    }
    case "paragraph":
      return <p key={k}>{runs(b.children, k)}</p>;
    case "list": {
      const items = b.items.map((item, j) => <li key={`${k}.${j}`}>{runs(item, `${k}.${j}`)}</li>);
      return b.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
    case "code":
      return (
        <pre key={k}>
          <code>{b.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={k}>{runs(b.children, k)}</blockquote>;
    case "rule":
      return <hr key={k} />;
    default:
      return null;
  }
}

export function SafeMarkdown({ text, policy }: { text: string; policy: LinkPolicy }) {
  return <div className="safe-markdown">{parseMarkdown(text, policy).map(block)}</div>;
}
