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
    if (connecting) return;
    connecting = true;
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

      watchUnsub = provider.watchChanges((_change: NoteChange) => {
        refreshNotes().catch((e) => {
          error.value = String(e && e.message ? e.message : e);
        });
      });

      await refreshNotes();
    } finally {
      connecting = false;
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      loading.value = true;
      error.value = '';
      try {
        providers.value = loadProviders();
        let name = initialName || '';
        try {
          name = name || localStorage.getItem(CURRENT_KEY) || '';
        } catch {
          /* ignore */
        }
        if (!name && providers.value.length) name = providers.value[0].name;
        if (name) await connect(name);
      } catch (e: any) {
        error.value = String(e && e.message ? e.message : e);
      } finally {
        loading.value = false;
      }
    })();
    return initPromise;
  }

  async function switchProvider(name: string): Promise<void> {
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
    } catch (e: any) {
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
    try {
      const info: ProviderInfo = { name, type: type as ProviderInfo['type'], config };
      // 先用临时实例验证配置可初始化
      probe = createProvider(type, name, config);
      await probe.init(config);

      const list = providers.value.filter((p) => p.name !== name).concat(info);
      providers.value = list;
      saveProviders(list);
      await switchProvider(name);
    } catch (e: any) {
      error.value = String(e && e.message ? e.message : e);
    } finally {
      // 探针实例的使命已完成，释放
      if (probe) await probe.destroy().catch(() => undefined);
      loading.value = false;
    }
  }

  async function deleteProvider(name: string): Promise<void> {
    if (providers.value.length <= 1) {
      error.value = '至少保留一个 provider';
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      const list = providers.value.filter((p) => p.name !== name);
      providers.value = list;
      saveProviders(list);
      if (currentName.value === name) {
        await switchProvider(list[0].name);
      }
    } catch (e: any) {
      error.value = String(e && e.message ? e.message : e);
    } finally {
      loading.value = false;
    }
  }

  async function selectNote(id: string): Promise<void> {
    if (!currentProvider.value) return;
    currentNote.value = await currentProvider.value.getNote(id);
  }

  async function saveCurrentNote(content: string): Promise<void> {
    if (!currentProvider.value || !currentNote.value) return;
    const updated: SidebarNote = {
      ...currentNote.value,
      content,
      updatedAt: Date.now(),
    };
    const saved = await currentProvider.value.saveNote(updated);
    currentNote.value = saved;
    await refreshNotes();
  }

  async function createNote(path?: string): Promise<void> {
    if (!currentProvider.value) return;
    const note = await currentProvider.value.createNote(path);
    await refreshNotes();
    currentNote.value = note;
  }

  async function updateCurrentTags(tags: string[]): Promise<void> {
    if (!currentProvider.value || !currentNote.value) return;
    const updated: SidebarNote = { ...currentNote.value, tags };
    const saved = await currentProvider.value.saveNote(updated);
    currentNote.value = saved;
    await refreshNotes();
  }

  async function deleteNote(id: string): Promise<void> {
    if (!currentProvider.value) return;
    await currentProvider.value.deleteNote(id);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = null;
    }
    await refreshNotes();
  }

  async function updateNotePath(id: string, newPath: string): Promise<void> {
    if (!currentProvider.value) return;
    const note = await currentProvider.value.getNote(id);
    if (!note) return;
    const updated: SidebarNote = { ...note, path: newPath };
    const saved = await currentProvider.value.saveNote(updated);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = saved;
    }
    await refreshNotes();
  }

  async function updateNoteTags(id: string, tags: string[]): Promise<void> {
    if (!currentProvider.value) return;
    const note = await currentProvider.value.getNote(id);
    if (!note) return;
    const updated: SidebarNote = { ...note, tags };
    const saved = await currentProvider.value.saveNote(updated);
    if (currentNote.value && currentNote.value._id === id) {
      currentNote.value = saved;
    }
    await refreshNotes();
  }

  async function sync(direction?: SyncDirection): Promise<void> {
    syncing.value = true;
    syncError.value = null;
    syncProgress.value = '';
    try {
      if (!currentProvider.value) {
        syncError.value = '当前没有可用的 provider';
        return;
      }
      if (currentProvider.value.type !== 'pouchdb') {
        syncError.value = 'SyncEngine 需要本地 PouchDB provider 作为同步源';
        return;
      }
      // 在 providers 列表中寻找一个非 pouchdb 的远端作为同步目标
      const remoteInfo = providers.value.find(
        (p) => p.type !== 'pouchdb' && p.name !== currentName.value,
      );
      if (!remoteInfo) {
        syncError.value = '未找到远端 provider（git / webdav）';
        return;
      }
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
    } catch (e: any) {
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
