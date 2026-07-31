import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
  suppressErrorRendering: true,
});

const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const sourceSummary = document.getElementById("source-summary");
const sourceList = document.getElementById("source-list");
const sourceForm = document.getElementById("source-form");
const sourceAddBtn = document.getElementById("source-add");
const sourceFeedback = document.getElementById("source-feedback");

let mermaidId = 0;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function looksLikeMermaid(code) {
  const first = code.trim().split("\n")[0].trim();
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|sankey-beta|xychart-beta)\b/i.test(
    first
  );
}

function isMermaidFence(lang, code) {
  const l = (lang || "").toLowerCase().trim();
  return l === "mermaid" || l === "mmd" || (!l && looksLikeMermaid(code));
}

function hasFlowchartSyntax(s) {
  return /\b(graph|flowchart)\b/i.test(s) || /\bsubgraph\b/i.test(s) || /-->/.test(s);
}

function hasSequenceSyntax(s) {
  return (
    /\bsequenceDiagram\b/i.test(s) ||
    /->>|-->>/.test(s) ||
    /\bNote over\b/i.test(s) ||
    /^\s*\w+\s+as\s+.+/m.test(s)
  );
}

/** Insert newlines when the LLM flattens Mermaid onto one line. */
function reflowMermaid(code) {
  let s = code.trim();

  // Always split structural keywords (even if some newlines already exist)
  s = s
    .replace(/\s+(subgraph)\s+/gi, "\n$1 ")
    .replace(/\s+end\b/g, "\nend\n")
    .replace(/\s+(%%[^\n]*)/g, "\n$1")
    .replace(/\s+(sequenceDiagram|flowchart|graph)\b/gi, "\n$1")
    .replace(/\s+(Note over)\s+/gi, "\n$1 ")
    .replace(/\s+(note\s+(?:left|right)\s+of)\s+/gi, "\n$1 ")
    // Separate consecutive node definitions: A["L"] B["L"]
    .replace(/(\)|\]|")\s+(?=[A-Za-z][\w]*\s*[\(\["])/g, "$1\n")
    // Node def then same-line edge: mc["L"] mc -->|...
    .replace(
      /(\)|\]|")\s+(?=[A-Za-z][\w]*\s*(?:-\.->|-->|---|-->>|->>))/g,
      "$1\n"
    );

  const nl = (s.match(/\n/g) || []).length;
  // Already well structured — skip aggressive edge splitting
  if (nl >= 12) return s.trim();

  s = s
    // Edges / messages (also split multiple messages on one line)
    .replace(/\s+([A-Za-z][\w]*)(-->>)/g, "\n$1$2")
    .replace(/\s+([A-Za-z][\w]*)(->>)/g, "\n$1$2")
    .replace(/\s+([A-Za-z][\w]*)\s+--\s+/g, "\n$1 -- ")
    // Split "TARGET SOURCE-->" flattened edges (no space before -->)
    .replace(/\s+([A-Za-z][\w./-]*)(-\.->)/g, "\n$1$2")
    .replace(/\s+([A-Za-z][\w./-]*)(---)/g, "\n$1$2")
    .replace(/\s+([A-Za-z][\w./-]*)(-->)/g, "\n$1$2")
    .replace(/\s+([A-Za-z][\w./-]*)\s+-->/g, "\n$1 -->")
    // Participant aliases: "Foo as Bar"
    .replace(/\s+([A-Za-z][\w]*)\s+as\s+/g, "\n$1 as ")
    // End an alias before the next alias or message
    .replace(/(\sas\s+.+?)\s+(?=[A-Za-z][\w]*\s+as\s+)/g, "$1\n")
    .replace(/(\sas\s+.+?)\s+(?=[A-Za-z][\w]*(?:->>|-->>))/g, "$1\n");
  return s.trim();
}

/**
 * Quote multi-word subgraph titles and move body onto the next line.
 * subgraph Service Clusters SC[...] → subgraph "Service Clusters"\nSC[...]
 * Also handles already-quoted titles that still share a line with body.
 */
