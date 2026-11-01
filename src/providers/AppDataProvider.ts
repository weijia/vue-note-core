import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  NoteChange,
  SyncResult,
} from '../types';
import { FsNotesProvider } from './FsNotesProvider';
import { logProvider } from '../debug';

/**
 * 挂载 zen-fs-config「数据同步组」（AppDataGroup）的笔记本 Provider。
 *
 * 一个数据同步组 = 一个笔记本：组内本地主后端与各远端副本（Gitee /
 * GitHub / RemoteStorage / WebDAV…）由 zen-fs-config 自动双向同步，
 * 本 Provider 只读写组的 fs，不感知组内有几个后端。
 *
 * fs 实例**不进入 ProviderConfig**（config 需可序列化进 localStorage），
 * 而是由消费端在 `nb.init()` 之前通过 {@link registerAppDataFS} 注入：
 *
 * ```ts
 * import { registerAppDataFS } from '@richard432/note-core';
 * const { repo } = await connect('onenav-notebook');
 * const group = await repo.getAppDataGroup('my-notes');
 * registerAppDataFS('onenav-notebook', 'my-notes', group);
 * // 之后 createProvider('appdata', '我的笔记', { appdata: { appId, groupId } })
 * ```
 *
 * handle 为鸭子类型（不 import zen-fs-config，保持本库零新增依赖）：
 * - `fs`：组根的 chroot fs（必填）
 * - `flush?()`：手动触发组内全部同步（供 sync() 转发）
 * - `onChange?(cb)`：变更回调（供 watchChanges 桥接）
 * - `dispose?()`：释放
 */

/** zen-fs-config AppDataGroup 的鸭子类型句柄 */
export interface AppDataFSHandle {
  fs: any;
  flush?(): Promise<unknown>;
  onChange?(callback: () => void): unknown;
  dispose?(): Promise<void>;
}

/** 模块级注册表：`appId/groupId` → 组句柄 */
const appDataRegistry = new Map<string, AppDataFSHandle>();

/**
 * 注入一个数据同步组供 'appdata' Provider 使用。
 * 返回取消注册函数。
 */
export function registerAppDataFS(
  appId: string,
  groupId: string,
  handle: AppDataFSHandle,
): () => void {
  if (!appId || !groupId) {
    throw new Error('registerAppDataFS: appId 与 groupId 不能为空');
  }
  if (!handle || !handle.fs) {
    throw new Error('registerAppDataFS: handle.fs 不能为空');
  }
  appDataRegistry.set(appDataKey(appId, groupId), handle);
  logProvider.log('registerAppDataFS', { appId, groupId });
  return () => {
    // 仅在未被覆盖时移除（避免覆盖注册后又被旧句柄反注册）
    if (appDataRegistry.get(appDataKey(appId, groupId)) === handle) {
      appDataRegistry.delete(appDataKey(appId, groupId));
    }
  };
}

/** 查询已注册的数据同步组句柄（测试 / 调试用） */
export function getAppDataFS(appId: string, groupId: string): AppDataFSHandle | undefined {
  return appDataRegistry.get(appDataKey(appId, groupId));
}

function appDataKey(appId: string, groupId: string): string {
  return appId + '/' + groupId;
}

export class AppDataProvider extends FsNotesProvider {
  readonly type = 'appdata' as const;
  private handle: AppDataFSHandle | null = null;
  private changeUnsub: (() => void) | null = null;
  private changeListener: ((change: NoteChange) => void) | null = null;
  /** 变更轮询定时器（AppDataGroup 无推送时的兜底） */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async init(config: ProviderConfig): Promise<void> {
    this.config = config || {};
    const a = this.config.appdata;
    if (!a || !a.appId || !a.groupId) {
      throw new Error('appdata 配置不完整：缺少 appId / groupId');
    }
    const handle = appDataRegistry.get(appDataKey(a.appId, a.groupId));
    if (!handle) {
      throw new Error(
        `未注册的数据同步组：appId="${a.appId}" groupId="${a.groupId}"。` +
        '请先调用 registerAppDataFS(appId, groupId, group) 注入。',
      );
    }
    this.handle = handle;
    this.fs = handle.fs;
    this.known = new Map();
    await this.indexNotes();
    logProvider.log('appdata init OK', { name: this.name, appId: a.appId, groupId: a.groupId });
  }

  async destroy(): Promise<void> {
    logProvider.log('appdata destroy', this.name);
    // 不 dispose 组句柄：可能被其他 provider / 页面共享；
    // 组生命周期由消费端（zen-fs-config 连接层）管理。
    this.stopWatch();
    this.handle = null;
    this.fs = null;
    this.known = new Map();
  }

  /** 转发组的手动同步；重新索引拿到拉取结果 */
  async sync(direction?: 'push' | 'pull' | 'both'): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
    try {
      if (this.handle && typeof this.handle.flush === 'function') {
        await this.handle.flush();
        result.pushed++;
      }
      await this.indexNotes();
      result.pulled++;
    } catch (e: any) {
      result.errors.push(String(e && e.message ? e.message : e));
    }
    return result;
  }

  /**
   * 变更通知：优先桥接组的 onChange（若句柄支持）；否则启用轮询兜底
   * （默认 5s 比对一次笔记索引，远端同步进来的变更会体现在列表里）。
   */
  watchChanges(callback: (change: NoteChange) => void): () => void {
    this.changeListener = callback;
    if (this.handle && typeof this.handle.onChange === 'function') {
      try {
        const unsub = this.handle.onChange(() => this.fireChange());
        this.changeUnsub = typeof unsub === 'function' ? (unsub as () => void) : null;
        if (this.changeUnsub) return this.changeUnsub;
      } catch {
        /* 桥接失败 → 走轮询兜底 */
      }
    }
    this.startPolling();
    return () => this.stopWatch();
  }

  private fireChange(): void {
    if (this.changeListener) {
      this.changeListener({ type: 'update' });
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      if (!this.fs) return;
      try {
        const notes = await this.indexNotes();
        // 任一笔记的 mtime 与上次索引不一致 → 通知重拉列表
        const changed = notes.some(
          (n: SidebarNote) => (this.known.get(n._id) ?? -1) !== (n.updatedAt || 0),
        ) || notes.length !== this.known.size;
        if (changed) this.fireChange();
      } catch {
        /* 网络抖动等 → 忽略本轮 */
      }
    }, 5000);
  }

  private stopWatch(): void {
    if (this.changeUnsub) {
      try { this.changeUnsub(); } catch { /* ignore */ }
      this.changeUnsub = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
