import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Minimal S3-compatible stand-in for R2, for the upload e2e (`R2_ENDPOINT` points here). Serves
 * the server-side calls (CreateMultipartUpload, ListParts, CompleteMultipartUpload,
 * AbortMultipartUpload, HeadObject) and the browser's presigned PUTs with CORS, exposing `ETag`
 * like the bucket CORS rule does. Signatures are not verified (apps/web/test-db/fake-r2.ts does
 * that at the unit level). `failPuts` forces failures for chosen part numbers.
 */
export const FAKE_S3 = {
  port: Number(process.env.E2E_FAKE_S3_PORT ?? 54399),
  bucket: 'lumra-originals-e2e',
  accountId: 'e2e-account',
  accessKeyId: 'AKIDE2EFAKE',
  secretAccessKey: 'e2e-fake-secret-access-key',
};
export const FAKE_S3_ENDPOINT = `http://127.0.0.1:${FAKE_S3.port}`;

interface Upload {
  key: string;
  parts: Map<number, { etag: string; size: number }>;
}

export class FakeS3 {
  readonly objects = new Map<string, number>();
  readonly uploads = new Map<string, Upload>();
  /** `"PUT part 2"` etc., in arrival order. */
  readonly log: string[] = [];
  /** partNumber → how many upcoming PUTs of that part answer 500. */
  readonly failPuts = new Map<number, number>();
  private server: Server | null = null;

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    return new Promise((resolve) => this.server!.listen(FAKE_S3.port, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'PUT, GET, HEAD');
    // Like an R2 CORS rule with AllowedHeaders ["*"] (the e2e also adds x-forwarded-for).
    res.setHeader(
      'Access-Control-Allow-Headers',
      String(req.headers['access-control-request-headers'] ?? 'content-type'),
    );
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', FAKE_S3_ENDPOINT);
    const prefix = `/${FAKE_S3.bucket}/`;
    if (!url.pathname.startsWith(prefix))
      return this.xml(res, 404, '<Error><Code>NoSuchBucket</Code></Error>');
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const q = url.searchParams;
    const body = await readBody(req);

    if (req.method === 'POST' && q.has('uploads')) {
      const uploadId = `up-${randomUUID()}`;
      this.uploads.set(uploadId, { key, parts: new Map() });
      return this.xml(
        res,
        200,
        `<InitiateMultipartUploadResult><Bucket>${FAKE_S3.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'PUT') {
      const partNumber = Number(q.get('partNumber') ?? 1);
      this.log.push(`PUT part ${partNumber}`);
      const failures = this.failPuts.get(partNumber) ?? 0;
      if (failures > 0) {
        this.failPuts.set(partNumber, failures - 1);
        res.statusCode = 500;
        res.end();
        return;
      }
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      if (q.has('uploadId')) {
        const upload = this.uploads.get(q.get('uploadId')!);
        if (!upload) return this.xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        upload.parts.set(partNumber, { etag, size: body.length });
      } else {
        this.objects.set(key, body.length);
      }
      res.setHeader('ETag', etag);
      res.statusCode = 200;
      res.end();
      return;
    }
    if (req.method === 'GET' && q.has('uploadId')) {
      const upload = this.uploads.get(q.get('uploadId')!);
      if (!upload) return this.xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
      const parts = [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(
          ([n, p]) =>
            `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag}</ETag><Size>${p.size}</Size></Part>`,
        )
        .join('');
      return this.xml(
        res,
        200,
        `<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`,
      );
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const upload = this.uploads.get(q.get('uploadId')!);
      if (!upload) return this.xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
      let size = 0;
      for (const p of upload.parts.values()) size += p.size;
      this.objects.set(key, size);
      this.uploads.delete(q.get('uploadId')!);
      return this.xml(
        res,
        200,
        `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"multi"</ETag></CompleteMultipartUploadResult>`,
      );
    }
    if (req.method === 'DELETE') {
      this.uploads.delete(q.get('uploadId') ?? '');
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      const size = this.objects.get(key);
      res.statusCode = size === undefined ? 404 : 200;
      if (size !== undefined) {
        res.setHeader('Content-Length', String(size));
        res.setHeader('ETag', '"obj"');
        res.setHeader('Content-Type', 'image/jpeg');
      }
      res.end();
      return;
    }
    return this.xml(res, 501, '<Error><Code>NotImplemented</Code></Error>');
  }

  private xml(res: ServerResponse, status: number, body: string): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
