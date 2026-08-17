import type { Finding } from '../ir/types.js';
import type { EnvVarUse } from '../mcp/env.js';

export interface EmittedFile {
  /** 相对输出根的路径 */
  path: string;
  content: string;
}

/** 转换时用户可以调的旋钮。默认值就是不传时的行为，调用方不必每处都写全 */
export interface ProjectionOptions {
  /**
   * 用户点名的环境变量改名（旧名 → 新名）。这是改名的**唯一**来源：不给就一律保留
   * 插件作者写下的名字。变量真正归谁只有用户知道（例如令牌属于多个插件共用的一台
   * MCP hub），而改错名的代价是让用户去 export 一个上游文档里根本不存在的变量。
   */
  envNames?: Map<string, string>;
}

export interface ProjectionResult {
  manifest: Record<string, unknown>;
  /** 目标清单应写到的相对路径 */
  manifestPath: string;
  /** 除清单外还需写出的文件（如 .mcp.json、改写过的 frontmatter） */
  files: EmittedFile[];
  findings: Finding[];
  /** 这个插件用到的环境变量，以及各自被怎么处理了 */
  envVars: EnvVarUse[];
}
