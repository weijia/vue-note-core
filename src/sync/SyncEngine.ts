import { NotebookProvider, ProviderConfig, SyncResult, SidebarNote } from '../types';
import { PouchDBProvider } from '../providers/PouchDBProvider';
import { createProvider } from '../providers/factory';
import { logSync } from '../debug';

export type SyncDirection = 'push' | 'pull' | 'both';

export type ProgressFn = (current: number, total: number, message: string) => void;

/**
 * 本地(PouchDB) <-> 远端(git/webdav/pouchdb) 双向同步引擎。
 *
 * 设计要点：
 * - 失败不阻塞本地使用，所有错误收集到 SyncResult.errors
 * - 冲突策略：last-write-wins，比较 updatedAt 时间戳
 * - 通过 onProgress 上报进度
 */
export class SyncEngine {
  private local: PouchDBProvider;
  private config: ProviderConfig;
  private onProgress?: ProgressFn;
  private remote: NotebookProvider | null = null;
  private remoteName: string;

  constructor(
    localProvider: PouchDBProvider,
    config: ProviderConfig,
    onProgress?: ProgressFn,
  ) {
    this.local = localProvider;
    this.config = config;
    this.onProgress = onProgress;
    this.remoteName = (localProvider.name || 'local') + '-remote';
  }

  private async getRemote(): Promise<NotebookProvider> {
    if (this.remote) return this.remote;
    let type: 'git' | 'webdav' | 'pouchdb' = 'webdav';
    if (this.config.git) type = 'git';
    else if (this.config.pouchdb) type = 'pouchdb';
    else if (this.config.webdav) type = 'webdav';
    logSync.log('getRemote', { type, name: this.remoteName });
    const remote = createProvider(type, this.remoteName, this.config);
    await remote.init(this.config);
    this.remote = remote;
    return remote;
  }

  async push(): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
    try {
      const remote = await this.getRemote();
      const localNotes = await this.local.listNotes();
      const remoteNotes = await remote.listNotes().catch(() => [] as SidebarNote[]);
      const remoteMap = new Map(remoteNotes.map((n) => [n._id, n]));
      logSync.log('push START', { local: localNotes.length, remote: remoteNotes.length });

      const total = localNotes.length;
      let cur = 0;
      for (const note of localNotes) {
        cur++;
        this.onProgress?.(cur, total, '推送: ' + note.title);
        const r = remoteMap.get(note._id);
        const localTs = note.updatedAt || 0;
        if (!r) {
          await remote.saveNote(note);
          result.pushed++;
        } else {
          const remoteTs = r.updatedAt || 0;
          if (localTs > remoteTs) {
            await remote.saveNote(note);
            result.pushed++;
          } else if (localTs < remoteTs) {
            // 远端更新，本地较旧 -> 冲突（不覆盖远端）
            result.conflicts++;
            logSync.warn('push CONFLICT 远端较新，已跳过', {
              id: note._id,
              localTs,
              remoteTs,
            });
          }
          // 相等则跳过
        }
      }
      logSync.log('push DONE', result);
    } catch (e: any) {
      logSync.error('push FAIL', e);
      result.errors.push(String(e && e.message ? e.message : e));
    }
    return result;
  }

  async pull(): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
    try {
      const remote = await this.getRemote();
      const remoteNotes = await remote.listNotes();
      const localNotes = await this.local.listNotes().catch(() => [] as SidebarNote[]);
      const localMap = new Map(localNotes.map((n) => [n._id, n]));
      logSync.log('pull START', { remote: remoteNotes.length, local: localNotes.length });

      const total = remoteNotes.length;
      let cur = 0;
      for (const note of remoteNotes) {
        cur++;
        this.onProgress?.(cur, total, '拉取: ' + note.title);
        const l = localMap.get(note._id);
        const remoteTs = note.updatedAt || 0;
        if (!l) {
          await this.local.saveNote(note);
          result.pulled++;
        } else {
          const localTs = l.updatedAt || 0;
          if (remoteTs > localTs) {
            await this.local.saveNote(note);
            result.pulled++;
          } else if (remoteTs < localTs) {
            result.conflicts++;
            logSync.warn('pull CONFLICT 本地较新，已跳过', {
              id: note._id,
              remoteTs,
              localTs,
            });
          }
        }
      }
      logSync.log('pull DONE', result);
    } catch (e: any) {
      logSync.error('pull FAIL', e);
      result.errors.push(String(e && e.message ? e.message : e));
    }
    return result;
  }

  async sync(direction: SyncDirection = 'both'): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
    logSync.log('sync START', direction);
    if (direction === 'push' || direction === 'both') {
      const r = await this.push();
      result.pushed += r.pushed;
      result.conflicts += r.conflicts;
      result.errors.push(...r.errors);
    }
    if (direction === 'pull' || direction === 'both') {
      const r = await this.pull();
      result.pulled += r.pulled;
      result.conflicts += r.conflicts;
      result.errors.push(...r.errors);
    }
    logSync.log('sync DONE', result);
    return result;
  }

  /** 释放远端连接 */
  async destroy(): Promise<void> {
    logSync.log('destroy');
    if (this.remote) {
      await this.remote.destroy().catch(() => undefined);
      this.remote = null;
    }
  }
}
