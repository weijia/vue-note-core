import { ref, Ref } from 'vue';
import {
  NotebookProvider,
  SidebarNote,
  ProviderConfig,
  ProviderInfo,
  NoteChange,
} from './types';
import { createProvider } from './providers/factory';
import { PouchDBProvider } from './providers/PouchDBProvider';
import { SyncEngine, SyncDirection } from './sync/SyncEngine';
import { logNotebook } from './debug';

const PROVIDERS_KEY = 'notebook_providers';
const CURRENT_KEY = 'notebook_current';

function loadProviders(): ProviderInfo[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    return raw ? (JSON.parse(raw) as ProviderInfo[]) : [];
  } catch {
    return [];
  }
}

function saveProviders(list: ProviderInfo[]): void {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export interface UseNotebookReturn {
  providers: Ref<ProviderInfo[]>;
  currentName: Ref<string>;
  currentProvider: Ref<NotebookProvider | null>;
  allNotes: Ref<SidebarNote[]>;
  currentNote: Ref<SidebarNote | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  syncing: Ref<boolean>;
  syncProgress: Ref<string>;
  syncError: Ref<string | null>;

  init(): Promise<void>;
  switchProvider(name: string): Promise<void>;
  createProvider(type: string, name: string, config: ProviderConfig): Promise<void>;
  deleteProvider(name: string): Promise<void>;
  selectNote(id: string): Promise<void>;
  saveCurrentNote(content: string): Promise<void>;
  createNote(path?: string): Promise<void>;
  updateCurrentTags(tags: string[]): Promise<void>;
  deleteNote(id: string): Promise<void>;
  updateNotePath(id: string, newPath: string): Promise<void>;
  updateNoteTags(id: string, tags: string[]): Promise<void>;
  sync(direction?: SyncDirection): Promise<void>;
}

/**
 * Vue 3 组合式函数：管理多 Provider 的笔记本状态与编辑器联动。
 * 仅依赖 vue 的 ref，不引入任何 UI 框架。
 */
export function useNotebook(initialName?: string): UseNotebookReturn {
  const providers: Ref<ProviderInfo[]> = ref([]);
  const currentName: Ref<string> = ref('');
  const currentProvider: Ref<NotebookProvider | null> = ref(null);
  const allNotes: Ref<SidebarNote[]> = ref([]);
  const currentNote: Ref<SidebarNote | null> = ref(null);
  const loading: Ref<boolean> = ref(false);
  const error: Ref<string> = ref('');
  const syncing: Ref<boolean> = ref(false);
  const syncProgress: Ref<string> = ref('');
  const syncError: Ref<string | null> = ref(null);

  let initPromise: Promise<void> | null = null;
  let connecting = false;
  let watchUnsub: (() => void) | null = null;

  async function refreshNotes(): Promise<void> {
    if (!currentProvider.value) return;
    const notes = await currentProvider.value.listNotes();
    allNotes.value = notes;
  }

  async function connect(name: string): Promise<void> {
    if (connecting) {
      logNotebook.warn('connect SKIP 已有连接进行中', name);
      return;
    }
    connecting = true;
    logNotebook.log('connect START', name);
    try {
      const info = providers.value.find((p) => p.name === name);
      if (!info) throw new Error('找不到 provider: ' + name);

      const provider = createProvider(info.type, name, info.config);
      await provider.init(info.config);

      // 先清理旧的订阅，再挂载新的，避免并行多个 changesFeed
      if (watchUnsub) {
        watchUnsub();
        watchUnsub = null;
      }
      currentProvider.value = provider;
      currentName.value = name;
      try {
        localStorage.setItem(CURRENT_KEY, name);
      } catch {
        /* ignore */
      }

      watchUnsub = provider.watchChanges((change: NoteChange) => {
        logNotebook.log('watchChanges 触发', change.type, change.noteId ?? change.note?._id);
        refreshNotes().catch((e) => {
          logNotebook.error('refreshNotes 失败', e);
          error.value = String(e && e.message ? e.message : e);
        });
      });

      await refreshNotes();
      logNotebook.log('connect OK', { name, type: info.type, notes: allNotes.value.length });
    } catch (e: any) {
      logNotebook.error('connect FAIL', name, e);
      throw e;
    } finally {
      connecting = false;
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise;
    logNotebook.log('init START', { initialName });
    initPromise = (async () => {
      loading.value = true;
      error.value = '';
      try {
        providers.value = loadProviders();
        logNotebook.log('已加载 provider 列表', providers.value.map((p) => p.name));
        let name = initialName || '';
        try {
          name = name || localStorage.getItem(CURRENT_KEY) || '';
        } catch {
          /* ignore */
        }
        if (!name && providers.value.length) name = providers.value[0].name;
        if (name) await connect(name);
        else logNotebook.warn('init 完成，但没有可连接的 provider');
      } catch (e: any) {
        logNotebook.error('init FAIL', e);
        error.value = String(e && e.message ? e.message : e);
      } finally {
        loading.value = false;
      }
    })();
    return initPromise;
  }

  async function switchProvider(name: string): Promise<void> {
    logNotebook.log('switchProvider', { from: currentName.value, to: name });
    loading.value = true;
    error.value = '';
    try {
      if (watchUnsub) {
        watchUnsub();
        watchUnsub = null;
      }
      if (currentProvider.value) {
        // 旧 provider.destroy() 完成后再建新连接，不可并行
        await currentProvider.value.destroy();
        currentProvider.value = null;
      }
      await connect(name);
      logNotebook.log('switchProvider OK', name);
    } catch (e: any) {
      logNotebook.error('switchProvider FAIL', name, e);
      error.value = String(e && e.message ? e.message : e);
    } finally {
      loading.value = false;
    }
  }

  async function createProviderFn(
    type: string,
    name: string,
    config: ProviderConfig,
  ): Promise<void> {
    loading.value = true;
    error.value = '';
    let probe: NotebookProvider | null = null;
    // 注意：config 可能含 token / 密码，日志中只输出类型与名称
    logNotebook.log('createProvider START', { type, name });
    try {
      const info: ProviderInfo = { name, type: type as ProviderInfo['type'], config };
      // 先用临时实例验证配置可初始化
      probe = createProvider(type, name, config);
      await probe.init(config);
      logNotebook.log('createProvider 配置校验通过', { type, name });

      const list = providers.value.filter((p) => p.name !== name).concat(info);
      providers.value = list;
      saveProviders(list);
      await switchProvider(name);
    } catch (e: any) {
      logNotebook.error('createProvider FAIL', { type, name }, e);
      error.value = String(e && e.message ? e.message : e);
    } finally {
      // 探针实例的使命已完成，释放
      if (probe) await probe.destroy().catch(() => undefined);
      loading.value = false;
    }
  }

  async function deleteProvider(name: string): Promise<void> {
    if (providers.value.length <= 1) {
      const message = '至少保留一个 provider';
      logNotebook.warn('deleteProvider SKIP', name, message);
      error.value = message;
      return;
    }
    logNotebook.log('deleteProvider', name);
    loading.value = true;
    error.value = '';
    try {
      const list = providers.value.filter((p) => p.name !== name);
      providers.value = list;
      saveProviders(list);
      if (currentName.value === name) {
        await switchProvider(list[0].name);
      }
      logNotebook.log('deleteProvider OK', name);
    } catch (e: any) {
      logNotebook.error('deleteProvider FAIL', name, e);
      error.value = String(e && e.message ? e.message : e);
    } finally {
      loading.value = false;
    }
  }

  async function selectNote(id: string): Promise<void> {
    if (!currentProvider.value) {
      logNotebook.warn('selectNote SKIP 无当前 provider', id);
      return;
    }
    currentNote.value = await currentProvider.value.getNote(id);
    logNotebook.log('selectNote', { id, found: Boolean(currentNote.value) });
  }

  async function saveCurrentNote(content: string): Promise<void> {
    if (!currentProvider.value || !currentNote.value) {
      logNotebook.warn('saveCurrentNote SKIP 无 provider 或无当前笔记');
      return;
    }
    const updated: SidebarNote = {
      ...currentNote.value,
      content,
      updatedAt: Date.now(),
    };
    const saved = await currentProvider.value.saveNote(updated);
    currentNote.value = saved;
    await refreshNotes();
    logNotebook.log('saveCurrentNote OK', { id: saved._id, length: content.length });
  }

  async function createNote(path?: string): Promise<void> {
    if (!currentProvider.value) {
      logNotebook.warn('createNote SKIP 无当前 provider');
      return;
    }
    const note = await currentProvider.value.createNote(path);
    await refreshNotes();
    currentNote.value = note;
    logNotebook.log('createNote OK', { id: note._id, path });
  }

  async function updateCurrentTags(tags: string[]): Promise<void> {
    if (!currentProvider.value || !currentNote.value) {
      logNotebook.warn('updateCurrentTags SKIP 无 provider 或无当前笔记');
      return;
    }
    const updated: SidebarNote = { ...currentNote.value, tags };
    const saved = await currentProvider.value.saveNote(updated);
    currentNote.value = saved;
    await refreshNotes();
    logNotebook.log('updateCurrentTags OK', { id: saved._id, tags });
  }

  async function deleteNote(id: string): Promise<void> {
    if (!currentProvider.value) {
      logNotebook.warn('deleteNote SKIP 无当前 provider');
      return;
    }
    await currentProvider.value.deleteNote(id);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = null;
    }
    await refreshNotes();
    logNotebook.log('deleteNote OK', id);
  }

  async function updateNotePath(id: string, newPath: string): Promise<void> {
    if (!currentProvider.value) {
      logNotebook.warn('updateNotePath SKIP 无当前 provider');
      return;
    }
    const note = await currentProvider.value.getNote(id);
    if (!note) {
      logNotebook.warn('updateNotePath SKIP 笔记不存在', id);
      return;
    }
    const updated: SidebarNote = { ...note, path: newPath };
    const saved = await currentProvider.value.saveNote(updated);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = saved;
    }
    await refreshNotes();
    logNotebook.log('updateNotePath OK', { id, newPath });
  }

  async function updateNoteTags(id: string, tags: string[]): Promise<void> {
    if (!currentProvider.value) {
      logNotebook.warn('updateNoteTags SKIP 无当前 provider');
      return;
    }
    const note = await currentProvider.value.getNote(id);
    if (!note) {
      logNotebook.warn('updateNoteTags SKIP 笔记不存在', id);
      return;
    }
    const updated: SidebarNote = { ...note, tags };
    const saved = await currentProvider.value.saveNote(updated);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = saved;
    }
    await refreshNotes();
    logNotebook.log('updateNoteTags OK', { id, tags });
  }

  async function sync(direction?: SyncDirection): Promise<void> {
    syncing.value = true;
    syncError.value = null;
    syncProgress.value = '';
    logNotebook.log('sync REQUEST', { direction: direction || 'both' });
    try {
      if (!currentProvider.value) {
        const message = '当前没有可用的 provider';
        logNotebook.warn('sync SKIP', message);
        syncError.value = message;
        return;
      }
      if (currentProvider.value.type !== 'pouchdb') {
        // git / gitee 等远端 Provider：直接委托其自身 sync（push/pull 或刷新），
        // 不走 PouchDB SyncEngine。与消费端「同步」按钮调用 provider.sync('both') 行为一致。
        logNotebook.log('sync DELEGATE', currentProvider.value.type);
        const provider = currentProvider.value;
        if (typeof provider.sync === 'function') {
          const r = await provider.sync(direction || 'both');
          await refreshNotes().catch(() => undefined);
          syncError.value = r.errors.length ? r.errors.join('; ') : null;
          syncProgress.value =
            '完成：推送 ' + r.pushed + '，拉取 ' + r.pulled + '，冲突 ' + r.conflicts;
        } else {
          syncError.value = '当前 Provider 不支持直接同步';
        }
        return;
      }
      // 在 providers 列表中寻找一个非 pouchdb 的远端作为同步目标
      const remoteInfo = providers.value.find(
        (p) => p.type !== 'pouchdb' && p.name !== currentName.value,
      );
      if (!remoteInfo) {
        const message = '未找到远端 provider（git / webdav）';
        logNotebook.warn('sync SKIP', message);
        syncError.value = message;
        return;
      }
      logNotebook.log('sync 目标远端', { name: remoteInfo.name, type: remoteInfo.type });
      const engine = new SyncEngine(
        currentProvider.value as PouchDBProvider,
        remoteInfo.config,
        (_c, _t, msg) => {
          syncProgress.value = msg;
        },
      );
      const r = await engine.sync(direction || 'both');
      await refreshNotes().catch(() => undefined);
      syncError.value = r.errors.length ? r.errors.join('; ') : null;
      syncProgress.value =
        '完成：推送 ' + r.pushed + '，拉取 ' + r.pulled + '，冲突 ' + r.conflicts;
      logNotebook.log('sync 结果', r);
      if (r.errors.length) logNotebook.warn('sync 存在错误', r.errors);
    } catch (e: any) {
      logNotebook.error('sync FAIL', e);
      syncError.value = String(e && e.message ? e.message : e);
    } finally {
      syncing.value = false;
    }
  }

  return {
    providers,
    currentName,
    currentProvider,
    allNotes,
    currentNote,
    loading,
    error,
    syncing,
    syncProgress,
    syncError,
    init,
    switchProvider,
    createProvider: createProviderFn,
    deleteProvider,
    selectNote,
    saveCurrentNote,
    createNote,
    updateCurrentTags,
    deleteNote,
    updateNotePath,
    updateNoteTags,
    sync,
  };
}