function quoteSubgraphTitles(code) {
  return code
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*subgraph\s+)(.+)$/i);
      if (!m) return line;
      let rest = m[2].trim();

      // Already has id + title: subgraph sc["Service Cluster"] BODY
      const idTitle = rest.match(
        /^([A-Za-z][\w]*)\s*(\["[^"]*"\]|\[[^\]]+\])\s*(.*)$/
      );
      if (idTitle) {
        const after = idTitle[3].trim();
        const header = `${m[1]}${idTitle[1]}${idTitle[2]}`;
        return after ? `${header}\n${after}` : header;
      }

      // HTML-ish: subgraph "Title" id="sc" BODY → subgraph sc["Title"]
      const htmlId = rest.match(
        /^("[^"]+"|\[[^\]]+\])\s+id\s*=\s*["']([^"']+)["']\s*(.*)$/i
      );
      if (htmlId) {
        const title = htmlId[1].replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
        const id = slugNodeId(htmlId[2]);
        const after = htmlId[3].trim();
        const header = `${m[1]}${id}["${title}"]`;
        return after ? `${header}\n${after}` : header;
      }

      // Already quoted / bracket title: subgraph "Title" BODY
      const quoted = rest.match(/^("[^"]+"|\[[^\]]+\])\s*(.*)$/);
      if (quoted) {
        const after = quoted[2].trim();
        // BODY may start with id="sc"
        const withId = after.match(/^id\s*=\s*["']([^"']+)["']\s*(.*)$/i);
        if (withId) {
          const title = quoted[1].replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
          const id = slugNodeId(withId[1]);
          const body = withId[2].trim();
          const header = `${m[1]}${id}["${title}"]`;
          return body ? `${header}\n${body}` : header;
        }
        return after ? `${m[1]}${quoted[1]}\n${after}` : line;
      }

      // Title ends when a node def (ID[) or edge start (ID -->) begins
      let title = rest;
      let after = "";
      const bodyStart = rest.search(
        /\s+[A-Za-z][\w./-]*\s*(?:[\[\(\{]|-->|--[^-]|->>|-->>)/
      );
      if (bodyStart > 0) {
        title = rest.slice(0, bodyStart).trim();
        after = rest.slice(bodyStart).trim();
      }

      // Simple single-token id is fine unquoted
      if (/^[\w-]+$/.test(title)) {
        return after ? `${m[1]}${title}\n${after}` : line;
      }
      const safe = title.replace(/"/g, "'");
      return after ? `${m[1]}"${safe}"\n${after}` : `${m[1]}"${safe}"`;
    })
    .join("\n");
}

/** Convert subgraph "Title" id="sc" (HTML-ish) → subgraph sc["Title"]. */
function fixSplitSubgraphHtmlIds(code) {
  return code
    .replace(
      /subgraph\s+("[^"]+"|\[[^\]]+\])\s+id\s*=\s*["']([^"']+)["']/gi,
      (_, titleTok, id) => {
        const title = titleTok.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
        return `subgraph ${slugNodeId(id)}["${title}"]`;
      }
    )
    .replace(
      /subgraph\s+("[^"]+"|\[[^\]]+\])\s*\n\s*id\s*=\s*["']([^"']+)["']/gi,
      (_, titleTok, id) => {
        const title = titleTok.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
        return `subgraph ${slugNodeId(id)}["${title}"]`;
      }
    )
    .replace(/^\s*id\s*=\s*["'][^"']+["']\s*$/gim, "");
}

/** Mermaid node ids must be alphanumeric/_/- — slugify anything else. */
function slugNodeId(raw) {
  let id = String(raw)
    .trim()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "node";
  if (/^\d/.test(id)) id = `n_${id}`;
  if (id.toLowerCase() === "end") id = "endNode";
  return id;
}

/**
 * Fix node ids with /, spaces, etc. AWS/GCP/Azure["…"] → AWS_GCP_Azure["…"]
 * Rewrites bare references outside of quoted labels only.
 */
function sanitizeNodeIds(code) {
  const renames = new Map();
  let s = code.replace(
    /([A-Za-z][\w./-]*)(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g,
    (full, id, shape) => {
      if (/^[A-Za-z][\w]*$/.test(id)) return full;
      const next = slugNodeId(id);
      if (next !== id) renames.set(id, next);
      return next + shape;
    }
  );
  const keys = [...renames.keys()].sort((a, b) => b.length - a.length);
  for (const old of keys) {
    const next = renames.get(old);
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only touch non-string regions (split on "..." and '...')
    s = s
      .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
      .map((part, i) => {
        if (i % 2 === 1) return part; // quoted label — leave alone
        const re = new RegExp(
          `(?<![\\w./-])${esc}(?![\\w./-])`,
          "g"
        );
        return part.replace(re, next);
      })
      .join("");
  }
  return s;
}

/** Quote node labels that contain spaces or special chars: A[Foo (bar)] → A["Foo (bar)"] */
function quoteNodeLabels(code) {
  return code.replace(/(\b[A-Za-z][\w]*)\[([^\[\]]*)\]/g, (full, id, label) => {
    const trimmed = label.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return full;
    }
    if (/[\s()[\]{},:;|/]/.test(trimmed) || /[^\w-]/.test(trimmed)) {
      return `${id}["${trimmed.replace(/"/g, "'")}"]`;
    }
    return full;
  });
}

