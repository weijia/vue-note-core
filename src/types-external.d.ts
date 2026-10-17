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
