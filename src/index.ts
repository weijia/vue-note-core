// 引入默认样式（通过 "./style.css" 子路径导出）
import './style.css';

export * from './types';
export * from './providers';
export * from './sync';
export { useNotebook } from './useNotebook';
export type { UseNotebookReturn } from './useNotebook';

import { useNotebook } from './useNotebook';
import { createProvider } from './providers';
import { SyncEngine } from './sync';

/**
 * 默认导出：常用入口的集合（ESM named + default 均可用）。
 * 注意：接口类型只可用具名导入（import type）。
 */
const NoteCore = {
  useNotebook,
  createProvider,
  SyncEngine,
};

export default NoteCore;
