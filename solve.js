// Fast drop-in for makefun-site 1.0.0 (MIT): same answers, byte for byte, on every
// case, in much less CPU. Written fresh for site-generator-speed-01-run-20261122.
// Strategy: templates are compiled once per case to plain JS (includes inlined
// where the include graph is acyclic, loop bindings resolved at compile time),
// Markdown renders in one fused pass with batched escaping, and slugs, links and
// word counts are cached or scanned without allocating. No clock, env, randomness
// or file access: run(input) is a pure function of its input.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text rules

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text`, exactly as the reference defines it (NFKD, marks dropped, runs to one `-`, cut at 64). */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter over its line array: { data, close } with `close` the
 * index of the closing `---` line, or { error } with the first refusal reason.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 35 || FM_BLANK.test(line)) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- Markdown

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_QUOTE_STRIP = /^> ?/;
const MD_WS = /\s/;

/** A line of only spaces/tabs (or empty). Most lines fail on the first character. */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A line as rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return MD_FENCE_OPEN.test(line);
  if (c0 === 35) {
    const hm = MD_HEADING.exec(line);
    return hm !== null && hm[2] !== '';
  }
  if (c0 === 45 || c0 === 42) return MD_HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A `what` is escaped exactly when the run of backslashes before it is odd: the
 * run pairs up left to right, so an odd run leaves one backslash to escape it.
 * (The run cannot start before `from`: the character at `from - 1` is the opener.)
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    // An odd run of backslashes before it escapes this star: skip it.
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if (n % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The next character inline parsing cares about: a construct opener or an escapable character. */
const NEXT = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. The regex finds each
 * construct natively; the plain text between constructs needs no escaping pass
 * (it holds none of the escapable characters by construction). The shared
 * regex is safe across the recursive calls: every path sets lastIndex before
 * the next search.
 */
function inline(s, link) {
  const out = [];
  let i = 0;
  NEXT.lastIndex = 0;
  let m;
  while ((m = NEXT.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        if (j > i) out.push(s.slice(i, j));
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        i = j + 2;
        NEXT.lastIndex = i;
      } else {
        NEXT.lastIndex = j + 1; // a literal backslash stays in the run
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        NEXT.lastIndex = i;
      } else {
        NEXT.lastIndex = j + 1; // a literal backtick stays in the run
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > i) out.push(s.slice(i, j));
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
          NEXT.lastIndex = i;
        } else {
          NEXT.lastIndex = j + 2; // a literal ** stays in the run
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
        i = k + 1;
        NEXT.lastIndex = i;
      } else {
        NEXT.lastIndex = j + 1; // a literal * stays in the run
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const t = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !MD_WS.test(target)) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(j + 1, k), link), '</a>');
        i = t + 1;
        NEXT.lastIndex = i;
      } else {
        NEXT.lastIndex = j + 1; // a literal [ stays in the run
      }
      continue;
    }
    // An escapable character: & < > " '
    if (j > i) out.push(s.slice(i, j));
    out.push(ESCAPES[c]);
    i = j + 1;
    NEXT.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

/**
 * A source's body rendered, straight from its line array (`lines`, from index
 * `start`): { html, toc, excerpt }. One fused pass, no token objects.
 */
function renderMarkdown(lines, start, link, slugify, ids) {
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      // A backtick line is a fence or a paragraph.
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        i++;
        while (i < n && !MD_FENCE_CLOSE.test(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      // A hash line is a heading or a paragraph.
      const hm = MD_HEADING.exec(line);
      if (hm !== null && hm[2] !== '') {
        const depth = hm[1].length;
        const text = hm[2];
        const id = uniqueSlug(slugify(text), ids);
        const html = inline(text, link);
        out.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      // A dash/star line is a break, a bullet, or a paragraph.
      if (MD_HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      // A > line is a blockquote or a paragraph.
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        q.push(trimLine(lines[i].replace(MD_QUOTE_STRIP, '')));
        i++;
      }
      const kept = q.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      const bm = MD_BULLET.exec(line);
      if (bm !== null) {
        const items = [];
        while (i < n) {
          const m = MD_BULLET.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (const parts of items) out.push(`<li>${inline(parts.join('\n'), link)}</li>\n`);
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const om = MD_ORDERED.exec(line);
      if (om !== null) {
        const startNum = Number(om[1]);
        const items = [];
        while (i < n) {
          const m = MD_ORDERED.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push(startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n');
        for (const parts of items) out.push(`<li>${inline(parts.join('\n'), link)}</li>\n`);
        out.push('</ol>\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/** JS whitespace (`\s`) by code unit. */
const WS64 = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS64[c] = 1;

/** The words of a body (runs of non-whitespace) over its lines, without joining them. */
function wordsOfLines(lines, start) {
  let n = 0;
  const W = WS64;
  for (let li = start; li < lines.length; li++) {
    const s = lines[li];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      if (W[s.charCodeAt(i)] === 1) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template runtime helpers (passed into compiled functions) ---

/** A value as text: string itself, number in JavaScript's digits, true/false, array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A root variable by name (own property only), else undefined. */
function gv(R, name) {
  return Object.hasOwn(R, name) ? R[name] : undefined;
}

/** The next segment of a path: an own property of an object value, else undefined. */
function gp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A loop-bound name from the runtime scope chain (cyclic-include fallback), else undefined. */
function lk(S, name) {
  let s = S;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** The names a page's values can hold at the root (everything else loop-bound or undefined). */
const ROOT_VARS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

/** The JS expression for `path` under the compile-time binding stack `bindings` (innermost frame last). */
function pathExpr(path, bindings) {
  const first = path[0];
  let expr;
  for (let i = bindings.length - 1; i >= 0; i--) {
    const local = bindings[i].vars.get(first);
    if (local !== undefined) {
      expr = local;
      break;
    }
  }
  if (expr === undefined) expr = ROOT_VARS.has(first) ? `R.${first}` : `lk(S, ${JSON.stringify(first)})`;
  for (let k = 1; k < path.length; k++) expr = `gp(${expr}, ${JSON.stringify(path[k])})`;
  return expr;
}

/** The runtime scope-chain expression for the current binding stack (fallback includes only). */
function scopeExpr(bindings) {
  let expr = 'S';
  for (let i = bindings.length - 1; i >= 0; i--) {
    const parts = [];
    for (const [name, local] of bindings[i].vars) parts.push(`${JSON.stringify(name)}: ${local}`);
    expr = `{vars: {${parts.join(', ')}}, parent: ${expr}}`;
  }
  return expr;
}

/**
 * Emit JS for `nodes` into `g.out`. `g.bindings` is the compile-time loop-binding
 * stack; `g.stack` the templates being inlined (cycle guard); `g.parsed` the
 * parsed templates. Acyclic includes are inlined (the included code sees the
 * caller's loop locals, exactly as rendering in the same scope); a cyclic one
 * falls back to a runtime call into the target's own compiled function.
 */
function genNodes(nodes, g) {
  for (const node of nodes) {
    if (node.kind === 'text') g.out.push(`O.push(${JSON.stringify(node.text)});`);
    else if (node.kind === 'var') g.out.push(`O.push(esc(tof(${pathExpr(node.path, g.bindings)})));`);
    else if (node.kind === 'raw') g.out.push(`O.push(tof(${pathExpr(node.path, g.bindings)}));`);
    else if (node.kind === 'if') {
      g.out.push(`if (${node.not ? '!' : ''}tru(${pathExpr(node.path, g.bindings)})) {`);
      genNodes(node.then, g);
      if (node.else !== null) {
        g.out.push('} else {');
        genNodes(node.else, g);
      }
      g.out.push('}');
    } else if (node.kind === 'for') {
      const a = `_a${g.uid.n++}`;
      const i = `_i${g.uid.n++}`;
      const v = `_v${g.uid.n++}`;
      const l = `_l${g.uid.n++}`;
      // One mutable loop record per for-execution: templates only ever read it
      // during the iteration, so sharing it across iterations is unobservable.
      g.out.push(`{ const ${a} = ${pathExpr(node.path, g.bindings)}; if (Array.isArray(${a})) { const ${l} = {index: 0, first: false, last: false, length: ${a}.length}; for (let ${i} = 0; ${i} < ${a}.length; ${i}++) { const ${v} = ${a}[${i}]; ${l}.index = ${i} + 1; ${l}.first = ${i} === 0; ${l}.last = ${i} === ${a}.length - 1;`);
      const vars = new Map();
      vars.set(node.name, v);
      vars.set('loop', l);
      g.bindings.push({ vars });
      genNodes(node.body, g);
      g.bindings.pop();
      g.out.push('} } }');
    } else if (node.kind === 'include') {
      const target = g.parsed.get(node.name);
      if (target === undefined) {
        // A missing include renders nothing.
      } else if (g.stack.includes(node.name)) {
        const f = `_f${g.uid.n++}`;
        g.out.push(`if (_d < ${INCLUDE_DEPTH}) { const ${f} = C.get(${JSON.stringify(node.name)}); if (${f} !== undefined) ${f}(C, R, ${scopeExpr(g.bindings)}, _d + 1, O, esc, tof, tru, gv, gp, lk); }`);
      } else {
        g.out.push(`if (_d < ${INCLUDE_DEPTH}) { _d++;`);
        g.stack.push(node.name);
        genNodes(target, g);
        g.stack.pop();
        g.out.push('_d--; }');
      }
    }
  }
}

/** Compile one template's node tree to a function (C, R, S, D, O, esc, tof, tru, gv, gp, lk). */
function compileTemplate(name, nodes, parsed) {
  const g = { out: [], bindings: [], stack: [name], parsed, uid: { n: 0 } };
  g.out.push('let _d = D;');
  genNodes(nodes, g);
  return new Function('C', 'R', 'S', 'D', 'O', 'esc', 'tof', 'tru', 'gv', 'gp', 'lk', g.out.join('\n'));
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
function build(input) {
  const report = [];
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of parsed) compiled.set(name, compileTemplate(name, nodes, parsed));

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, sorted by path in code-unit order; `.md` is a source, the rest static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // Front matter, in order: refusal, tags//page/ dir, post with no date, layout missing, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved (cached per directory + target; broken reported once per source).
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const resolveLink = (dir, target) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return { href: target, broken: false };
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const pg = bySource.get(path);
      if (pg !== undefined) return { href: pg.url + frag, broken: false };
      if (staticPaths.has(path)) return { href: `${base}/${path}${frag}`, broken: false };
    }
    return { href: target, broken: true };
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const sourcePath = s.path;
    const link = (target) => {
      let byDir = linkCache.get(dir);
      if (byDir === undefined) {
        byDir = new Map();
        linkCache.set(dir, byDir);
      }
      let r = byDir.get(target);
      if (r === undefined) {
        r = resolveLink(dir, target);
        byDir.set(target, r);
      }
      if (r.broken) broken.add(`broken-link ${sourcePath} -> ${target}`);
      return r.href;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugify, new Set());
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met in collection order, by count then slug.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Per-source records templates only read: the neighbour link record and the
  // card's tag list, built once and shared (their values never change).
  for (const s of kept) {
    s.linkRec = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    s.cardTags = s.tagRefs.map((t) => (t.cardTag ??= { name: t.name, slug: t.slug, url: t.url }));
  }

  // Cards, pages and link records as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200)),
    tags: s.cardTags,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer ? s.newer.linkRec : null,
    older: s.older ? s.older.linkRec : null,
    is_post: s.post,
  });

  // Layouts: every page, the index pages, the tag pages, then the static files.
  const output = Object.create(null);
  const written = new Set();
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const R = { site, tags: allTags, recent };
    if (vars.page !== undefined) R.page = vars.page;
    if (vars.posts !== undefined) R.posts = vars.posts;
    if (vars.pager !== undefined) R.pager = vars.pager;
    if (vars.tag !== undefined) R.tag = vars.tag;
    const O = [];
    fn(compiled, R, null, 0, O, escapeHtml, textOf, truthy, gv, gp, lk);
    return O.join('');
  };
  for (const s of kept) {
    const path = `${s.outDir}/index.html`;
    output[path] = render(s.layout, { page: pageOf(s) });
    written.add(path);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) {
      const path = k === 1 ? 'index.html' : `page/${k}/index.html`;
      output[path] = html;
      written.add(path);
    }
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) {
      const path = `tags/${t.slug}/index.html`;
      output[path] = html;
      written.add(path);
    }
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) {
    output['tags/index.html'] = tagsHtml;
    written.add('tags/index.html');
  }
  for (const f of statics) {
    if (written.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else {
      output[f.path] = f.content;
      written.add(f.path);
    }
  }

  // The report: every line sorted in code-unit order, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  lines.push(`built ${kept.filter((s) => !s.post).length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
