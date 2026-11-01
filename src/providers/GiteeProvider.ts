import {
  SidebarNote,
  ProviderConfig,
  NoteChange,
  SyncResult,
} from '../types';
import { FsNotesProvider } from './FsNotesProvider';
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
 * 笔记域逻辑（frontmatter / 目录遍历 / 索引）继承自 FsNotesProvider，
 * 与 AppDataProvider（数据同步组）共享同一套 .md 语义。
 *
 * 注意：@zenfs/core 与 zen-fs-gitee 通过动态 import 引入，并在打包时保持「外置」，
 * 由其消费端（网页 import map 指向已验证的自包含 bundle）提供，
 * 以规避 esm.sh 对这两个包二次转译即崩溃的问题。
 */
export class GiteeProvider extends FsNotesProvider {
  readonly type = 'gitee' as const;

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

  // GiteeFS 每次写已自动提交；sync() 做一次刷新 + 重新索引（拉取远端变更到本地缓存）
  async sync(_direction?: 'push' | 'pull' | 'both'): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
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
