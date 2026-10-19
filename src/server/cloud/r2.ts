// Uploading to the private R2 bucket from the Mac, over R2's S3-compatible API.
// Big files go up in parts (resumable); every part's MD5 is checked against
// what R2 reports, and so is the whole file's multipart checksum.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { AwsClient } from 'aws4fetch';

/** R2 needs every part but the last to be the same size. */
export const PART_BYTES = 64 * 1024 * 1024;

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET || 'wheelhouse-media',
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

export interface MultipartState {
  key: string;
  uploadId: string;
  size: number;
  /** Part number → ETag (quoted, as R2 returns it). */
  parts: Record<number, string>;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest();

async function readPart(
  file: string,
  part: number,
  size: number,
  partBytes: number,
): Promise<Buffer> {
  const start = (part - 1) * partBytes;
  const length = Math.min(partBytes, size - start);
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(file, 'r');
  try {
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) throw new Error(`${file} got shorter while uploading`);
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer;
}

export class R2Uploader {
  private readonly client: AwsClient;
  /** Base wait between retries (shorter in tests). */
  retryDelayMs = 1000;
  private readonly base: string;

  constructor(
    config: R2Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly partBytes = PART_BYTES,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;
  }

  private url(key: string, query = '') {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}${query}`;
  }

  private async send(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      try {
        const signed = await this.client.sign(url, init);
        const res = await this.fetchImpl(signed);
        if (res.ok || res.status === 404 || attempt >= attempts || res.status < 500) return res;
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
      await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
    }
  }

  async head(
    key: string,
  ): Promise<{ size: number; etag: string; meta: Record<string, string> } | null> {
    const res = await this.send(this.url(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD ${key} failed (${res.status})`);
    const meta: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
    });
    return {
      size: Number(res.headers.get('content-length')),
      etag: res.headers.get('etag') ?? '',
      meta,
    };
  }

  /** A small file in one request (artwork, subtitles), checked with Content-MD5. */
  async put(key: string, body: Uint8Array | string, contentType: string) {
    const data = typeof body === 'string' ? Buffer.from(body) : body;
    const res = await this.send(this.url(key), {
      method: 'PUT',
      body: data as Uint8Array<ArrayBuffer>,
      headers: { 'Content-Type': contentType, 'Content-MD5': md5(data).toString('base64') },
    });
    if (!res.ok) throw new Error(`Uploading ${key} failed (${res.status}): ${await res.text()}`);
  }

  async delete(key: string) {
    await this.send(this.url(key), { method: 'DELETE' });
  }

  /**
   * Uploads a big file in parts, resuming `state` when given (parts already up
   * are skipped). `save` is called after every part so a stopped upload can
   * pick up where it left off.
   */
  async uploadFile(
    file: string,
    key: string,
    options: {
      contentType: string;
      metadata?: Record<string, string>;
      state?: MultipartState | null;
      save?: (state: MultipartState) => void;
      onProgress?: (bytesDone: number, size: number) => void;
      concurrency?: number;
    },
  ): Promise<{ etag: string }> {
    const size = (await fs.promises.stat(file)).size;
    const partCount = Math.max(1, Math.ceil(size / this.partBytes));
    let state = options.state?.key === key && options.state.size === size ? options.state : null;
    if (state) {
      // Check the parts R2 still has (unfinished uploads expire after a week).
      const listed = await this.send(
        this.url(key, `?uploadId=${encodeURIComponent(state.uploadId)}`),
      );
      if (listed.ok) {
        const xml = await listed.text();
        const have = new Map<number, string>();
        for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
          have.set(Number(tag(m[1]!, 'PartNumber')), tag(m[1]!, 'ETag') ?? '');
        }
        for (const n of Object.keys(state.parts).map(Number)) {
          if (have.get(n)?.replace(/&quot;/g, '"') !== state.parts[n]) delete state.parts[n];
        }
      } else state = null;
    }
    if (!state) {
      const headers: Record<string, string> = { 'Content-Type': options.contentType };
      for (const [k, v] of Object.entries(options.metadata ?? {})) headers[`x-amz-meta-${k}`] = v;
      const created = await this.send(this.url(key, '?uploads'), { method: 'POST', headers });
      if (!created.ok) throw new Error(`Starting the upload of ${key} failed (${created.status})`);
      const uploadId = tag(await created.text(), 'UploadId');
      if (!uploadId) throw new Error('R2 didn’t return an upload id');
      state = { key, uploadId, size, parts: {} };
      options.save?.(state);
    }

    const s = state;
    const partSize = (n: number) => Math.min(this.partBytes, size - (n - 1) * this.partBytes);
    let done = Object.keys(s.parts).reduce((sum, n) => sum + partSize(Number(n)), 0);
    options.onProgress?.(done, size);
    const todo = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !s.parts[n]);
    const workers = Array.from(
      { length: Math.min(options.concurrency ?? 3, todo.length) },
      async () => {
        for (let n = todo.shift(); n !== undefined; n = todo.shift()) {
          const data = await readPart(file, n, size, this.partBytes);
          const digest = md5(data);
          const res = await this.send(
            this.url(key, `?partNumber=${n}&uploadId=${encodeURIComponent(s.uploadId)}`),
            {
              method: 'PUT',
              body: data as Uint8Array<ArrayBuffer>,
              headers: { 'Content-MD5': digest.toString('base64') },
            },
          );
          if (!res.ok) throw new Error(`Uploading part ${n} of ${key} failed (${res.status})`);
          const etag = res.headers.get('etag') ?? '';
          if (etag.replace(/"/g, '') !== digest.toString('hex')) {
            throw new Error(`Part ${n} of ${key} arrived damaged (checksum mismatch)`);
          }
          s.parts[n] = etag;
          done += data.length;
          options.save?.(s);
          options.onProgress?.(done, size);
        }
      },
    );
    await Promise.all(workers);

    const body =
      '<CompleteMultipartUpload>' +
      Array.from(
        { length: partCount },
        (_, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${s.parts[i + 1]}</ETag></Part>`,
      ).join('') +
      '</CompleteMultipartUpload>';
    const completed = await this.send(
      this.url(key, `?uploadId=${encodeURIComponent(s.uploadId)}`),
      {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/xml' },
      },
    );
    const xml = await completed.text();
    if (!completed.ok || /<Error>/.test(xml)) {
      throw new Error(
        `Finishing the upload of ${key} failed (${completed.status}): ${tag(xml, 'Message') ?? ''}`,
      );
    }
    // The finished object's ETag is the MD5 of the parts' MD5s: check it, and the size.
    const expected = `${createHash('md5')
      .update(
        Buffer.concat(
          Array.from({ length: partCount }, (_, i) =>
            Buffer.from(s.parts[i + 1]!.replace(/"/g, ''), 'hex'),
          ),
        ),
      )
      .digest('hex')}-${partCount}`;
    const head = await this.head(key);
    if (!head || head.size !== size) {
      throw new Error(`${key} is ${head?.size ?? 0} bytes in storage, not ${size}`);
    }
    if (head.etag.replace(/"/g, '') !== expected) {
      throw new Error(`${key} checksum in storage doesn’t match (${head.etag} vs ${expected})`);
    }
    return { etag: head.etag };
  }
}

/** SHA-256 of a file, read in a stream. */
export async function sha256File(
  file: string,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
    onProgress?.(bytes);
  }
  return hash.digest('hex');
}
