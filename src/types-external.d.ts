// 为缺少官方类型的运行时依赖提供最小类型声明，避免编译报错。
declare module 'pouchdb-browser' {
  const PouchDB: any;
  export default PouchDB;
}

declare module 'isomorphic-git/http/web' {
  const http: any;
  export = http;
}

declare module '@isomorphic-git/lightning-fs' {
  const FS: any;
  export default FS;
}

// @zenfs/core 与 zen-fs-gitee 在打包时保持「外置」（见 vite.config.ts 的 external），
// 由消费端通过 import map 提供（指向已验证的自包含 bundle）。
declare module '@zenfs/core' {
  export function resolveMountConfig(config: {
    backend: unknown;
    token?: string;
    owner: string;
    repo: string;
    branch?: string;
    [key: string]: unknown;
  }): Promise<any>;
  const _default: any;
  export default _default;
}

declare module 'zen-fs-gitee' {
  export const Gitee: unknown;
  const _default: any;
  export default _default;
}

/**
 * zen-fs-cache：通用的 zen-fs 缓存层。
 * 同样是运行时外置包（消费端通过 import map 提供），这里只声明最小类型。
 * 参考 https://npmjs.com/package/zen-fs-cache
 */
declare module 'zen-fs-cache' {
  export class CachedFileSystem {
    constructor(inner: any, store: any, options?: { ttlMs?: number });
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<any>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: any): Promise<any>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void>;
    write(path: string, buffer: Uint8Array, offset: number): Promise<void>;
  }
  export class MemoryCacheStore {
    purgeKeepFiles(): Promise<void>;
  }
  export class IdbCacheStore {
    constructor(prefix?: string, dbName?: string, storeName?: string);
    purgeKeepFiles(): Promise<void>;
  }
}