/**
 * LLM often emits -->|label|> (extra >) or ->> inside flowcharts.
 * Also slugify multi-word edge endpoints: --> External Cloud Providers
 */
function fixFlowchartEdges(code) {
  let s = code;
  // Normalize edge labels: |label|> and garbage |<|> / |->|
  s = s.replace(
    /(-\.->|-->|---|==>)\|([^|\n]*)\|(>)?/g,
    (_, arrow, label) => {
      const t = String(label).trim();
      if (!t || /^[<>\-]+$/.test(t)) return `${arrow} `;
      return `${arrow}|${t}| `;
    }
  );
  // Broken -->|-> or -->|< without a proper closing pipe
  s = s.replace(/(-\.->|-->|---|==>)\|-+>\s*/g, "$1 ");
  s = s.replace(/(-\.->|-->|---|==>)\|<\s*/g, "$1 ");
  // Dangling pipe before a target: -->| Target or -->| -> Target
  s = s.replace(/(-\.->|-->|---|==>)\|\s*-*>\s*/g, "$1 ");
  s = s.replace(/(-\.->|-->|---|==>)\|\s+(?=[A-Za-z])/g, "$1 ");
  // Broken bracket-arrow: ID [.->|label| Target...] → ID -.->|label| Target
  s = s.replace(
    /\b([A-Za-z][\w]*)\s*\[\s*(-\.->|-->|---|==>|\.?->+)\s*(?:\|([^|\n]*)\|)?\s*/g,
    (_, id, arrow, label) => {
      let a = arrow;
      if (a === ".->" || a === "->") a = "-.->";
      else if (a === "-->") a = "-->";
      else if (a === "---") a = "---";
      return label != null && label !== ""
        ? `${id} ${a}|${label}| `
        : `${id} ${a} `;
    }
  );
  // Extra ] after a node shape: Hypershift["X"]] → Hypershift["X"]
  s = s.replace(/(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\]+/g, "$1");
  // Sequence arrows in a flowchart context
  if (/\bflowchart\b|\bgraph\b/i.test(s) && !/\bsequenceDiagram\b/i.test(s)) {
    s = s.replace(/-->>/g, "-->").replace(/->>/g, "-->");
  }
  // Multi-word bare targets — stop before next edge or Mermaid keywords.
  s = s.replace(
    /(-\.->\|[^|\n]*\||-->\|[^|\n]*\||---\|[^|\n]*\||-->|---|-\.->|--)\s+([A-Za-z][\w./-]*(?:\s+[A-Za-z][\w./-]*)+?)(?=\s*(?:-\.->|-->|---|-->>|->>|end\b|subgraph\b|flowchart\b|graph\b|note\b|$|\n))/gi,
    (match, arrow, target) => {
      const words = target.trim().split(/\s+/);
      // Pure Title Case words → phrase slug (External Cloud Providers)
      if (words.every((w) => /^[A-Z][a-z]+$/.test(w))) {
        return `${arrow} ${slugNodeId(target)}`;
      }
      // Adjacent node ids (PascalCase / underscored) — keep first, reflow rest
      if (words.length > 1 && words.every((w) => /^[A-Za-z][\w]*$/.test(w))) {
        const rest = words.slice(1).join(" ");
        return rest
          ? `${arrow} ${words[0]}\n${rest}`
          : `${arrow} ${words[0]}`;
      }
      if (!/[a-z]/.test(target)) return match;
      return `${arrow} ${slugNodeId(target)}`;
    }
  );
  // Bare [Label] used as a node (no id): [Provisions] --> X
  let anon = 0;
  s = s.replace(
    /(^|\s)\[([^\]\n]+)\](?=\s*(?:-->|-->>|->>|--\||-\.->|---))/gm,
    (_, sp, label) => {
      anon += 1;
      return `${sp}n${anon}["${label.replace(/"/g, "'")}"]`;
    }
  );
  return s;
}

