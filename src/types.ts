/**
 * 笔记核心公共类型定义
 */

/** 一条笔记的精简数据结构，用于侧边栏 / 列表展示与同步传输 */
export interface SidebarNote {
  /** 唯一标识。PouchDB 场景为 uuid；Git/WebDAV 场景为相对文件路径（含 .md） */
  _id: string;
  title: string;
  content: string;
  /** 笔记本内的目录路径，如 "/未分类" */
  path?: string;
  tags?: string[];
  /** 最后更新时间戳（毫秒），用于冲突比较（last-write-wins） */
  updatedAt?: number;
}

/** 各 Provider 的配置。不同 type 只需填写对应子项 */
export interface ProviderConfig {
  pouchdb?: { prefix?: string };
  git?: {
    repoUrl: string;
    branch?: string;
    token?: string;
    /** 浏览器内 lightning-fs 的工作目录，缺省按 name 自动生成 */
    localPath?: string;
  };
  webdav?: {
    url: string;
    username: string;
    password: string;
    rootPath?: string;
  };
}

/** 持久化在 localStorage 的 Provider 元信息 */
export interface ProviderInfo {
  name: string;
  type: 'pouchdb' | 'git' | 'webdav';
  config: ProviderConfig;
}

/** 一条笔记变更事件 */
export interface NoteChange {
  type: 'add' | 'update' | 'delete';
  note?: SidebarNote;
  noteId?: string;
}

/** 一次同步的结果汇总 */
export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

/** 所有 Provider 实现需要遵循的统一接口 */
export interface NotebookProvider {
  readonly type: 'pouchdb' | 'git' | 'webdav';
  readonly name: string;
  init(config: ProviderConfig): Promise<void>;
  destroy(): Promise<void>;
  listNotes(): Promise<SidebarNote[]>;
  getNote(id: string): Promise<SidebarNote | null>;
  saveNote(note: SidebarNote): Promise<SidebarNote>;
  createNote(path?: string, title?: string): Promise<SidebarNote>;
  deleteNote(id: string): Promise<void>;
  /** 订阅变更，返回取消订阅函数 */
  watchChanges(callback: (change: NoteChange) => void): () => void;
  /** 远端 Provider 可借此直接 fetch/push（可选，主同步走 SyncEngine） */
  sync?(direction?: 'push' | 'pull' | 'both'): Promise<SyncResult>;
}
