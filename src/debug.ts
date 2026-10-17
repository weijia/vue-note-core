/**
 * vue-note-core 的调试日志统一入口。
 *
 * 底层依赖 @richard432/localstorage-logger：
 * - 每个命名空间对应一个 localStorage key `debug:<namespace>`
 * - key 不存在 → 自动创建为 '1'（默认输出）；'0' → 静默
 * - Node / SSR 下回退到环境变量 `DEBUG_<NAMESPACE>`（`:` 与 `-` 转成 `_`，大写）
 *
 * 在此之上补充三种开关方式（包原生只提供 localStorage）：
 * 1. 运行时 API ：enableDebug / disableDebug / setDebug / silenceDebug
 * 2. URL 参数   ：?debug=sync,git / ?debug=1 / ?debug=0
 * 3. 环境变量   ：VITE_DEBUG / DEBUG / NODE_DEBUG（Node 与 SSR 场景）
 *
 * 并补齐包本身不支持的「通配符 / 短名」匹配，例如 `note-core:*`、`sync`。
 * 本文件只在 URL / 环境变量真的带了 debug 配置时才写 localStorage，否则保持静默。
 */
import {
  createLogger,
  isDebugEnabled,
  listDebugModules,
  setDebugEnabled,
  type Logger,
} from '@richard432/localstorage-logger';

/** 本模块全部调试命名空间（每个对应一个 localStorage key `debug:<ns>`） */
export const DEBUG_NAMESPACES = [
  'note-core:notebook',
  'note-core:provider',
  'note-core:pouchdb',
  'note-core:git',
  'note-core:gitee',
  'note-core:webdav',
  'note-core:sync',
  'note-core:utils',
] as const;

export type DebugNamespace = (typeof DEBUG_NAMESPACES)[number];

const NAMESPACES: readonly string[] = DEBUG_NAMESPACES;

/** 代表「全部开启」的 token */
const TRUE_TOKENS = new Set(['1', '*', 'all', 'true', 'on', 'debug']);
/** 代表「全部关闭」的 token */
const FALSE_TOKENS = new Set(['0', 'off', 'false', 'none', 'silent']);
/** initDebug 读取的环境变量，按此优先级取第一个命中的 */
const ENV_KEYS = ['VITE_DEBUG', 'DEBUG', 'NODE_DEBUG'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断命名空间是否命中 pattern。支持全量（'1' / '*' / 'all'）、
 * 前缀（'note-core:*'）、短名（'sync' 命中 'note-core:sync'）、通配（'*core*'）。
 */
export function matchesNamespace(ns: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (TRUE_TOKENS.has(p.toLowerCase())) return true;
  if (ns === p) return true;
  if (p.endsWith('*')) return ns.startsWith(p.slice(0, -1));
  if (!p.includes('*')) return ns.endsWith(':' + p);
  const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$');
  return re.test(ns);
}

/** 按 pattern 挑选出本模块命中的命名空间 */
function select(pattern: string): string[] {
  return NAMESPACES.filter((ns) => matchesNamespace(ns, pattern));
}

/** 开启调试日志；省略 pattern 表示开启本模块全部命名空间 */
export function enableDebug(pattern?: string): string[] {
  const targets = pattern && pattern.trim() ? select(pattern) : [...NAMESPACES];
  for (const ns of targets) setDebugEnabled(ns, true);
  return targets;
}

/** 关闭调试日志；省略 pattern 表示关闭本模块全部命名空间 */
export function disableDebug(pattern?: string): string[] {
  const targets = pattern && pattern.trim() ? select(pattern) : [...NAMESPACES];
  for (const ns of targets) setDebugEnabled(ns, false);
  return targets;
}

/** 一键静音本模块所有调试日志 */
export function silenceDebug(): void {
  for (const ns of NAMESPACES) setDebugEnabled(ns, false);
}

/**
 * 逗号分隔的批量开关，语义同 debug 包：`'sync,-note-core:pull'`。
 * 未被命中的本模块命名空间会被关闭，即「只保留显式指定的」。
 *
 * @returns 最终处于开启状态的命名空间
 */
export function setDebug(pattern: string): string[] {
  const tokens = String(pattern ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return enabledDebugNamespaces();

  for (const ns of NAMESPACES) setDebugEnabled(ns, false);
  for (const token of tokens) {
    const negative = token.startsWith('-');
    const body = (negative ? token.slice(1) : token).trim();
    if (!body || FALSE_TOKENS.has(body.toLowerCase())) continue;
    for (const ns of select(body)) setDebugEnabled(ns, !negative);
  }
  return enabledDebugNamespaces();
}

/** 查询命名空间当前的开关状态（无副作用，不会创建 key） */
export function isDebugOn(namespace: string): boolean {
  return isDebugEnabled(namespace);
}

/** 列出全局所有已知的 debug 命名空间（含其他模块写入的） */
export function listDebug(): { module: string; enabled: boolean }[] {
  try {
    return listDebugModules();
  } catch {
    return [];
  }
}

/** 本模块当前处于开启状态的命名空间 */
export function enabledDebugNamespaces(): string[] {
  return NAMESPACES.filter((ns) => isDebugEnabled(ns));
}

/** 一行摘要，便于在控制台快速自查 */
export function describeDebug(): string {
  const on = enabledDebugNamespaces();
  return `note-core debug: ${on.length ? on.join(', ') : '（全部关闭）'}`;
}

/** 为任意命名空间创建 Logger */
export function createDebugLogger(namespace: string): Logger {
  return createLogger(namespace);
}

/** 安全读取进程环境变量（SSR / Node / vitest 可用，浏览器返回 undefined） */
function readProcessEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as Record<string, unknown>).process as
      | { env?: Record<string, unknown> }
      | undefined;
    const value = proc?.env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 安全读取 URL 查询参数（仅浏览器环境） */
function readUrlParam(key: string): string | undefined {
  try {
    if (typeof location !== 'undefined' && location.search) {
      return new URLSearchParams(location.search).get(key) ?? undefined;
    }
  } catch {
    /* URL 不可用时忽略 */
  }
  return undefined;
}

let initialized = false;

/**
 * 依据环境变量与 URL 参数初始化调试开关，优先级：URL > 环境变量 > localStorage 现状。
 * 模块加载时会自动执行一次，重复调用无副作用。
 */
export function initDebug(): string[] {
  if (initialized) return enabledDebugNamespaces();
  initialized = true;

  for (const key of ENV_KEYS) {
    const value = readProcessEnv(key);
    if (value) {
      setDebug(value);
      break;
    }
  }
  const fromUrl = readUrlParam('debug');
  if (fromUrl) setDebug(fromUrl);

  return enabledDebugNamespaces();
}

initDebug();

// 各文件直接复用的具名 logger（createLogger 本身无副作用，只在真正输出时才读写 localStorage）
export const logNotebook = createLogger('note-core:notebook');
export const logProvider = createLogger('note-core:provider');
export const logPouchDB = createLogger('note-core:pouchdb');
export const logGit = createLogger('note-core:git');
export const logGitee = createLogger('note-core:gitee');
export const logWebDAV = createLogger('note-core:webdav');
export const logSync = createLogger('note-core:sync');
export const logUtils = createLogger('note-core:utils');
