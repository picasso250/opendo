/* Tiny, dependency-free renderer for chat. Never parses HTML or uses innerHTML. */
(function () {
  "use strict";
  const TOKEN = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s<>"')]+)\)|https?:\/\/[^\s<>"'。，！？；：]+|www\.[^\s<>"'。，！？；：]+|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

  function cleanURL(raw) {
    let text = raw;
    while (/[.,!?;:。，！？；：]$/.test(text)) text = text.slice(0, -1);
    while (text.endsWith(")") && (text.match(/\(/g) || []).length <
        (text.match(/\)/g) || []).length) text = text.slice(0, -1);
    try {
      const value = text.startsWith("www.") ? "https://" + text : text;
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname ||
          url.username || url.password) return null;
      return { href: url.href, label: text };
    } catch { return null; }
  }

  function inline(text, parent) {
    TOKEN.lastIndex = 0;
    let last = 0, match;
    while ((match = TOKEN.exec(text)) !== null) {
      if (match.index > last) parent.appendChild(
        document.createTextNode(text.slice(last, match.index)));
      const raw = match[0];
      if (match[3] !== undefined) {
        const strong = document.createElement("strong");
        strong.textContent = match[3];
        parent.appendChild(strong);
      } else if (match[4] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[4];
        parent.appendChild(code);
      } else {
        const isMarkdownLink = match[1] !== undefined;
        const found = cleanURL(isMarkdownLink ? match[2] : raw);
        if (found) {
          const a = document.createElement("a");
          a.href = found.href;
          a.textContent = isMarkdownLink ? match[1] : found.label;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          a.referrerPolicy = "no-referrer";
          parent.appendChild(a);
          if (!isMarkdownLink && raw.length > found.label.length) {
            parent.appendChild(document.createTextNode(raw.slice(found.label.length)));
          }
        } else {
          parent.appendChild(document.createTextNode(raw));
        }
      }
      last = TOKEN.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(value, container) {
    if (typeof value !== "string" || !container) return;
    const root = document.createDocumentFragment();
    const lines = value.split("\n");
    let codeLines = null, codeLanguage = "";
    function flushCode() {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (/^[a-zA-Z0-9+#_-]{1,24}$/.test(codeLanguage)) {
        code.className = "language-" + codeLanguage;
      }
      code.textContent = codeLines.join("\n");
      pre.appendChild(code); root.appendChild(pre);
      codeLines = null; codeLanguage = "";
    }
    for (let i=0;i<lines.length;i++) {
      const line = lines[i];
      const marker = /^```([^\s`]*)\s*$/.exec(line);
      if (marker) {
        if (codeLines !== null) flushCode();
        else {
          codeLines = [];
          codeLanguage = marker[1].slice(0, 24);
        }
        continue;
      }
      if (codeLines !== null) { codeLines.push(line); continue; }
      inline(line, root);
      if (i < lines.length-1) root.appendChild(document.createElement("br"));
    }
    if (codeLines !== null) flushCode();
    container.replaceChildren(root);
  }
  window.MiniMarkdown = Object.freeze({ render, cleanURL });
})();
