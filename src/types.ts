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
    /** Gitee 等平台需要 用户名 + 私人令牌（password 字段）鉴权时使用 */
    username?: string;
    /** gitee.com / github.com 等不返回 CORS 头的平台需要的代理地址 */
    corsProxy?: string;
    /** 浏览器内 lightning-fs 的工作目录，缺省按 name 自动生成 */
    localPath?: string;
  };
  /** Gitee 文档库配置（走 zen-fs-gitee，Gitee REST API v5，无需 git 智能 HTTP / CORS 代理） */
  gitee?: {
    owner: string;
    repo: string;
    branch?: string;
    token?: string;
    /** 直接用 Gitee commit 时间作为文件 mtime，跳过 .mtime 边车探测（缺省 false，由 zen-fs-gitee@1.2.33+ 支持） */
    useCommitTimeAsMtime?: boolean;
    /**
     * 是否用 zen-fs-cache 的 CachedFileSystem 包装 GiteeFS（缺省 'idb'）：
     * - 'idb'    ：IndexedDB 持久化，跨刷新直接从本地返回未变更的文件
     * - 'memory' ：仅本次会话内缓存
     * - false    ：不包装，每次都走 zen-fs-gitee（其内部仍有自己的 IDB 缓存）
     *
     * 校验依据是 GiteeFS.getRevision() 返回的 git blob SHA（零网络），
     * 因此命中缓存时既不下载内容、也不请求 mtime/Commits API。
     */
    cache?: 'idb' | 'memory' | false;
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
  type: 'pouchdb' | 'git' | 'webdav' | 'gitee';
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
  readonly type: 'pouchdb' | 'git' | 'webdav' | 'gitee';
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