/**
 * Edges cannot target the subgraph keyword. Rewrite:
 *   A -->|host| subgraph "Title" … end
 * into:
 *   subgraph title_id["Title"] … end
 *   A -->|host| title_id
 */
function fixEdgesIntoSubgraphs(code) {
  const deferred = [];
  const rewrite = (_, src, arrow, titleTok) => {
    const titleText = String(titleTok)
      .replace(/^\[|\]$/g, "")
      .replace(/^"|"$/g, "");
    let id = slugNodeId(titleText);
    if (id.toLowerCase() === "end") id = "endNode";
    deferred.push(`${src} ${arrow} ${id}`);
    return `subgraph ${id}["${titleText}"]`;
  };

  let s = code.replace(
    /([A-Za-z][\w]*)\s*((?:-\.->|-->|---|==>)(?:\|[^|\n]*\|)?)\s*subgraph\s+("[^"]+"|\[[^\]]+\])/gi,
    rewrite
  );
  // Same pattern when reflow already put subgraph on the next line
  s = s.replace(
    /([A-Za-z][\w]*)\s*((?:-\.->|-->|---|==>)(?:\|[^|\n]*\|)?)\s*\n\s*subgraph\s+("[^"]+"|\[[^\]]+\])/gi,
    (...args) => `${rewrite(...args)}`
  );
  // Drop accidental double "end end"
  s = s.replace(/\bend\s+end\b/gi, "end");
  if (deferred.length) {
    s = `${s.trim()}\n${deferred.join("\n")}`;
  }
  return s;
}

/**
 * Flowcharts don't support sequence-style notes. Convert to a dashed annotation node.
 * note right of MC: "text" or note right of MC text end → MC_note["text"] + MC -.-> MC_note
 */
