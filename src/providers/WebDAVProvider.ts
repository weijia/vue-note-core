import { createClient, WebDAVClient } from 'webdav';
import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
} from '../types';
import { uuid, parseFrontmatter, stringifyFrontmatter, sanitize } from '../utils';
import { logWebDAV } from '../debug';

function trimSlash(s: string): string {
  let r = s || '';
  while (r.length && r.charAt(0) === '/') r = r.slice(1);
  while (r.length && r.charAt(r.length - 1) === '/') r = r.slice(0, -1);
  return r;
}

function stripMd(s: string): string {
  return s.endsWith('.md') ? s.slice(0, -3) : s;
}

/**
 * 基于 webdav 客户端的远程 Provider。
 * 笔记以 rootPath 下的 .md 文件存储（frontmatter + 正文）。
 */
export class WebDAVProvider implements NotebookProvider {
  readonly type = 'webdav' as const;
  readonly name: string;
  private config: ProviderConfig = {};
  private client: WebDAVClient | null = null;
  private rootPath = '/';
  private timer: any = null;
  private known = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  async init(config: ProviderConfig): Promise<void> {
    this.config = config || {};
    const w = this.config.webdav;
    if (!w) throw new Error('WebDAVProvider 缺少 webdav 配置');

    this.client = createClient(w.url, {
      username: w.username,
      password: w.password,
    });
    this.rootPath = trimSlash(w.rootPath || '/') || '/';
    // 连接测试：列出根目录（注意：密码仅用于连接，不进入日志）
    try {
      await this.client.getDirectoryContents(this.rootPath);
    } catch (e: any) {
      logWebDAV.error('init FAIL 连接测试未通过', { url: w.url, rootPath: this.rootPath }, e);
      throw e;
    }
    await this.indexNotes();
    logWebDAV.log('init OK', { name: this.name, url: w.url, rootPath: this.rootPath });
  }

  async destroy(): Promise<void> {
    logWebDAV.log('destroy', this.name);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.client = null;
    this.known = new Map();
  }

  async listNotes(): Promise<SidebarNote[]> {
    return this.indexNotes();
  }

  async getNote(id: string): Promise<SidebarNote | null> {
    return this.fileToNote(this.rootPath + '/' + this.fixId(id));
  }

  async saveNote(note: SidebarNote): Promise<SidebarNote> {
    if (!this.client) throw new Error('WebDAVProvider 尚未初始化: ' + this.name);
    const updated: SidebarNote = { ...note, updatedAt: Date.now() };
    const file = this.rootPath + '/' + this.fixId(updated._id);
    const body = stringifyFrontmatter(
      {
        title: updated.title,
        path: updated.path || '/未分类',
        tags: updated.tags || [],
        updatedAt: updated.updatedAt,
      },
      updated.content,
    );
    await this.client.putFileContents(file, body);
    this.known.set(updated._id, updated.updatedAt || 0);
    logWebDAV.log('saveNote OK', { id: updated._id, file });
    return updated;
  }

  async createNote(path?: string, title?: string): Promise<SidebarNote> {
    if (!this.client) throw new Error('WebDAVProvider 尚未初始化: ' + this.name);
    const dir = trimSlash(path || '/未分类');
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
    const file = this.rootPath + '/' + rel;
    await this.client.putFileContents(
      file,
      stringifyFrontmatter(
        { title: note.title, path: note.path, tags: [], updatedAt: note.updatedAt },
        '',
      ),
    );
    this.known.set(note._id, note.updatedAt || 0);
    logWebDAV.log('createNote OK', { id: note._id, file });
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.client) throw new Error('WebDAVProvider 尚未初始化: ' + this.name);
    const file = this.rootPath + '/' + this.fixId(id);
    await this.client.deleteFile(file).catch(() => undefined);
    this.known.delete(id);
    logWebDAV.log('deleteNote OK', id);
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
            logWebDAV.log('poll change', { type: 'add', id: n._id });
            callback({ type: 'add', note: n });
          } else if (prev !== (n.updatedAt || 0)) {
            logWebDAV.log('poll change', { type: 'update', id: n._id });
            callback({ type: 'update', note: n });
          }
        }
        for (const id of this.known.keys()) {
          if (!map.has(id)) {
            logWebDAV.log('poll change', { type: 'delete', id });
            callback({ type: 'delete', noteId: id });
          }
        }
        this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
      } catch (e: any) {
        // 轮询错误忽略，下次再试；只记录日志方便排查
        logWebDAV.warn('poll ERROR', e);
      }
    }, 5000);
    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  // ---- 内部辅助 ----

  private fixId(id: string): string {
    return id.endsWith('.md') ? id : id + '.md';
  }

  private async listFiles(): Promise<string[]> {
    if (!this.client) return [];
    const res: any = await this.client.getDirectoryContents(this.rootPath, {
      deep: true,
      glob: '*.md',
    });
    const items = Array.isArray(res) ? res : res && res.items ? res.items : [];
    return items
      .filter((i: any) => i && i.type === 'file')
      .map((i: any) => i.filename as string);
  }

  private async fileToNote(filename: string): Promise<SidebarNote | null> {
    if (!this.client) return null;
    try {
      const raw = (await this.client.getFileContents(filename, {
        format: 'text',
      })) as string;
      const { data, content } = parseFrontmatter(raw);
      const id = stripMd(trimSlash(filename.slice(this.rootPath.length)));
      return {
        _id: id,
        title: data.title || id,
        content,
        path: data.path || '/' + (id.split('/').slice(0, -1).join('/') || '未分类'),
        tags: Array.isArray(data.tags) ? data.tags : [],
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async indexNotes(): Promise<SidebarNote[]> {
    if (!this.client) return [];
    const files = await this.listFiles();
    const notes = (
      await Promise.all(files.map((f) => this.fileToNote(f)))
    ).filter(Boolean) as SidebarNote[];
    this.known = new Map(notes.map((n) => [n._id, n.updatedAt || 0]));
    return notes;
  }
}
