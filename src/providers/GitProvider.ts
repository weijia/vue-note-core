import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import FS from '@isomorphic-git/lightning-fs';
import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
} from '../types';
import { uuid, parseFrontmatter, stringifyFrontmatter, sanitize } from '../utils';
import { logGit } from '../debug';

/**
 * 基于 isomorphic-git + lightning-fs 的浏览器内 Git Provider。
 * 每个笔记本对应一个本地 git 仓库，笔记以 .md 文件存储（frontmatter + 正文）。
 */
export class GitProvider implements NotebookProvider {
  readonly type = 'git' as const;
  readonly name: string;
  private config: ProviderConfig = {};
  private fs: any = null;
  private dir = '';
  private timer: any = null;
  private known = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  async init(config: ProviderConfig): Promise<void> {
    this.config = config || {};
    const g = this.config.git;
    if (!g) throw new Error('GitProvider 缺少 git 配置');
    if (!this.fs) {
      // 每个笔记本独立的 lightning-fs 实例，避免互相污染
      this.fs = new FS('note-core-' + encodeURIComponent(this.name));
    }
    this.dir = g.localPath || '/notebooks/' + encodeURIComponent(this.name);
    try {
      await this.fs.mkdir(this.dir, { recursive: true });
    } catch {
      /* 目录可能已存在 */
    }

    const isRepo = await this.fs
      .stat(this.dir + '/.git')
      .then(() => true)
      .catch(() => false);

    if (!isRepo) {
      if (g.repoUrl) {
        logGit.log('clone START', { url: g.repoUrl, branch: g.branch || 'main' });
        try {
          await git.clone({
            fs: this.fs,
            http,
            dir: this.dir,
            url: g.repoUrl,
            ref: g.branch || 'main',
            singleBranch: true,
            // GitHub 只需 token（username 填占位 'token'）；Gitee 需要 用户名 + 私人令牌
            onAuth: g.token
              ? () => ({ username: g.username || 'token', password: g.token })
              : undefined,
            corsProxy: g.corsProxy || undefined,
          });
          logGit.log('clone OK', g.repoUrl);
        } catch (e: any) {
          logGit.error('clone FAIL', g.repoUrl, e);
          throw e;
        }
      } else {
        await git.init({ fs: this.fs, dir: this.dir });
        logGit.log('init repo OK', this.dir);
        if (g.repoUrl) {
          await git.addRemote({
            fs: this.fs,
            dir: this.dir,
            remote: 'origin',
            url: g.repoUrl,
          });
          logGit.log('addRemote OK', g.repoUrl);
        }
      }
    } else {
      logGit.log('reuse existing repo', this.dir);
    }
    await this.indexNotes();
    logGit.log('init OK', { name: this.name, dir: this.dir });
  }

  async destroy(): Promise<void> {
    logGit.log('destroy', this.name);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.fs = null;
    this.known = new Map();
  }

  async listNotes(): Promise<SidebarNote[]> {
    return this.indexNotes();
  }

  async getNote(id: string): Promise<SidebarNote | null> {
    return this.fileToNote(this.dir + '/' + this.fixId(id));
  }

  async saveNote(note: SidebarNote): Promise<SidebarNote> {
    if (!this.fs) throw new Error('GitProvider 尚未初始化: ' + this.name);
    const updated: SidebarNote = { ...note, updatedAt: Date.now() };
    const file = this.dir + '/' + this.fixId(updated._id);
    const dirOf = file.slice(0, file.lastIndexOf('/'));
    try {
      await this.fs.mkdir(dirOf, { recursive: true });
    } catch {
      /* ignore */
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
    await this.fs.writeFile(file, body);
    await this.commit('update ' + updated._id);
    this.known.set(updated._id, updated.updatedAt || 0);
    logGit.log('saveNote OK', { id: updated._id, file });
    return updated;
  }

  async createNote(path?: string, title?: string): Promise<SidebarNote> {
    if (!this.fs) throw new Error('GitProvider 尚未初始化: ' + this.name);
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
    const file = this.dir + '/' + rel;
    const dirOf = file.slice(0, file.lastIndexOf('/'));
    try {
      await this.fs.mkdir(dirOf, { recursive: true });
    } catch {
      /* ignore */
    }
    await this.fs.writeFile(
      file,
      stringifyFrontmatter(
        { title: note.title, path: note.path, tags: [], updatedAt: note.updatedAt },
        '',
      ),
    );
    await this.commit('create ' + rel);
    this.known.set(note._id, note.updatedAt || 0);
    logGit.log('createNote OK', { id: note._id, file });
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.fs) throw new Error('GitProvider 尚未初始化: ' + this.name);
    const file = this.dir + '/' + this.fixId(id);
    await this.fs.unlink(file).catch(() => undefined);
    await this.commit('delete ' + id);
    this.known.delete(id);
    logGit.log('deleteNote OK', id);
  }

