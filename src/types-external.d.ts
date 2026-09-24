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
