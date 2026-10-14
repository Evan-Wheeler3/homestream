import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  /** Combined stdout and stderr (the last ~256 KB). */
  output: string;
}

export interface RunOptions {
  /** Called for every line (split on \n and \r, since progress lines use \r). */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 256 * 1024;

/** Run a program without a shell (arguments are never interpreted). */
export const runProcess: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let output = '';
    let partial = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-MAX_OUTPUT);
      if (!options.onLine) return;
      partial += text;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line) options.onLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (partial && options.onLine) options.onLine(partial);
      resolve({ code, output });
    });
  });
