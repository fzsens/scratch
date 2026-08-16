import {
  Extension,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownRendererHelpers,
  type MarkdownToken,
} from "@tiptap/core";
import {
  Table,
  renderTableToMarkdown,
  type TableOptions,
} from "@tiptap/extension-table";

const RICH_TABLE_ATTRIBUTE = "data-scratch-rich-table";
const LEGACY_CELL_SEPARATOR = "\u001f";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textContent(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textContent).join("");
}

function renderInlineHtml(nodes: JSONContent[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        let output = escapeHtml(node.text ?? "");

        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case "bold":
              output = `<strong>${output}</strong>`;
              break;
            case "italic":
              output = `<em>${output}</em>`;
              break;
            case "strike":
              output = `<s>${output}</s>`;
              break;
            case "code":
              output = `<code>${output}</code>`;
              break;
            case "link": {
              const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
              output = `<a href="${escapeHtml(href)}">${output}</a>`;
              break;
            }
          }
        }

        return output;
      }

      if (node.type === "hardBreak") return "<br>";

      if (node.type === "image") {
        const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
      }

      if (node.type === "wikilink") {
        const title = typeof node.attrs?.noteTitle === "string" ? node.attrs.noteTitle : "";
        return `<span data-scratch-wikilink="${escapeHtml(title)}"></span>`;
      }

      return escapeHtml(textContent(node));
    })
    .join("");
}

