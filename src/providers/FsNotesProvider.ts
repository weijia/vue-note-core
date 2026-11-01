import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
  SyncResult,
} from '../types';
import { parseFrontmatter, stringifyFrontmatter, sanitize } from '../utils';

/**
 * 基于通用 ZenFS 文件系统的笔记域基类。
 *
 * 把「.md + frontmatter = 一条笔记」的领域逻辑（路径规整、frontmatter
 * 编解码、目录遍历、索引）从具体后端实现中抽出，供两类 Provider 复用：
 *
 * - GiteeProvider：自建 GiteeFS（zen-fs-gitee）后挂载
 * - AppDataProvider：注入 zen-fs-config 的 AppDataGroup.fs（数据同步组）
 *
 * 子类职责：
 * 1. `init()` 中完成 `this.fs` 的获取（自建或注入）
 * 2. 可选覆盖 `sync()` / `watchChanges()` 等后端特化行为
 *
 * `this.fs` 只需满足 ZenFS `fs.promises` 风格的鸭子接口：
 * readdir / readFile(path, 'utf8') / writeFile / mkdir / unlink / stat。
 */
export abstract class FsNotesProvider implements NotebookProvider {
  abstract readonly type: NotebookProvider['type'];
  readonly name: string;
  protected config: ProviderConfig = {};
  protected fs: any = null;
  protected known = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  abstract init(config: ProviderConfig): Promise<void>;
  abstract destroy(): Promise<void>;

  async listNotes(): Promise<SidebarNote[]> {
    return this.indexNotes();
  }

  async getNote(id: string): Promise<SidebarNote | null> {
    return this.fileToNote(this.fixPath(id));
  }

  async saveNote(note: SidebarNote): Promise<SidebarNote> {
    if (!this.fs) throw new Error(this.constructor.name + ' 尚未初始化: ' + this.name);
    const updated: SidebarNote = { ...note, updatedAt: Date.now() };
    const filePath = this.fixPath(updated._id);
    // 显式带上 S_IFDIR：部分 ZenFS 后端的 mkdir 会做 `options.mode |= S_IFDIR`，
    // 只传 { recursive } 会让 mode 变成 NaN，导致该目录下的 inode 类型判断失效。
    const mkdirOpts = { recursive: true, mode: 0o40755 };
    const dirOf = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dirOf && dirOf !== '/') {
      try {
        await this.fs.mkdir(dirOf, mkdirOpts);
      } catch {
        /* 目录可能已存在 */
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
    await this.fs.writeFile(filePath, body, 'utf8');
    this.known.set(updated._id, updated.updatedAt || 0);
    return updated;
  }

  async createNote(path?: string, title?: string): Promise<SidebarNote> {
    if (!this.fs) throw new Error(this.constructor.name + ' 尚未初始化: ' + this.name);
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
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.fs) throw new Error(this.constructor.name + ' 尚未初始化: ' + this.name);
    const filePath = this.fixPath(id);
    try {
      await this.fs.unlink(filePath);
    } catch {
      /* 文件可能不存在 */
    }
    this.known.delete(id);
  }

  async sync(_direction?: 'push' | 'pull' | 'both'): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
    await this.indexNotes();
    return result;
  }

  // 默认无变更通知；后端支持时由子类覆盖
  watchChanges(_callback: (change: NoteChange) => void): () => void {
    return () => {};
  }

  // ---- 内部辅助 ----

  protected fixPath(id: string): string {
    let p = id.endsWith('.md') ? id : id + '.md';
    if (p.charAt(0) !== '/') p = '/' + p;
    return p;
  }

  protected async readFileStr(filePath: string): Promise<string> {
    try {
      const raw: unknown = await this.fs.readFile(filePath, 'utf8');
      if (typeof raw === 'string') return raw;
      if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
      if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
      return String(raw);
    } catch {
      // 兜底：底层 read（少数包装层未混入 readFile 时）
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
   * **注意**：不能用 `stat()` 的返回值判断。部分 ZenFS 后端的 `stat()`
   * 返回 `@zenfs/core` 的 `Inode`（只有 mode / size 等字段，既没有
   * `type` 也没有 `isDirectory()`）。
   *
   * 改用「readdir 试探」：对普通文件立即抛 ENOTDIR，对不存在路径抛
   * ENOENT；走本地索引时零网络。
   */
  protected async isDir(p: string): Promise<boolean> {
    try {
      const names = await this.fs.readdir(p);
      return Array.isArray(names);
    } catch {
      return false;
    }
  }

  protected async walk(dir: string): Promise<string[]> {
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

  protected async fileToNote(filePath: string): Promise<SidebarNote | null> {
    try {
      const raw = await this.readFileStr(filePath);
      const { data, content } = parseFrontmatter(raw);
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

  protected async indexNotes(): Promise<SidebarNote[]> {
    if (!this.fs) return [];
    const files = await this.walk('/');
    const notes = (await Promise.all(files.map((f) => this.fileToNote(f)))).filter(
      Boolean,
    ) as SidebarNote[];
    this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
    return notes;
  }
}
