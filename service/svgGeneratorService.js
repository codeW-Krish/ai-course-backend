// ============================================================
//  SVG Generator Service
//  Converts structured JSON from LLM into animatable SVG
//  Supports: diagrams, timelines, code blocks, comparisons, quotes
// ============================================================

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const PADDING = 80;

// ─────────────────────────────────────────
//  Color palette (consistent visual identity)
// ─────────────────────────────────────────
const PALETTE = {
  bg: "#0a0a0f",
  bgGradientStart: "#0a0a1a",
  bgGradientEnd: "#0f0f2a",
  primary: "#4F86F7",
  secondary: "#FFB400",
  accent: "#28A745",
  danger: "#E74C3C",
  text: "#FFFFFF",
  textMuted: "#A0A0B0",
  textDim: "#6B6B80",
  line: "#3A3A5A",
  nodeStroke: "#5A5A7A",
  codeBg: "#1a1a2e",
  codeText: "#E0E0F0",
  codeKeyword: "#C792EA",
  codeString: "#C3E88D",
  codeComment: "#546E7A",
  codeNumber: "#F78C6C",
};

const FONT_FAMILY = "Inter, 'Noto Sans', Arial, Helvetica, sans-serif";
const FONT_FAMILY_MONO = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";
const FONT_FAMILY_SERIF = "'Noto Serif', Georgia, 'Times New Roman', serif";

// ─────────────────────────────────────────
//  Shared SVG helpers
// ─────────────────────────────────────────

