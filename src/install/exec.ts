import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** 用 execFile 而不是 exec：参数以数组传入，不经 shell，杜绝注入与引号问题 */
export const execRunner: Runner = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: 'utf8' });
  return { stdout, stderr };
};

export async function runOrThrow(run: Runner, cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args);
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new Error(
      `command failed: ${cmd} ${args.join(' ')}\n${e.stderr?.trim() || e.message}`,
    );
  }
}
