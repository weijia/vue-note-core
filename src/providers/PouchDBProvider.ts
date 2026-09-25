import PouchDB from 'pouchdb-browser';
import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
} from '../types';
import { uuid, safeName } from '../utils';
import { logPouchDB } from '../debug';

interface PouchDoc {
  _id: string;
  _rev?: string;
  type: 'note';
  title: string;
  content: string;
  path?: string;
  tags?: string[];
  updatedAt?: number;
}

/**
 * 基于 PouchDB（浏览器版 pouchdb-browser）的本地 Provider。
 * 每个笔记本一个独立数据库：prefix + encodeURIComponent(name)。
 */
export class PouchDBProvider implements NotebookProvider {
  readonly type = 'pouchdb' as const;
  readonly name: string;
  private db: any = null;
  private changesFeed: any = null;
  private config: ProviderConfig = {};
  private seen = new Set<string>();

  constructor(name: string) {
    this.name = name;
  }

  async init(config: ProviderConfig): Promise<void> {
    this.config = config || {};
    const prefix = this.config.pouchdb?.prefix || 'nb-';
    // Bug 修复：名称含 / 或特殊字符时用 encodeURIComponent，避免静默失败
    const dbName = prefix + safeName(this.name);
    try {
      this.db = new PouchDB(dbName);
      await this.db.info();
      this.seen = new Set();
      logPouchDB.log('init OK', { name: this.name, dbName });
    } catch (e: any) {
      logPouchDB.error('init FAIL', { name: this.name, dbName }, e);
      throw e;
    }
  }

  async destroy(): Promise<void> {
    logPouchDB.log('destroy', this.name);
    // 先取消 live changes，再关闭数据库，最后清理引用
    if (this.changesFeed) {
      try {
        this.changesFeed.cancel();
      } catch {
        /* ignore */
      }
      this.changesFeed = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    this.seen = new Set();
  }

  async listNotes(): Promise<SidebarNote[]> {
    if (!this.db) throw new Error('PouchDBProvider 尚未初始化: ' + this.name);
    const res = await this.db.allDocs({ include_docs: true });
    const notes: SidebarNote[] = [];
    for (const row of res.rows) {
      const doc = row.doc as PouchDoc | undefined;
      if (!doc || doc._id.startsWith('_') || doc.type !== 'note') continue;
      notes.push(this.docToNote(doc));
      this.seen.add(doc._id);
    }
    logPouchDB.log('listNotes', { count: notes.length });
    return notes;
  }

  async getNote(id: string): Promise<SidebarNote | null> {
    if (!this.db) throw new Error('PouchDBProvider 尚未初始化: ' + this.name);
    const doc = (await this.db.get(id).catch(() => null)) as PouchDoc | null;
    if (!doc) logPouchDB.warn('getNote MISS', id);
    return doc ? this.docToNote(doc) : null;
  }

  async saveNote(note: SidebarNote): Promise<SidebarNote> {
    if (!this.db) throw new Error('PouchDBProvider 尚未初始化: ' + this.name);
    const now = Date.now();
    const doc: PouchDoc = {
      _id: note._id,
      type: 'note',
      title: note.title,
      content: note.content,
      path: note.path,
      tags: note.tags,
      updatedAt: now,
    };
    const existing = (await this.db.get(note._id).catch(() => null)) as
      | PouchDoc
      | null;
    if (existing && existing._rev) doc._rev = existing._rev;

    const put = await this.db.put(doc);
    this.seen.add(put.id);
    logPouchDB.log('saveNote OK', { id: put.id, rev: put.rev });
    return { ...note, _id: put.id, updatedAt: now };
  }

  async createNote(path?: string, title?: string): Promise<SidebarNote> {
    const note: SidebarNote = {
      _id: uuid(),
      title: title || '无标题笔记',
      content: '',
      path: path || '/未分类',
      tags: [],
      updatedAt: Date.now(),
    };
    logPouchDB.log('createNote', { id: note._id, path: note.path });
    return this.saveNote(note);
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.db) throw new Error('PouchDBProvider 尚未初始化: ' + this.name);
    const doc = await this.db.get(id);
    await this.db.remove(doc);
    this.seen.delete(id);
    logPouchDB.log('deleteNote OK', id);
  }

  watchChanges(callback: (change: NoteChange) => void): () => void {
    if (!this.db) return () => undefined;
    // 防止并行初始化导致多个 changesFeed 同时运行
    if (this.changesFeed) {
      try {
        this.changesFeed.cancel();
      } catch {
        /* ignore */
      }
      this.changesFeed = null;
    }

    const feed = this.db.changes({ live: true, include_docs: true });
    this.changesFeed = feed;

    feed.on('change', (change: any) => {
      const doc = change.doc as PouchDoc | undefined;
      if (!doc || doc._id.startsWith('_') || doc.type !== 'note') return;
      if (change.deleted) {
        this.seen.delete(doc._id);
        logPouchDB.log('change', { type: 'delete', id: doc._id });
        callback({ type: 'delete', noteId: doc._id });
        return;
      }
      const isNew = !this.seen.has(doc._id);
      this.seen.add(doc._id);
      logPouchDB.log('change', { type: isNew ? 'add' : 'update', id: doc._id });
      callback({ type: isNew ? 'add' : 'update', note: this.docToNote(doc) });
    });

    feed.on('error', (err: any) => {
      // 错误由上层 error ref 捕获，这里只记录日志避免崩溃
      logPouchDB.error('changesFeed ERROR', err);
    });
    logPouchDB.log('watchChanges subscribed', this.name);

    return () => {
      if (this.changesFeed) {
        try {
          this.changesFeed.cancel();
        } catch {
          /* ignore */
        }
        this.changesFeed = null;
      }
    };
  }

  private docToNote(doc: PouchDoc): SidebarNote {
    return {
      _id: doc._id,
      title: doc.title,
      content: doc.content,
      path: doc.path,
      tags: doc.tags,
      updatedAt: doc.updatedAt,
    };
  }
}