function convertFlowchartNotes(code) {
  if (/\bsequenceDiagram\b/i.test(code)) return code;

  let s = code;
  // Drop a lone "end" that closes a note (LLM habit)
  s = s.replace(
    /(^\s*note\s+(?:left|right)\s+of\s+[A-Za-z][\w]*\b.*\S)\s*\n\s*end\b/gim,
    "$1"
  );

  let n = 0;
  s = s.replace(
    /^\s*note\s+(left|right)\s+of\s+([A-Za-z][\w]*)\s*:?\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*(?:\bend\b)?\s*$/gim,
    (_, side, id, q1, q2, bare) => {
      n += 1;
      const text = String(q1 ?? q2 ?? bare ?? "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\s*\bend\b\s*$/i, "")
        .trim();
      if (!text) return "";
      const nid = `${id}_note${n}`;
      const safe = text.replace(/"/g, "'");
      const link =
        side.toLowerCase() === "left" ? `${nid} -.-> ${id}` : `${id} -.-> ${nid}`;
      return `${nid}["${safe}"]\n${link}`;
    }
  );
  return s;
}

/**
 * Mermaid ids are case-sensitive. Rewrite references that only differ by case
 * to match an existing definition: advanced_cluster_management → Advanced_Cluster_Management
 */
function normalizeNodeIdCase(code) {
  const canonical = new Map(); // lower → preferred casing
  const remember = (id) => {
    const key = id.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, id);
  };
  for (const m of code.matchAll(/\b([A-Za-z][\w]*)\s*[\[\(\{]/g)) {
    remember(m[1]);
  }
  for (const m of code.matchAll(/\bsubgraph\s+([A-Za-z][\w]*)\b/gi)) {
    remember(m[1]);
  }

  return code
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // quoted labels
      return part.replace(/\b([A-Za-z][\w]*)\b/g, (id) => {
        if (
          /^(subgraph|end|flowchart|graph|sequenceDiagram|style|classDef|click|direction|note|left|right|of)$/i.test(
            id
          )
        ) {
          return id;
        }
        const pref = canonical.get(id.toLowerCase());
        return pref && pref !== id ? pref : id;
      });
    })
    .join("");
}

/** If an edge references an id with no node def, add a simple labeled node. */
function ensureEdgeEndpointNodes(code) {
  const keywords = new Set([
    "subgraph",
    "end",
    "flowchart",
    "graph",
    "sequenceDiagram",
    "style",
    "classDef",
    "click",
    "direction",
  ]);
  const defined = new Set();
  for (const m of code.matchAll(/\b([A-Za-z][\w]*)\s*[\[\(\{]/g)) {
    defined.add(m[1]);
  }
  // Subgraph ids: subgraph foo ["Title"] or subgraph foo["Title"]
  for (const m of code.matchAll(/\bsubgraph\s+([A-Za-z][\w]*)\b/gi)) {
    defined.add(m[1]);
  }

  const used = new Set();
  for (const m of code.matchAll(
    /(?:-\.->\|[^|\n]*\||-->\|[^|\n]*\||---\|[^|\n]*\||-\.->|-->|---|--)\s+([A-Za-z][\w]*)/g
  )) {
    if (!keywords.has(m[1])) used.add(m[1]);
  }
  for (const m of code.matchAll(
    /^\s*([A-Za-z][\w]*)\s*(?:-\.->\|[^|\n]*\||-->\|[^|\n]*\||---\|[^|\n]*\||-\.->|-->|---|--)/gm
  )) {
    if (!keywords.has(m[1])) used.add(m[1]);
  }

  const extras = [];
  for (const id of used) {
    if (defined.has(id) || keywords.has(id)) continue;
    // Rebuild a readable label from slug
    const label = id.replace(/_/g, " ");
    extras.push(`${id}["${label}"]`);
    defined.add(id);
  }
  if (!extras.length) return code;
  return `${code.trim()}\n${extras.join("\n")}`;
}

/** Split mixed flowchart + sequenceDiagram blobs into separate diagrams. */
function splitMixedMermaid(code) {
  const s = reflowMermaid(code);
  if (!(hasFlowchartSyntax(s) && hasSequenceSyntax(s))) {
    return [s];
  }

  const lines = s.split("\n");
  const flow = [];
  const seq = [];
  let mode = "flow"; // start assuming flowchart until sequence cues appear

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^sequenceDiagram\b/i.test(t)) {
      mode = "seq";
      seq.push(t);
      continue;
    }
    if (/^graph\b|^flowchart\b/i.test(t)) {
      mode = "flow";
      flow.push(t.replace(/^graph\b/i, "flowchart"));
      continue;
    }
    // Sequence cues
    if (/->>|-->>/.test(t) || /^Note over\b/i.test(t)) {
      mode = "seq";
      seq.push(t);
      continue;
    }
    // "X as Label" aliases belong to sequence (not flowchart node defs)
    if (/^[A-Za-z][\w]*\s+as\s+/.test(t) && !/[[({]/.test(t)) {
      mode = "seq";
      seq.push(t.startsWith("participant ") ? t : `participant ${t}`);
      continue;
    }
    if (mode === "seq") seq.push(t);
    else flow.push(t);
  }

  const out = [];
  if (flow.length) {
    let f = flow.join("\n").trim();
    if (!/^(flowchart|graph)\b/i.test(f)) f = `flowchart TD\n${f}`;
    else f = f.replace(/^graph\b/i, "flowchart");
    out.push(f);
  }
  if (seq.length) {
    let q = seq.join("\n").trim();
    if (!/^sequenceDiagram\b/i.test(q)) q = `sequenceDiagram\n${q}`;
    out.push(q);
  }
  return out.length ? out : [s];
}

/** Fix common LLM mistakes that break Mermaid parsers. */
function sanitizeMermaid(code) {
  let s = String(code).trim();
  s = s.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/^```(?:mermaid|mmd)?\s*/i, "").replace(/```\s*$/i, "").trim();
  s = s
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/[\u2013\u2014]/g, "-").replace(/\u2192/g, "-->");
  s = s.replace(/—>/g, "-->").replace(/–>/g, "-->");
  // <br/> in labels often breaks parsers — use a space
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/\*\*/g, "").replace(/__/g, "");
  // Fix broken arrows / edge-into-subgraph / html-ish subgraph ids while still flat
  s = fixSplitSubgraphHtmlIds(s);
  s = fixFlowchartEdges(s);
  s = fixEdgesIntoSubgraphs(s);
  s = reflowMermaid(s);
  s = quoteSubgraphTitles(s);
  s = fixSplitSubgraphHtmlIds(s);
  // Second pass after reflow (subgraph may have moved to next line)
  s = fixFlowchartEdges(s);
  s = fixEdgesIntoSubgraphs(s);
  s = convertFlowchartNotes(s);
  s = sanitizeNodeIds(s);
  s = quoteNodeLabels(s);
  s = normalizeNodeIdCase(s);
  s = ensureEdgeEndpointNodes(s);
  // Collapse leftover double ends
  s = s.replace(/\bend\s*\n\s*end\b/gi, "end");
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1].trim() !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!looksLikeMermaid(s) && !hasSequenceSyntax(s)) {
    s = `flowchart TD\n${s}`;
  }
  s = s.replace(/^graph\b/i, "flowchart");
  return s.trim();
}

function mermaidFallback(rawCode) {
  const wrap = document.createElement("div");
  wrap.className = "mermaid-fallback";
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = "Diagram could not be rendered (invalid Mermaid). Showing source:";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "hljs language-mermaid";
  code.textContent = rawCode;
  pre.appendChild(code);
  wrap.append(note, pre);
  try {
    hljs.highlightElement(code);
  } catch (_) {
    /* ignore */
  }
  return wrap;
}

async function tryRenderOne(code) {
  const id = `mermaid-${++mermaidId}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch (err) {
    console.warn("Mermaid parse failed:", err.message || err);
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    return null;
  }
}

/** Build candidate diagram strings from raw LLM output. */
function mermaidCandidates(raw) {
  const cleaned = sanitizeMermaid(raw);
  const parts = splitMixedMermaid(cleaned);
  const candidates = [];
  // Prefer split parts individually
  for (const p of parts) candidates.push(p);
  // Also try the whole cleaned block, and flowchart-only (drop sequence lines)
  if (parts.length > 1) candidates.push(cleaned);
  const flowOnly = parts.find((p) => /^flowchart\b/i.test(p.trim()));
  if (flowOnly) candidates.push(flowOnly);
  // Dedupe
  return [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
}

/** Parse assistant markdown into a fragment with code + mermaid nodes. */
function formatAnswer(text) {
  const fragment = document.createDocumentFragment();
  const parts = String(text).split(/(```[\s\S]*?```)/g);

  parts.forEach((part) => {
    const fence = part.match(/^```\s*([\w+-]*)[^\n]*\n?([\s\S]*?)```$/);
    if (fence) {
      const lang = fence[1] || "";
      const code = fence[2].replace(/\n$/, "");
      if (isMermaidFence(lang, code) || looksLikeMermaid(code)) {
        const diagram = document.createElement("div");
        diagram.className = "mermaid";
        diagram.textContent = code;
        fragment.appendChild(diagram);
      } else {
        const pre = document.createElement("pre");
        const el = document.createElement("code");
        if (lang) el.className = `hljs language-${lang}`;
        else el.className = "hljs";
        el.textContent = code;
        pre.appendChild(el);
        fragment.appendChild(pre);
      }
      return;
    }

    if (!part) return;
    const span = document.createElement("span");
    let html = escapeHtml(part);
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    span.innerHTML = html;
    fragment.appendChild(span);
  });

  return fragment;
}

async function renderMermaid(root) {
  const nodes = [...root.querySelectorAll(".mermaid:not(.mermaid-rendered)")].filter(
    (n) => !n.querySelector("svg")
  );
  for (const node of nodes) {
    const raw = node.textContent || "";
    const splitParts = splitMixedMermaid(sanitizeMermaid(raw));
    const svgs = [];

    // Render each split part (flowchart + sequence) when mixed
    for (const part of splitParts) {
      const svg = await tryRenderOne(part);
      if (svg) svgs.push(svg);
    }

    // If splitting failed entirely, try other candidate variants
    if (!svgs.length) {
      for (const code of mermaidCandidates(raw)) {
        const svg = await tryRenderOne(code);
        if (svg) {
          svgs.push(svg);
          break;
        }
      }
    }

    if (svgs.length) {
      const wrap = document.createElement("div");
      wrap.className = "mermaid mermaid-rendered";
      wrap.innerHTML = svgs.join("");
      node.replaceWith(wrap);
    } else {
      node.replaceWith(mermaidFallback(raw));
    }
  }
}

function appendMessage(role, text, sources) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "AI-assisted answer";
  div.appendChild(label);

  const body = document.createElement("div");
  body.className = "body";
  if (role === "assistant" && text) {
    body.appendChild(formatAnswer(text));
    body.querySelectorAll("pre code").forEach((block) => hljs.highlightElement(block));
    renderMermaid(body);
  } else {
    body.textContent = text;
  }
  div.appendChild(body);

  if (sources && sources.length) {
    const src = document.createElement("div");
    src.className = "cite-sources";
    src.innerHTML = "<strong>Sources</strong>";
    const ul = document.createElement("ul");
    sources.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      ul.appendChild(li);
    });
    src.appendChild(ul);
    div.appendChild(src);
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function renderSources(sources) {
  sourceList.innerHTML = "";
  if (!sources.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sources yet — add a directory below.";
    sourceList.appendChild(li);
    sourceSummary.textContent = "0 sources";
    return;
  }

  const totalDocs = sources.reduce((n, s) => n + (s.doc_count || 0), 0);
  sourceSummary.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"} · ${totalDocs} docs`;

  sources.forEach((s) => {
    const li = document.createElement("li");
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = s.kind;
    const loc = document.createElement("span");
    loc.className = "loc";
    loc.title = s.location;
    loc.textContent = s.location;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${s.doc_count} docs`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeSource(s.id));
    li.append(kind, loc, count, remove);
    sourceList.appendChild(li);
  });
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    renderSources(data.sources || []);
    if (data.ready) {
      statusDot.classList.remove("err", "busy");
      statusText.textContent = "Ready";
      if (!messagesEl.dataset.greeted) {
        appendMessage(
          "assistant",
          "Sources are loaded. Ask a question, or add more directories above."
        );
        messagesEl.dataset.greeted = "1";
      }
    } else {
      statusDot.classList.add("err");
      statusText.textContent = "Add a source to begin";
    }
  } catch (e) {
    statusDot.classList.add("err");
    statusText.textContent = "Offline";
  }
}

async function removeSource(id) {
  sourceFeedback.textContent = "Removing…";
  sourceFeedback.className = "";
  statusDot.classList.add("busy");
  statusText.textContent = "Rebuilding index…";
  try {
    const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Remove failed");
    renderSources(data.sources || []);
    sourceFeedback.textContent = "Source removed.";
    sourceFeedback.className = "ok";
    statusDot.classList.remove("busy", "err");
    statusText.textContent = (data.sources || []).length ? "Ready" : "Add a source to begin";
  } catch (err) {
    sourceFeedback.textContent = err.message;
    sourceFeedback.className = "err";
    statusDot.classList.remove("busy");
    statusDot.classList.add("err");
    statusText.textContent = "Error";
  }
}

sourceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const location = document.getElementById("source-location").value.trim();
  if (!location) return;

  sourceAddBtn.disabled = true;
  sourceFeedback.textContent = "Indexing… this may take a moment.";
  sourceFeedback.className = "";
  statusDot.classList.add("busy");
  statusText.textContent = "Indexing source…";

  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Add failed");

    renderSources(data.sources || []);
    sourceForm.reset();
    sourceFeedback.textContent = `Added ${data.source.doc_count} docs.`;
    sourceFeedback.className = "ok";
    statusDot.classList.remove("busy", "err");
    statusText.textContent = "Ready";
    if (!messagesEl.dataset.greeted) {
      appendMessage("assistant", "Source added. Ask a question about your SOPs.");
      messagesEl.dataset.greeted = "1";
    }
  } catch (err) {
    sourceFeedback.textContent = err.message;
    sourceFeedback.className = "err";
    statusDot.classList.remove("busy");
    statusDot.classList.add("err");
    statusText.textContent = "Error";
  } finally {
    sourceAddBtn.disabled = false;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = promptEl.value.trim();
  if (!message) return;

  appendMessage("user", message);
  promptEl.value = "";
  sendBtn.disabled = true;
  promptEl.disabled = true;
  statusDot.classList.add("busy");
  statusText.textContent = "Thinking…";

  const thinking = appendMessage("assistant", "");
  thinking.querySelector(".body").innerHTML =
    '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>';

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    thinking.remove();

    if (!res.ok) {
      appendMessage("error", data.error || "Request failed");
    } else {
      appendMessage("assistant", data.answer || "(empty response)", data.sources || []);
    }
    statusText.textContent = "Ready";
    statusDot.classList.remove("busy");
  } catch (err) {
    thinking.remove();
    appendMessage("error", err.message || "Network error");
    statusDot.classList.add("err");
    statusText.textContent = "Error";
  } finally {
    sendBtn.disabled = false;
    promptEl.disabled = false;
    promptEl.focus();
  }
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

loadStatus();
promptEl.focus();