function svgHeader(width = CANVAS_W, height = CANVAS_H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <style>
      /* Declare font families so resvg/librsvg can match them */
      text, tspan { font-family: Inter, 'Noto Sans', Arial, Helvetica, sans-serif; }
    </style>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${PALETTE.bgGradientStart}"/>
      <stop offset="100%" style="stop-color:${PALETTE.bgGradientEnd}"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="shadow">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>`;
}

function svgFooter() {
  return `</svg>`;
}

function escapeXml(str) {
  return String(str)
    // Strip zero-width / invisible Unicode chars that LLMs sometimes emit
    .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text, maxChars = 25, maxLines = 0) {
  // Clean invisible characters before wrapping
  const clean = String(text).replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, "").trim();
  const words = clean.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current);
  // Clamp to max lines if specified (truncate with ellipsis)
  if (maxLines > 0 && lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    truncated[maxLines - 1] = truncated[maxLines - 1].slice(0, -1) + "\u2026";
    return truncated;
  }
  return lines;
}

// ─────────────────────────────────────────
//  1. DIAGRAM GENERATOR
//  flowchart, tree, layered, circular
// ─────────────────────────────────────────

export function generateDiagramSVG(scenePlan) {
  const nodes = scenePlan.diagram_nodes || [];
  const connections = scenePlan.diagram_connections || [];
  const layout = scenePlan.diagram_layout || "flowchart";

  if (nodes.length === 0) {
    return generateQuoteSVG({ quote_text: scenePlan.text || "Diagram", quote_attribution: "" });
  }

  // Calculate node positions based on layout
  const positions = calculateLayout(nodes, layout);

  let elements = svgHeader();

  // Draw connections first (behind nodes)
  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];
    const fromPos = positions[conn.from];
    const toPos = positions[conn.to];
    if (!fromPos || !toPos) continue;

    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / dist;
    const ny = dy / dist;
    const nodeRadius = 60;
    const x1 = fromPos.x + nx * nodeRadius;
    const y1 = fromPos.y + ny * nodeRadius;
    const x2 = toPos.x - nx * nodeRadius;
    const y2 = toPos.y - ny * nodeRadius;

    // Animated line with CSS animation classes
    elements += `
    <g class="connection" data-index="${i}" data-from="${conn.from}" data-to="${conn.to}">
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="${PALETTE.line}" stroke-width="2.5" stroke-linecap="round"
        stroke-dasharray="1000" stroke-dashoffset="1000">
        <animate attributeName="stroke-dashoffset" from="1000" to="0"
          dur="0.8s" begin="${0.3 + i * 0.2}s" fill="freeze"/>
      </line>
      <!-- Arrow head -->
      <polygon points="${x2},${y2} ${x2 - 10 * nx + 6 * ny},${y2 - 10 * ny - 6 * nx} ${x2 - 10 * nx - 6 * ny},${y2 - 10 * ny + 6 * nx}"
        fill="${PALETTE.line}" opacity="0">
        <animate attributeName="opacity" from="0" to="1"
          dur="0.3s" begin="${0.8 + i * 0.2}s" fill="freeze"/>
      </polygon>`;

    // Connection label
    if (conn.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 12;
      elements += `
      <text x="${mx}" y="${my}" text-anchor="middle"
        font-family="${FONT_FAMILY}" font-size="14" fill="${PALETTE.textMuted}" opacity="0">
        ${escapeXml(conn.label)}
        <animate attributeName="opacity" from="0" to="1"
          dur="0.4s" begin="${1 + i * 0.2}s" fill="freeze"/>
      </text>`;
    }

    elements += `</g>`;
  }

  // Draw nodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const pos = positions[node.id];
    if (!pos) continue;

    const color = node.color || PALETTE.primary;
    const shape = node.shape || "rounded_rect";
    const animDelay = i * 0.15;

    elements += `
    <g class="node" data-id="${node.id}" data-index="${i}" transform="translate(${pos.x}, ${pos.y})" opacity="0">
      <animateTransform attributeName="transform" type="translate"
        from="${pos.x} ${pos.y + 20}" to="${pos.x} ${pos.y}"
        dur="0.5s" begin="${animDelay}s" fill="freeze"/>
      <animate attributeName="opacity" from="0" to="1"
        dur="0.4s" begin="${animDelay}s" fill="freeze"/>`;

    // Shape
    if (shape === "circle") {
      elements += `
      <circle cx="0" cy="0" r="50" fill="${color}20" stroke="${color}" stroke-width="2.5" filter="url(#shadow)"/>`;
    } else if (shape === "diamond") {
      elements += `
      <polygon points="0,-55 65,0 0,55 -65,0" fill="${color}20" stroke="${color}" stroke-width="2.5" filter="url(#shadow)"/>`;
    } else {
      // rounded_rect or rect
      const rx = shape === "rect" ? 4 : 12;
      elements += `
      <rect x="-70" y="-35" width="140" height="70" rx="${rx}" 
        fill="${color}20" stroke="${color}" stroke-width="2.5" filter="url(#shadow)"/>`;
    }

    // Label
    const labelLines = wrapText(node.label, 18, 3);
    const labelY = -(labelLines.length - 1) * 10;
    for (let l = 0; l < labelLines.length; l++) {
      elements += `
      <text x="0" y="${labelY + l * 20}" text-anchor="middle" dominant-baseline="middle"
        font-family="${FONT_FAMILY}" font-size="15" font-weight="600" fill="${PALETTE.text}">
        ${escapeXml(labelLines[l])}
      </text>`;
    }

    elements += `</g>`;
  }

  elements += svgFooter();
  return elements;
}

function calculateLayout(nodes, layout) {
  const positions = {};
  const count = nodes.length;
  const usableW = CANVAS_W - PADDING * 2;
  const usableH = CANVAS_H - PADDING * 2;
  const centerX = CANVAS_W / 2;
  const centerY = CANVAS_H / 2;

  if (layout === "circular") {
    const radius = Math.min(usableW, usableH) * 0.35;
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count - Math.PI / 2;
      positions[nodes[i].id] = {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      };
    }
  } else if (layout === "tree") {
    // Simple top-down tree
    const levels = Math.ceil(Math.log2(count + 1));
    let idx = 0;
    for (let level = 0; level < levels && idx < count; level++) {
      const nodesInLevel = Math.min(Math.pow(2, level), count - idx);
      const levelY = PADDING + 80 + (usableH - 80) * (level / Math.max(levels - 1, 1));
      const spacing = usableW / (nodesInLevel + 1);
      for (let n = 0; n < nodesInLevel && idx < count; n++) {
        positions[nodes[idx].id] = {
          x: PADDING + spacing * (n + 1),
          y: levelY,
        };
        idx++;
      }
    }
  } else if (layout === "layered") {
    // Horizontal layers (columns)
    const cols = Math.min(count, 4);
    const rows = Math.ceil(count / cols);
    const colSpacing = usableW / (cols + 1);
    const rowSpacing = usableH / (rows + 1);
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions[nodes[i].id] = {
        x: PADDING + colSpacing * (col + 1),
        y: PADDING + 60 + rowSpacing * (row + 1) - rowSpacing / 2,
      };
    }
  } else {
    // Default: flowchart (left-to-right or top-to-bottom)
    if (count <= 5) {
      // Horizontal flow
      const spacing = usableW / (count + 1);
      for (let i = 0; i < count; i++) {
        positions[nodes[i].id] = {
          x: PADDING + spacing * (i + 1),
          y: centerY,
        };
      }
    } else {
      // Grid flow
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const colSpacing = usableW / (cols + 1);
      const rowSpacing = usableH / (rows + 1);
      for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions[nodes[i].id] = {
          x: PADDING + colSpacing * (col + 1),
          y: PADDING + 60 + rowSpacing * row + rowSpacing / 2,
        };
      }
    }
  }

  return positions;
}

// ─────────────────────────────────────────
//  2. CODE BLOCK GENERATOR
//  Optimized for portrait phone viewing with larger fonts
// ─────────────────────────────────────────

export function generateCodeSVG(scenePlan) {
  const code = scenePlan.code_content || "// No code provided";
  const language = scenePlan.code_language || "javascript";
  const highlightLines = scenePlan.highlight_lines || [];

  // Larger line height and fonts for readability on phones
  const lines = code.split("\n").slice(0, 15); // Limit to 15 lines max
  const lineHeight = 44;
  const codeFontSize = 30;
  const lineNumFontSize = 22;
  const titleBarHeight = 70;
  const sidePadding = 50; // Reduced to maximize code area
  const lineNumWidth = 70;
  
  const startY = PADDING + titleBarHeight + 35;
  const startX = sidePadding + lineNumWidth + 25;
  const codeAreaH = lines.length * lineHeight + 50;

  let elements = svgHeader();

  // Code container with title bar
  elements += `
  <rect x="${sidePadding}" y="${PADDING}" width="${CANVAS_W - sidePadding * 2}" height="${titleBarHeight + codeAreaH}"
    rx="20" fill="${PALETTE.codeBg}" stroke="${PALETTE.nodeStroke}" stroke-width="2" filter="url(#shadow)"/>
  
  <!-- Title bar background -->
  <rect x="${sidePadding}" y="${PADDING}" width="${CANVAS_W - sidePadding * 2}" height="${titleBarHeight}"
    rx="20" fill="${PALETTE.nodeStroke}40"/>
  
  <!-- Window dots (bigger for visibility) -->
  <circle cx="${sidePadding + 28}" cy="${PADDING + titleBarHeight / 2}" r="9" fill="#FF5F56"/>
  <circle cx="${sidePadding + 58}" cy="${PADDING + titleBarHeight / 2}" r="9" fill="#FFBD2E"/>
  <circle cx="${sidePadding + 88}" cy="${PADDING + titleBarHeight / 2}" r="9" fill="#27C93F"/>
  
  <!-- Language label (bigger) -->
  <text x="${CANVAS_W - sidePadding - 25}" y="${PADDING + titleBarHeight / 2 + 8}" text-anchor="end"
    font-family="${FONT_FAMILY}" font-size="22" font-weight="600" fill="${PALETTE.textMuted}">
    ${escapeXml(language)}
  </text>`;

  // Code lines with larger fonts
  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * lineHeight;
    const isHighlight = highlightLines.includes(i + 1);
    const animDelay = i * 0.08;

    // Highlight background (taller for bigger text)
    if (isHighlight) {
      elements += `
      <rect x="${sidePadding + 15}" y="${y - 26}" width="${CANVAS_W - sidePadding * 2 - 30}" height="${lineHeight}"
        rx="6" fill="${PALETTE.primary}15" opacity="0">
        <animate attributeName="opacity" from="0" to="1"
          dur="0.3s" begin="${animDelay + 0.5}s" fill="freeze"/>
      </rect>`;
    }

    // Line number (larger)
    elements += `
    <text x="${sidePadding + lineNumWidth - 10}" y="${y}" text-anchor="end" dominant-baseline="middle"
      font-family="${FONT_FAMILY_MONO}" font-size="${lineNumFontSize}" fill="${PALETTE.textDim}" opacity="0">
      ${i + 1}
      <animate attributeName="opacity" from="0" to="0.5"
        dur="0.2s" begin="${animDelay}s" fill="freeze"/>
    </text>`;

    // Code text (larger for readability on phones)
    const colorizedLine = colorizeLine(lines[i], language);
    elements += `
    <text x="${startX}" y="${y}" dominant-baseline="middle"
      font-family="${FONT_FAMILY_MONO}" font-size="${codeFontSize}" opacity="0">
      ${colorizedLine}
      <animate attributeName="opacity" from="0" to="1"
        dur="0.3s" begin="${animDelay}s" fill="freeze"/>
    </text>`;
  }

  elements += svgFooter();
  return elements;
}

function colorizeLine(line, language) {
  // Basic keyword coloring for SVG tspan elements
  const keywords = {
    javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "new", "this", "try", "catch", "throw"],
    python: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "try", "except", "raise", "with", "as", "async", "await", "lambda", "yield", "self"],
    java: ["public", "private", "protected", "class", "interface", "return", "if", "else", "for", "while", "new", "this", "try", "catch", "throw", "static", "void", "int", "String"],
    kotlin: ["fun", "val", "var", "class", "object", "return", "if", "else", "for", "while", "when", "is", "in", "import", "package", "data", "sealed", "suspend", "override"],
  };

  const langKeywords = keywords[language] || keywords.javascript;
  const escaped = escapeXml(line);

  // Split by words and colorize
  const tokens = escaped.split(/(\s+)/);
  let result = "";

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      result += token;
    } else if (langKeywords.includes(token)) {
      result += `<tspan fill="${PALETTE.codeKeyword}">${token}</tspan>`;
    } else if (/^["'].*["']$/.test(token) || /^`.*`$/.test(token)) {
      result += `<tspan fill="${PALETTE.codeString}">${token}</tspan>`;
    } else if (/^\/\//.test(token) || /^#/.test(token)) {
      result += `<tspan fill="${PALETTE.codeComment}">${token}</tspan>`;
    } else if (/^\d+$/.test(token)) {
      result += `<tspan fill="${PALETTE.codeNumber}">${token}</tspan>`;
    } else {
      result += `<tspan fill="${PALETTE.codeText}">${token}</tspan>`;
    }
  }

  return result;
}

// ─────────────────────────────────────────
//  3. TIMELINE GENERATOR
// ─────────────────────────────────────────

export function generateTimelineSVG(scenePlan) {
  const events = scenePlan.timeline_events || [];
  if (events.length === 0) {
    return generateQuoteSVG({ quote_text: "Timeline", quote_attribution: "" });
  }

  const count = events.length;
  const isHorizontal = count <= 6;

  let elements = svgHeader();

  if (isHorizontal) {
    // Horizontal timeline
    const lineY = CANVAS_H / 2;
    const startX = PADDING + 120;
    const endX = CANVAS_W - PADDING - 120;
    const spacing = count > 1 ? (endX - startX) / (count - 1) : 0;

    // Main line
    elements += `
    <line x1="${startX}" y1="${lineY}" x2="${endX}" y2="${lineY}"
      stroke="${PALETTE.line}" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="2000" stroke-dashoffset="2000">
      <animate attributeName="stroke-dashoffset" from="2000" to="0"
        dur="1s" begin="0.2s" fill="freeze"/>
    </line>`;

    // Events
    for (let i = 0; i < count; i++) {
      const evt = events[i];
      const x = count === 1 ? (startX + endX) / 2 : startX + spacing * i;
      const isAbove = i % 2 === 0;
      const textY = isAbove ? lineY - 60 : lineY + 60;
      const descY = isAbove ? lineY - 38 : lineY + 82;
      const animDelay = 0.5 + i * 0.3;

      // Dot on timeline
      elements += `
      <circle cx="${x}" cy="${lineY}" r="10" fill="${PALETTE.primary}" stroke="${PALETTE.bg}" stroke-width="3"
        filter="url(#glow)" opacity="0">
        <animate attributeName="opacity" from="0" to="1"
          dur="0.3s" begin="${animDelay}s" fill="freeze"/>
        <animate attributeName="r" from="0" to="10"
          dur="0.4s" begin="${animDelay}s" fill="freeze"/>
      </circle>`;

      // Year/label
      if (evt.year) {
        elements += `
        <text x="${x}" y="${isAbove ? lineY - 85 : lineY + 105}" text-anchor="middle"
          font-family="${FONT_FAMILY}" font-size="13" font-weight="700" fill="${PALETTE.secondary}" opacity="0">
          ${escapeXml(evt.year)}
          <animate attributeName="opacity" from="0" to="1"
            dur="0.3s" begin="${animDelay + 0.1}s" fill="freeze"/>
        </text>`;
      }

      // Event label
      elements += `
      <text x="${x}" y="${textY}" text-anchor="middle"
        font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="${PALETTE.text}" opacity="0">
        ${escapeXml(evt.label)}
        <animate attributeName="opacity" from="0" to="1"
          dur="0.3s" begin="${animDelay + 0.15}s" fill="freeze"/>
      </text>`;

      // Event description
      if (evt.description) {
        const descLines = wrapText(evt.description, 20);
        for (let d = 0; d < descLines.length; d++) {
          elements += `
          <text x="${x}" y="${descY + d * 18}" text-anchor="middle"
            font-family="${FONT_FAMILY}" font-size="12" fill="${PALETTE.textMuted}" opacity="0">
            ${escapeXml(descLines[d])}
            <animate attributeName="opacity" from="0" to="1"
              dur="0.3s" begin="${animDelay + 0.25}s" fill="freeze"/>
          </text>`;
        }
      }

      // Connector line
      elements += `
      <line x1="${x}" y1="${lineY + (isAbove ? -15 : 15)}" x2="${x}" y2="${textY + (isAbove ? 15 : -15)}"
        stroke="${PALETTE.line}" stroke-width="1.5" stroke-dasharray="4,3" opacity="0">
        <animate attributeName="opacity" from="0" to="0.6"
          dur="0.3s" begin="${animDelay + 0.1}s" fill="freeze"/>
      </line>`;
    }
  } else {
    // Vertical timeline for many events
    const lineX = CANVAS_W * 0.3;
    const startY = PADDING + 80;
    const endY = CANVAS_H - PADDING - 40;
    const spacing = (endY - startY) / (count - 1);

    elements += `
    <line x1="${lineX}" y1="${startY}" x2="${lineX}" y2="${endY}"
      stroke="${PALETTE.line}" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="2000" stroke-dashoffset="2000">
      <animate attributeName="stroke-dashoffset" from="2000" to="0"
        dur="1s" begin="0.2s" fill="freeze"/>
    </line>`;

    for (let i = 0; i < count; i++) {
      const evt = events[i];
      const y = startY + spacing * i;
      const animDelay = 0.5 + i * 0.25;

      elements += `
      <circle cx="${lineX}" cy="${y}" r="8" fill="${PALETTE.primary}" stroke="${PALETTE.bg}" stroke-width="3"
        filter="url(#glow)" opacity="0">
        <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="${animDelay}s" fill="freeze"/>
      </circle>`;

      if (evt.year) {
        elements += `
        <text x="${lineX - 30}" y="${y + 5}" text-anchor="end"
          font-family="${FONT_FAMILY}" font-size="14" font-weight="700" fill="${PALETTE.secondary}" opacity="0">
          ${escapeXml(evt.year)}
          <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="${animDelay + 0.1}s" fill="freeze"/>
        </text>`;
      }

      elements += `
      <text x="${lineX + 30}" y="${y - 5}" font-family="${FONT_FAMILY}" font-size="16" font-weight="600"
        fill="${PALETTE.text}" opacity="0">
        ${escapeXml(evt.label)}
        <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="${animDelay + 0.15}s" fill="freeze"/>
      </text>`;

      if (evt.description) {
        elements += `
        <text x="${lineX + 30}" y="${y + 16}" font-family="${FONT_FAMILY}" font-size="13"
          fill="${PALETTE.textMuted}" opacity="0">
          ${escapeXml(evt.description)}
          <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="${animDelay + 0.2}s" fill="freeze"/>
        </text>`;
      }
    }
  }

  elements += svgFooter();
  return elements;
}

// ─────────────────────────────────────────
//  4. COMPARISON GENERATOR
// ─────────────────────────────────────────

export function generateComparisonSVG(scenePlan) {
  const items = scenePlan.comparison_items || [];
  const title = scenePlan.comparison_title || "";

  if (items.length < 2) {
    return generateQuoteSVG({ quote_text: title || "Comparison", quote_attribution: "" });
  }

  let elements = svgHeader();

  // Title
  if (title) {
    elements += `
    <text x="${CANVAS_W / 2}" y="70" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="28" font-weight="700" fill="${PALETTE.text}" opacity="0">
      ${escapeXml(title)}
      <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="0.1s" fill="freeze"/>
    </text>`;
  }

  const columnCount = Math.min(items.length, 3);
  const colWidth = (CANVAS_W - PADDING * 2 - (columnCount - 1) * 30) / columnCount;
  const startY = title ? 120 : 80;

  for (let c = 0; c < columnCount; c++) {
    const item = items[c];
    const x = PADDING + c * (colWidth + 30);
    const color = item.color || [PALETTE.primary, PALETTE.secondary, PALETTE.accent][c % 3];
    const slideFrom = c === 0 ? "left" : c === columnCount - 1 ? "right" : "center";
    const animDelay = c * 0.3;

    // Column background
    elements += `
    <rect x="${x}" y="${startY}" width="${colWidth}" height="${CANVAS_H - startY - PADDING}"
      rx="16" fill="${color}08" stroke="${color}40" stroke-width="1.5" opacity="0">
      <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="${animDelay}s" fill="freeze"/>
    </rect>`;

    // Column header
    elements += `
    <rect x="${x}" y="${startY}" width="${colWidth}" height="55" rx="16" fill="${color}25" opacity="0">
      <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${animDelay}s" fill="freeze"/>
    </rect>
    <text x="${x + colWidth / 2}" y="${startY + 35}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="20" font-weight="700" fill="${PALETTE.text}" opacity="0">
      ${escapeXml(item.label)}
      <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${animDelay + 0.1}s" fill="freeze"/>
    </text>`;

    // Points
    const points = item.points || [];
    for (let p = 0; p < points.length; p++) {
      const py = startY + 85 + p * 50;
      const pointDelay = animDelay + 0.3 + p * 0.15;

      // Bullet
      elements += `
      <circle cx="${x + 25}" cy="${py}" r="5" fill="${color}" opacity="0">
        <animate attributeName="opacity" from="0" to="1" dur="0.2s" begin="${pointDelay}s" fill="freeze"/>
      </circle>`;

      // Point text
      const pointLines = wrapText(points[p], 28);
      for (let l = 0; l < pointLines.length; l++) {
        elements += `
        <text x="${x + 42}" y="${py + 5 + l * 18}" font-family="${FONT_FAMILY}" font-size="14"
          fill="${PALETTE.text}" opacity="0">
          ${escapeXml(pointLines[l])}
          <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="${pointDelay}s" fill="freeze"/>
        </text>`;
      }
    }
  }

  elements += svgFooter();
  return elements;
}

// ─────────────────────────────────────────
//  5. QUOTE / EMPHASIS GENERATOR
// ─────────────────────────────────────────

export function generateQuoteSVG(scenePlan) {
  const text = scenePlan.quote_text || "";
  const attribution = scenePlan.quote_attribution || "";

  let elements = svgHeader();

  // Decorative quote mark
  elements += `
  <text x="${CANVAS_W / 2}" y="${CANVAS_H / 2 - 80}" text-anchor="middle"
    font-family="${FONT_FAMILY}" font-size="120" fill="${PALETTE.primary}30" opacity="0">
    \u201C
    <animate attributeName="opacity" from="0" to="1" dur="0.6s" begin="0.1s" fill="freeze"/>
  </text>`;

  // Quote text (wrapped)
  const lines = wrapText(text, 45);
  const totalHeight = lines.length * 48;
  const startY = CANVAS_H / 2 - totalHeight / 2 + 20;

  for (let i = 0; i < lines.length; i++) {
    elements += `
    <text x="${CANVAS_W / 2}" y="${startY + i * 48}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="36" font-weight="700" fill="${PALETTE.text}" opacity="0">
      ${escapeXml(lines[i])}
      <animate attributeName="opacity" from="0" to="1"
        dur="0.5s" begin="${0.2 + i * 0.1}s" fill="freeze"/>
    </text>`;
  }

  // Attribution
  if (attribution) {
    elements += `
    <text x="${CANVAS_W / 2}" y="${startY + totalHeight + 30}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="18" font-style="italic" fill="${PALETTE.textMuted}" opacity="0">
      — ${escapeXml(attribution)}
      <animate attributeName="opacity" from="0" to="1"
        dur="0.4s" begin="${0.5 + lines.length * 0.1}s" fill="freeze"/>
    </text>`;
  }

  // Decorative underline
  elements += `
  <line x1="${CANVAS_W / 2 - 80}" y1="${startY + totalHeight + 60}" x2="${CANVAS_W / 2 + 80}" y2="${startY + totalHeight + 60}"
    stroke="${PALETTE.primary}" stroke-width="3" stroke-linecap="round" opacity="0">
    <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="0.8s" fill="freeze"/>
  </line>`;

  elements += svgFooter();
  return elements;
}

// ─────────────────────────────────────────
//  6. TEXT OVERLAY GENERATOR
//  For subscene text overlays on any scene
// ─────────────────────────────────────────

export function generateTextOverlaySVG(text, position = "bottom") {
  const y = position === "top" ? 100 : CANVAS_H - 100;

  return `
  <g class="text-overlay">
    <rect x="${CANVAS_W / 2 - 300}" y="${y - 30}" width="600" height="60"
      rx="12" fill="#00000080"/>
    <text x="${CANVAS_W / 2}" y="${y + 5}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="24" font-weight="600" fill="${PALETTE.text}">
      ${escapeXml(text)}
    </text>
  </g>`;
}

// ─────────────────────────────────────────
//  MAIN: Generate SVG based on scene type
// ─────────────────────────────────────────

export function generateSVGForScene(scenePlan) {
  switch (scenePlan.scene_type) {
    case "diagram":
      return generateDiagramSVG(scenePlan);
    case "code":
      return generateCodeSVG(scenePlan);
    case "timeline":
      return generateTimelineSVG(scenePlan);
    case "comparison":
      return generateComparisonSVG(scenePlan);
    case "quote":
      return generateQuoteSVG(scenePlan);
    default:
      // For illustration scenes, we don't generate SVG — we generate images
      // Return null to signal that image generation should be used
      return null;
  }
}

export default {
  generateSVGForScene,
  generateDiagramSVG,
  generateCodeSVG,
  generateTimelineSVG,
  generateComparisonSVG,
  generateQuoteSVG,
  generateTextOverlaySVG,
  PALETTE,
  CANVAS_W,
  CANVAS_H,
};
