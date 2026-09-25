/**
 * 通用工具：uuid、文件名清洗、frontmatter 解析 / 序列化
 * 注意：本文件刻意不使用任何反斜杠字面量（避免转义/控制字符问题）。
 */
import { logUtils } from './debug';

const NL = String.fromCharCode(10); // 换行
const CR = String.fromCharCode(13); // 回车
const BS = String.fromCharCode(92); // 反斜杠

/** 生成 uuid，优先使用原生 crypto.randomUUID */
export function uuid(): string {
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 清洗文件名中的非法字符（Windows / URL 均安全） */
const ILLEGAL = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', ' ', '-'];
export function sanitize(name: string): string {
  let s = String(name || '');
  for (const ch of ILLEGAL) {
    s = s.split(ch).join('_');
  }
  s = s.trim();
  if (!s) {
    // 标题全由非法字符构成时静默退化，这里给出提示便于排查文件名异常
    logUtils.warn('sanitize 入参清洗后为空，已回退为随机名');
    s = uuid().slice(0, 8);
  }
  return s.slice(0, 80);
}

export interface Frontmatter {
  data: Record<string, any>;
  content: string;
}

/** 解析 Markdown frontmatter（兼容 CRLF / LF） */
export function parseFrontmatter(raw: string): Frontmatter {
  if (!raw) return { data: {}, content: '' };
  const text = String(raw).split(CR).join(''); // strip CR
  const head = '---' + NL;
  if (text.indexOf(head) !== 0) return { data: {}, content: text };

  const tail = NL + '---' + NL;
  const end = text.indexOf(tail, head.length);
  if (end === -1) return { data: {}, content: text };

  const fmText = text.slice(head.length, end);
  const content = text.slice(end + tail.length);
  const data: Record<string, any> = {};

  for (const line of fmText.split(NL)) {
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    if (!key || !/^[A-Za-z0-9_]/.test(key)) continue;
    let val = line.slice(ci + 1).trim();
    if (val === '') continue;

    if (val.charAt(0) === '[' && val.charAt(val.length - 1) === ']') {
      const inner = val.slice(1, -1).trim();
      data[key] = inner
        ? inner.split(',').map((s) => stripQuotes(s.trim())).filter(Boolean)
        : [];
    } else if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
      data[key] = stripQuotes(val);
    } else if (isNumeric(val)) {
      data[key] = Number(val);
    } else {
      data[key] = stripQuotes(val);
    }
  }
  return { data, content };
}

/** 序列化为 Markdown frontmatter */
export function stringifyFrontmatter(data: Record<string, any>, content: string): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v)) {
      lines.push(k + ': [' + v.map((s) => '"' + q(String(s)) + '"').join(', ') + ']');
    } else if (typeof v === 'number') {
      lines.push(k + ': ' + v);
    } else if (v === undefined || v === null) {
      lines.push(k + ': ""');
    } else {
      lines.push(k + ': "' + q(String(v)) + '"');
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join(NL) + (content || '') + NL;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.charAt(0) === "'" && s.charAt(s.length - 1) === "'") {
    return s.slice(1, -1);
  }
  return s;
}

function q(s: string): string {
  let out = '';
  for (const ch of String(s)) {
    if (ch === '"') out += BS + '"';
    else out += ch;
  }
  return out;
}

function isNumeric(s: string): boolean {
  if (!s) return false;
  let i = 0;
  if (s.charAt(0) === '-') i = 1;
  if (i >= s.length) return false;
  let dot = false;
  for (; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '.') {
      if (dot) return false;
      dot = true;
    } else if (c < '0' || c > '9') {
      return false;
    }
  }
  return true;
}

/** 安全编码 Provider / 笔记本名称，避免 PouchDB / 文件路径静默失败 */
export function safeName(name: string): string {
  return encodeURIComponent(name || 'default');
}
