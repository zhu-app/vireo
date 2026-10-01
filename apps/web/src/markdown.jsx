import React, { useState } from 'react';

// ---------- 轻量安全的 Markdown 渲染（React 节点输出，天然防 XSS；链接协议白名单） ----------
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function InlineTokens({ text }) {
  const parts = [];
  // 切分：`code`、**bold**、*italic*、[text](url)
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={key++} className="inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const m = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m && SAFE_URL.test(m[2])) {
        parts.push(<a key={key++} href={m[2]} target="_blank" rel="noreferrer noopener">{m[1]}</a>);
      } else {
        parts.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <button onClick={copy}>{copied ? '✓ 已复制' : '复制'}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function renderTable(rows) {
  const parse = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = parse(rows[0]);
  const body = rows.slice(2).map(parse);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text, streaming }) {
  const blocks = [];
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(<CodeBlock key={key++} lang={lang} code={code.join('\n')} />);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 2, 6)}`;
      blocks.push(<Tag key={key++} className="md-h">{InlineTokens({ text: heading[2] })}</Tag>);
      i += 1;
      continue;
    }

    if (/^\s*(?:[-*•])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*(?:[-*•])\s+/.test(lines[i])) {
        const checked = lines[i].match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/);
        if (checked) {
          items.push(
            <li key={items.length} className="task">
              <span className={checked[1].toLowerCase() === 'x' ? 'checkbox done' : 'checkbox'}>{checked[1].toLowerCase() === 'x' ? '✓' : ''}</span>
              <InlineTokens text={checked[2]} />
            </li>
          );
        } else {
          items.push(<li key={items.length}><InlineTokens text={lines[i].replace(/^\s*(?:[-*•])\s+/, '')} /></li>);
        }
        i += 1;
      }
      blocks.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{lines[i].replace(/^\s*\d+[.)]\s+/, '')}</li>);
        i += 1;
      }
      blocks.push(<ol key={key++}>{items}</ol>);
      continue;
    }

    if (/^\|.*\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim());
        i += 1;
      }
      blocks.push(renderTable(rows));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={key++}>{quote.map((q, j) => <p key={j}>{InlineTokens({ text: q })}</p>)}</blockquote>);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\||>|\s*-{3,}\s*$)/.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={key++}>{paragraph.map((p, j) => (
      <React.Fragment key={j}>{j > 0 && <br />}{InlineTokens({ text: p })}</React.Fragment>
    ))}</p>);
  }

  return (
    <div className="markdown">
      {blocks}
      {streaming && <span className="caret" />}
    </div>
  );
}
