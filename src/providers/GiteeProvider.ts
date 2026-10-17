import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
} from '../types';
import { parseFrontmatter, stringifyFrontmatter, sanitize } from '../utils';
import { logGitee } from '../debug';

/**
 * 基于 zen-fs-gitee（ZenFS Gitee 后端）的 Gitee 文档库 Provider。
 *
 * 走 Gitee REST API v5（Contents API），把仓库挂载成文件系统，
 * 不需要 git 智能 HTTP，因此【无需 CORS 代理】。
 *
 * 每个文档库 = 一个独立的 GiteeFS 实例（resolveMountConfig 返回已就绪实例）。
 * 通过模块级 giteeCache 缓存已就绪实例，切换 / 重载文档库时复用，避免重复拉取仓库树。
 *
 * 与 GitProvider 保持相同的 NotebookProvider 接口，便于 useNotebook 按 type 选择。
 *
 * 注意：@zenfs/core 与 zen-fs-gitee 通过动态 import 引入，并在打包时保持「外置」，
 * 由其消费端（网页 import map 指向已验证的自包含 bundle）提供，
 * 以规避 esm.sh 对这两个包二次转译即崩溃的问题。
 */
export class GiteeProvider implements NotebookProvider {
  readonly type = 'gitee' as const;
  readonly name: string;
  private config: ProviderConfig = {};
  private fs: any = null;
  private known = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  async init(config: ProviderConfig): Promise<void> {
    this.config = config || {};
    const g = this.config.gitee;
    if (!g || !g.owner || !g.repo) {
      throw new Error('Gitee 配置不完整：缺少 owner / repo');
    }

    const key = giteeCacheKey(this.config);
    let inst = giteeCache.get(key);
    if (!inst) {
      logGitee.log('init START', { owner: g.owner, repo: g.repo, branch: g.branch || 'master' });
      try {
        // 动态导入：确保 ZenFS 仅在用到 Gitee 时才加载，不会拖垮 Git 文档库
        const { resolveMountConfig } = await import('@zenfs/core');
        const { Gitee } = await import('zen-fs-gitee');
        const raw = await resolveMountConfig({
          backend: Gitee,
          token: g.token,
          owner: g.owner,
          repo: g.repo,
          branch: g.branch || 'master',
          useCommitTimeAsMtime: g.useCommitTimeAsMtime ?? false,
        });
        // 可选：套一层 zen-fs-cache 缓存（默认 IndexedDB，跨刷新秒开）
        inst = await wrapGiteeCache(raw, g, key);
        giteeCache.set(key, inst);
        logGitee.log('resolveMountConfig OK', { owner: g.owner, repo: g.repo });
      } catch (e: any) {
        logGitee.error('resolveMountConfig FAIL', { owner: g.owner, repo: g.repo }, e);
        throw e;
      }
    }
    this.fs = inst;
    this.known = new Map();
    await this.indexNotes();
    logGitee.log('init OK', { name: this.name });
  }

  async destroy(): Promise<void> {
    logGitee.log('destroy', this.name);
    // 仅清空本地引用，不清除 giteeCache：实例可被同配置的其他 provider 复用
    this.fs = null;
    this.known = new Map();
  }

  async listNotes(): Promise<SidebarNote[]> {
    return this.indexNotes();
  }

  async getNote(id: string): Promise<SidebarNote | null> {
    return this.fileToNote(this.fixPath(id));
  }