function renderBlockHtml(node: JSONContent): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderInlineHtml(node.content)}</p>`;
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      return `<pre><code${className}>${escapeHtml(textContent(node))}</code></pre>`;
    }
    case "bulletList":
      return `<ul>${(node.content ?? []).map(renderBlockHtml).join("")}</ul>`;
    case "orderedList": {
      const startValue = node.attrs?.start;
      const start = Number.isInteger(startValue) ? ` start="${startValue}"` : "";
      return `<ol${start}>${(node.content ?? []).map(renderBlockHtml).join("")}</ol>`;
    }
    case "listItem":
      return `<li>${(node.content ?? []).map(renderBlockHtml).join("")}</li>`;
    default:
      return `<p>${renderInlineHtml(node.content)}</p>`;
  }
}

function requiresRichTableStorage(table: JSONContent): boolean {
  return (table.content ?? []).some((row) =>
    (row.content ?? []).some((cell) => {
      const blocks = cell.content ?? [];
      return (
        blocks.length !== 1 ||
        blocks[0]?.type !== "paragraph" ||
        (blocks[0]?.content ?? []).some((node) => node.type === "hardBreak")
      );
    }),
  );
}

function renderRichTableAsHtml(table: JSONContent): string {
  const rows = table.content ?? [];
  const hasHeader = (rows[0]?.content ?? []).some(
    (cell) => cell.type === "tableHeader",
  );
  const renderRow = (row: JSONContent) => {
    const cells = (row.content ?? [])
      .map((cell) => {
        const tag = cell.type === "tableHeader" ? "th" : "td";
        return `<${tag}>${(cell.content ?? []).map(renderBlockHtml).join("")}</${tag}>`;
      })
      .join("");
    return `<tr>${cells}</tr>`;
  };

  const header = hasHeader && rows[0] ? `<thead>${renderRow(rows[0])}</thead>` : "";
  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const body = bodyRows.length > 0 ? `<tbody>${bodyRows.map(renderRow).join("")}</tbody>` : "";

  return `\n<table ${RICH_TABLE_ATTRIBUTE}="true">${header}${body}</table>\n`;
}

function restoreLegacyCellSeparators(content: JSONContent[]): JSONContent[] {
  return content.flatMap((node) => {
    if (node.type !== "text" || !node.text?.includes(LEGACY_CELL_SEPARATOR)) {
      return [node];
    }

    return node.text.split(LEGACY_CELL_SEPARATOR).flatMap((part, index) => {
      const nodes: JSONContent[] = [];
      if (part) nodes.push({ ...node, text: part });
      if (index > 0) nodes.unshift({ type: "hardBreak" });
      return nodes;
    });
  });
}

function parsePipeTable(token: MarkdownToken, h: MarkdownParseHelpers): JSONContent {
  const tableToken = token as MarkdownToken & {
    header?: Array<{ tokens: MarkdownToken[] }>;
    rows?: Array<Array<{ tokens: MarkdownToken[] }>>;
  };
  const rows: JSONContent[] = [];

  if (tableToken.header) {
    const cells = tableToken.header.map((cell) =>
      h.createNode("tableHeader", {}, [
        h.createNode("paragraph", {}, restoreLegacyCellSeparators(h.parseInline(cell.tokens))),
      ]),
    );
    rows.push(h.createNode("tableRow", {}, cells));
  }

  for (const row of tableToken.rows ?? []) {
    const cells = row.map((cell) =>
      h.createNode("tableCell", {}, [
        h.createNode("paragraph", {}, restoreLegacyCellSeparators(h.parseInline(cell.tokens))),
      ]),
    );
    rows.push(h.createNode("tableRow", {}, cells));
  }

  return h.createNode("table", undefined, rows);
}

function readInlineHtml(
  nodes: NodeListOf<ChildNode> | ChildNode[],
  h: MarkdownParseHelpers,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [],
): JSONContent[] {
  return Array.from(nodes).flatMap((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ? [h.createTextNode(node.textContent, marks)] : [];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") return [h.createNode("hardBreak")];
    if (tag === "img") {
      return [
        h.createNode("image", {
          src: element.getAttribute("src") ?? "",
          alt: element.getAttribute("alt"),
        }),
      ];
    }
    if (tag === "span" && element.hasAttribute("data-scratch-wikilink")) {
      return [
        h.createNode("wikilink", {
          noteTitle: element.getAttribute("data-scratch-wikilink") ?? "",
        }),
      ];
    }

    const mark =
      tag === "strong" || tag === "b"
        ? { type: "bold" }
        : tag === "em" || tag === "i"
          ? { type: "italic" }
          : tag === "s" || tag === "del" || tag === "strike"
            ? { type: "strike" }
            : tag === "code"
              ? { type: "code" }
              : tag === "a"
                ? { type: "link", attrs: { href: element.getAttribute("href") ?? "" } }
                : null;

    return readInlineHtml(element.childNodes, h, mark ? [...marks, mark] : marks);
  });
}

function parseCellBlocks(cell: HTMLTableCellElement, h: MarkdownParseHelpers): JSONContent[] {
  const blocks: JSONContent[] = [];

  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "p") {
      blocks.push(h.createNode("paragraph", {}, readInlineHtml(element.childNodes, h)));
    } else if (tag === "pre") {
      const code = element.querySelector("code");
      const language = code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? null;
      blocks.push(
        h.createNode(
          "codeBlock",
          { language },
          code?.textContent ? [h.createTextNode(code.textContent)] : [],
        ),
      );
    } else if (tag === "ul" || tag === "ol") {
      const itemType = "listItem";
      const items = Array.from(element.children)
        .filter((item) => item.tagName.toLowerCase() === "li")
        .map((item) => h.createNode(itemType, {}, parseCellBlocks(item as HTMLTableCellElement, h)));
      blocks.push(
        h.createNode(tag === "ul" ? "bulletList" : "orderedList", {}, items),
      );
    } else {
      blocks.push(h.createNode("paragraph", {}, readInlineHtml(element.childNodes, h)));
    }
  }

  return blocks.length > 0 ? blocks : [h.createNode("paragraph", {}, [])];
}

function parseRichTable(token: MarkdownToken, h: MarkdownParseHelpers): JSONContent[] {
  if (typeof DOMParser === "undefined") return [];

  const document = new DOMParser().parseFromString(token.raw ?? "", "text/html");
  const table = document.querySelector(
    `table[${RICH_TABLE_ATTRIBUTE}]`,
  ) as HTMLTableElement | null;
  if (!table) return [];

  const rows = Array.from(table.rows).map((row) => {
    const cells = Array.from(row.cells).map((cell) =>
      h.createNode(
        cell.tagName.toLowerCase() === "th" ? "tableHeader" : "tableCell",
        {},
        parseCellBlocks(cell, h),
      ),
    );
    return h.createNode("tableRow", {}, cells);
  });

  return rows.length > 0 ? [h.createNode("table", {}, rows)] : [];
}

export const ScratchTable = Table.extend<TableOptions>({
  parseMarkdown: parsePipeTable,
  renderMarkdown: (node, h: MarkdownRendererHelpers) =>
    requiresRichTableStorage(node)
      ? renderRichTableAsHtml(node)
      : renderTableToMarkdown(node, h),
});

export const ScratchRichTableMarkdown = Extension.create({
  name: "scratchRichTableMarkdown",
  markdownTokenName: "html",
  parseMarkdown: parseRichTable,
});
