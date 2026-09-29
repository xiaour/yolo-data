function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderInline(value) {
  const codeTokens = [];
  let text = escapeHtml(value).replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\uE000${codeTokens.length}\uE000`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return text.replace(/\uE000(\d+)\uE000/g, (_match, index) => (
    codeTokens[Number(index)] ?? ''
  ));
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length >= 2
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function splitTableRow(line) {
  return String(line ?? '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines, startIndex) {
  const headers = splitTableRow(lines[startIndex]);
  let index = startIndex + 2;
  const rows = [];
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  return {
    html: `
      <div class="markdown-table-wrap">
        <table class="data-table markdown-table">
          <thead>
            <tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>${headers.map((_, cellIndex) => (
                `<td>${renderInline(row[cellIndex] ?? '')}</td>`
              )).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `,
    nextIndex: index,
  };
}

export function renderSafeMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = null;
  };
  const openList = (type) => {
    if (listType === type) {
      return;
    }
    closeList();
    listType = type;
    html.push(`<${type}>`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    if (trimmed.startsWith('```')) {
      flushParagraph();
      closeList();
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      html.push(
        `<pre class="markdown-code"${language ? ` data-language="${escapeHtml(language)}"` : ''}><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(Math.max(heading[1].length, 2), 5);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      index + 1 < lines.length
      && line.includes('|')
      && isTableSeparator(lines[index + 1])
    ) {
      flushParagraph();
      closeList();
      const table = renderTable(lines, index);
      html.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      openList('ul');
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      openList('ol');
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeList();
      html.push('<hr />');
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('');
}