  async saveNote(note: SidebarNote): Promise<SidebarNote> {
    if (!this.fs) throw new Error('GiteeProvider 尚未初始化: ' + this.name);
    const updated: SidebarNote = { ...note, updatedAt: Date.now() };
    const filePath = this.fixPath(updated._id);
    // 显式带上 S_IFDIR：GiteeFS.mkdir 会做 `options.mode |= S_IFDIR`，
    // 只传 { recursive } 会让 mode 变成 NaN，导致该目录下的 inode 类型判断失效。
    const mkdirOpts = { recursive: true, mode: 0o40755 };
    const dirOf = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dirOf && dirOf !== '/') {
      try {
        await this.fs.mkdir(dirOf, mkdirOpts);
      } catch {
        /* 目录可能已存在或 .mtime 侧车目录 */
      }
    }
    const body = stringifyFrontmatter(
      {
        title: updated.title,
        path: updated.path || '/未分类',
        tags: updated.tags || [],
        updatedAt: updated.updatedAt,
      },
      updated.content,
    );
    // GiteeFS.writeFile 会立即更新本地缓存并后台提交到 Gitee（每次写生成一个 commit）
    await this.fs.writeFile(filePath, body, 'utf8');
    this.known.set(updated._id, updated.updatedAt || 0);
    logGitee.log('saveNote OK', { id: updated._id, file: filePath });
    return updated;
  }

  async createNote(path?: string, title?: string): Promise<SidebarNote> {
    if (!this.fs) throw new Error('GiteeProvider 尚未初始化: ' + this.name);
    let dir = path || '/未分类';
    if (dir.charAt(0) === '/') dir = dir.slice(1);
    if (dir.charAt(dir.length - 1) === '/') dir = dir.slice(0, -1);
    const t = title || '无标题笔记';
    const base = sanitize(t);
    const rel = (dir ? dir + '/' : '') + base + '.md';
    const note: SidebarNote = {
      _id: rel,
      title: t,
      content: '',
      path: '/' + (dir || '未分类'),
      tags: [],
      updatedAt: Date.now(),
    };
    const filePath = this.fixPath(rel);
    const dirOf = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dirOf && dirOf !== '/') {
      try {
        await this.fs.mkdir(dirOf, { recursive: true, mode: 0o40755 });
      } catch {
        /* ignore */
      }
    }
    await this.fs.writeFile(
      filePath,
      stringifyFrontmatter(
        { title: note.title, path: note.path, tags: [], updatedAt: note.updatedAt },
        '',
      ),
      'utf8',
    );
    this.known.set(note._id, note.updatedAt || 0);
    logGitee.log('createNote OK', { id: note._id, file: filePath });
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.fs) throw new Error('GiteeProvider 尚未初始化: ' + this.name);
    const filePath = this.fixPath(id);
    try {
      await this.fs.unlink(filePath);
    } catch {
      /* 文件可能不存在 */
    }
    this.known.delete(id);
    logGitee.log('deleteNote OK', id);
  }

  // GiteeFS 每次写已自动提交；sync() 做一次刷新 + 重新索引（拉取远端变更到本地缓存）
  async sync(): Promise<{ pushed: number; pulled: number; conflicts: number; errors: string[] }> {
    const result = { pushed: 0, pulled: 0, conflicts: 0, errors: [] as string[] };
    try {
      if (this.fs && typeof this.fs.sync === 'function') {
        await this.fs.sync();
        result.pushed++;
      }
      await this.indexNotes();
      result.pulled++;
      logGitee.log('sync OK', result);
    } catch (e: any) {
      logGitee.error('sync FAIL', e);
      result.errors.push(String(e && e.message ? e.message : e));
    }
    return result;
  }

  // Gitee 为按需读取，无需持续轮询；返回空 unsub 以保持接口一致
  watchChanges(_callback: (change: NoteChange) => void): () => void {
    return () => {};
  }

  // ---- 内部辅助 ----

  private fixPath(id: string): string {
    let p = id.endsWith('.md') ? id : id + '.md';
    if (p.charAt(0) !== '/') p = '/' + p;
    return p;
  }

  private async readFileStr(filePath: string): Promise<string> {
    try {
      // 原生 GiteeFS.readFile(path, 'utf8') 返回 string；
      // 经 zen-fs-cache 包装后 CachedFileSystem.readFile(path) 返回 Uint8Array，
      // 这里同时兼容两种返回值。
      const raw: unknown = await this.fs.readFile(filePath, 'utf8');
      if (typeof raw === 'string') return raw;
      if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
      if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
      return String(raw);
    } catch {
      // 兜底：底层 read（极少数情况下 readFile 未混入实例）
      try {
        const st = await this.fs.stat(filePath);
        const buf = new Uint8Array(st.size);
        await this.fs.read(filePath, buf, 0, st.size);
        return new TextDecoder().decode(buf);
      } catch {
        return '';
      }
    }
  }

  /**
   * 判断路径是否为目录。
   *
   * **注意**：不能用 `stat()` 的返回值判断。zen-fs-gitee 的 `stat()` 返回的是
   * `@zenfs/core` 的 `Inode`（只有 `mode` / `size` 等字段，**既没有 `type`
   * 也没有 `isDirectory()`**），因此 `st.type === 'dir'` 恒为 false ——
   * 这正是子目录一直递归不进去、所有笔记都落在 `/未分类` 的根因。
   *
   * 改用「readdir 试探」：GiteeFS 的 readdir 走本地索引，**零网络**；
   * 对普通文件会立即抛 ENOTDIR，对不存在的路径抛 ENOENT。相比 stat 还有个
   * 额外好处 —— 不会触发 GiteeFS.stat() 里的 mtime 解析（开启
   * `useCommitTimeAsMtime` 时，每个文件要额外打一次 Gitee Commits API）。
   */
  private async isDir(p: string): Promise<boolean> {
    try {
      const names = await this.fs.readdir(p);
      return Array.isArray(names);
    } catch {
      return false;
    }
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: string[] = [];
    try {
      entries = await this.fs.readdir(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = dir === '/' ? '/' + e : dir + '/' + e;
      // .md 一定是笔记文件，不必再做目录探测（省一次 readdir 调用）
      if (String(e).endsWith('.md')) {
        out.push(p);
        continue;
      }
      if (await this.isDir(p)) out.push(...(await this.walk(p)));
    }
    return out;
  }

  private async fileToNote(filePath: string): Promise<SidebarNote | null> {
    try {
      const raw = await this.readFileStr(filePath);
      const { data, content } = parseFrontmatter(raw);
      // 去掉仓库根前缀与 .md 后缀，得到与 GitProvider 一致的 _id（无前导斜杠、带 .md）
      const rel = filePath.charAt(0) === '/' ? filePath.slice(1) : filePath;
      return {
        _id: rel,
        title: data.title || rel,
        content,
        path: data.path || '/' + (rel.split('/').slice(0, -1).join('/') || '未分类'),
        tags: Array.isArray(data.tags) ? data.tags : [],
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async indexNotes(): Promise<SidebarNote[]> {
    if (!this.fs) return [];
    const files = await this.walk('/');
    const notes = (await Promise.all(files.map((f) => this.fileToNote(f)))).filter(
      Boolean,
    ) as SidebarNote[];
    this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
    return notes;
  }
}

/** 模块级缓存：按 owner/repo/branch/token(前8位) 复用已就绪的 GiteeFS 实例 */
const giteeCache = new Map<string, any>();

function giteeCacheKey(config: ProviderConfig): string {
  const g = config.gitee;
  return [
    g?.owner || '',
    g?.repo || '',
    g?.branch || 'master',
    (g?.token || '').slice(0, 8),
  ].join('|');
}

/**
 * 用 zen-fs-cache 的 {@link CachedFileSystem} 包装 GiteeFS 实例。
 *
 * GiteeFS 已实现 `getRevision()` —— 返回 git blob SHA，取自 init 时一次性拉取
 * 的 tree，**零网络**。CachedFileSystem 用它做精确校验：
 * - `readFile`：SHA 未变 → 直接返回 IndexedDB 里的字节，不下载
 * - `stat`：SHA 未变 → 直接返回缓存的 inode，跳过 GiteeFS.stat() 里那个每个
 *   文件一次的 Commits API 请求（即「等所有 commit 过一遍」的来源）
 * - `writeFile` 后按新 revision 就地更新缓存，下次读取不再回源
 *
 * CachedFileSystem 只实现了文件系统方法的一个子集（缺 GiteeFS 专有的
 * `sync` / `shouldSync` / `createSnapshot` / `preloadContents` / `getFileSha`
 * 等），因此用 Proxy 把未缓存的成员回落到原始实例，保证既有能力不丢失。
 *
 * 任何异常都安全降级为不缓存的原实例 —— 缓存只是加速手段，不应导致库不可用。
 */
async function wrapGiteeCache(
  inner: any,
  config: NonNullable<ProviderConfig['gitee']>,
  cacheKey: string,
): Promise<any> {
  const mode = config.cache === undefined ? 'idb' : config.cache;
  if (!mode) return inner;
  try {
    // 动态导入：zen-fs-cache 由使用方提供（未能解析时静默降级）
    const mod: any = await import('zen-fs-cache');
    const { CachedFileSystem, IdbCacheStore, MemoryCacheStore } = mod;
    if (typeof CachedFileSystem !== 'function') return inner;

    const store =
      mode === 'memory'
        ? new MemoryCacheStore()
        : new IdbCacheStore(`note-core:gitee:${cacheKey}:`);
    if (typeof store.purgeKeepFiles === 'function') {
      // 清理旧版本缓存下来的 Git `.keep` 占位文件
      await store.purgeKeepFiles().catch(() => {});
    }
    const cached = new CachedFileSystem(inner, store, { ttlMs: 0 });
    logGitee.log('zen-fs-cache enabled', { mode, ttlMs: 0 });

    return new Proxy(inner, {
      get(target, prop, _receiver) {
        const hit = (cached as any)[prop];
        if (typeof hit === 'function') return hit.bind(cached);
        const own = Reflect.get(target, prop, target);
        return typeof own === 'function' ? own.bind(target) : own;
      },
      has(target, prop) {
        return Reflect.has(cached as object, prop) || Reflect.has(target, prop);
      },
    });
  } catch (e) {
    logGitee.log('zen-fs-cache unavailable, fallback to raw GiteeFS', e);
    return inner;
  }
}
