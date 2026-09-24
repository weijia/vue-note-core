import { NotebookProvider, ProviderConfig } from '../types';
import { PouchDBProvider } from './PouchDBProvider';
import { GitProvider } from './GitProvider';
import { WebDAVProvider } from './WebDAVProvider';

/**
 * 工厂函数：根据 type 创建对应 Provider 实例。
 */
export function createProvider(
  type: string,
  name: string,
  config: ProviderConfig,
): NotebookProvider {
  switch (type) {
    case 'pouchdb':
      return new PouchDBProvider(name);
    case 'git':
      return new GitProvider(name);
    case 'webdav':
      return new WebDAVProvider(name);
    default:
      throw new Error('未知的 Provider 类型: ' + type);
  }
}