  watchChanges(callback: (change: NoteChange) => void): () => void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(async () => {
      try {
        const notes = await this.indexNotes();
        const map = new Map(notes.map((n) => [n._id, n]));
        for (const n of notes) {
          const prev = this.known.get(n._id);
          if (prev === undefined) {
            logGit.log('poll change', { type: 'add', id: n._id });
            callback({ type: 'add', note: n });
          } else if (prev !== (n.updatedAt || 0)) {
            logGit.log('poll change', { type: 'update', id: n._id });
            callback({ type: 'update', note: n });
          }
        }
        for (const id of this.known.keys()) {
          if (!map.has(id)) {
            logGit.log('poll change', { type: 'delete', id });
            callback({ type: 'delete', noteId: id });
          }
        }
        this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
      } catch (e: any) {
        // 轮询错误忽略，下次再试；只记录日志方便排查
        logGit.warn('poll ERROR', e);
      }
    }, 3000);
    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** 可选：直接 fetch/pull + push（主同步仍推荐走 SyncEngine） */
  async sync(direction: 'push' | 'pull' | 'both' = 'both'): Promise<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: string[];
  }> {
    const result = { pushed: 0, pulled: 0, conflicts: 0, errors: [] as string[] };
    const g = this.config.git;
    if (!g || !g.repoUrl) {
      const message = 'GitProvider 未配置 repoUrl，无法同步';
      logGit.warn('sync SKIP', message);
      result.errors.push(message);
      return result;
    }
    logGit.log('sync START', { direction, url: g.repoUrl, branch: g.branch || 'main' });
    const onAuth = g.token
      ? () => ({ username: g.username || 'token', password: g.token })
      : undefined;
    const corsProxy = g.corsProxy || undefined;
    const branch = g.branch || 'main';
    try {
      if (direction === 'pull' || direction === 'both') {
        await git.pull({
          fs: this.fs,
          http,
          dir: this.dir,
          ref: branch,
          singleBranch: true,
          onAuth,
          corsProxy,
        });
        result.pulled++;
      }
      if (direction === 'push' || direction === 'both') {
        await git.push({ fs: this.fs, http, dir: this.dir, ref: branch, onAuth, corsProxy });
        result.pushed++;
      }
    } catch (e: any) {
      logGit.error('sync FAIL', e);
      result.errors.push(String(e && e.message ? e.message : e));
    }
    logGit.log('sync DONE', result);
    return result;
  }

  // ---- 内部辅助 ----

  private fixId(id: string): string {
    return id.endsWith('.md') ? id : id + '.md';
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: any[] = [];
    try {
      entries = await this.fs.readdir(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = dir + '/' + e;
      let st: any;
      try {
        st = await this.fs.stat(p);
      } catch {
        continue;
      }
      if (st.type === 'dir') out.push(...(await this.walk(p)));
      else if (String(e).endsWith('.md')) out.push(p);
    }
    return out;
  }

  private async fileToNote(filePath: string): Promise<SidebarNote | null> {
    try {
      const raw = await this.fs.readFile(filePath, 'utf8');
      const { data, content } = parseFrontmatter(raw);
      const rel = filePath.slice(this.dir.length + 1);
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
    const files = await this.walk(this.dir);
    const notes = (
      await Promise.all(files.map((f) => this.fileToNote(f)))
    ).filter(Boolean) as SidebarNote[];
    this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
    return notes;
  }

  private async commit(message: string): Promise<void> {
    try {
      await git.add({ fs: this.fs, dir: this.dir, filepath: '.' });
      await git.commit({
        fs: this.fs,
        dir: this.dir,
        message,
        author: { name: 'note-core', email: 'note-core@local' },
      });
      logGit.log('commit OK', message);
    } catch (e: any) {
      logGit.error('commit FAIL', message, e);
      throw e;
    }
  }
}
