import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function requireEnv(config: ConfigService, name: string): string {
  const value = config.get<string>(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required for MinIO AIStor object storage`);
  }
  return value;
}

function parseHttpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      `${name} must not contain credentials, a query string, or a fragment`,
    );
  }
  return url;
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function loadObjectStorageConfig(
  config: ConfigService,
): ObjectStorageConfig {
  const endpointUrl = parseHttpUrl(
    'S3_ENDPOINT',
    requireEnv(config, 'S3_ENDPOINT'),
  );
  if (withoutTrailingSlash(endpointUrl.pathname) !== '') {
    throw new Error('S3_ENDPOINT must not include a path');
  }

  if (requireEnv(config, 'S3_FORCE_PATH_STYLE').toLowerCase() !== 'true') {
    throw new Error('S3_FORCE_PATH_STYLE must be true for MinIO AIStor');
  }

  const publicUrl = parseHttpUrl(
    'S3_PUBLIC_BASE_URL',
    requireEnv(config, 'S3_PUBLIC_BASE_URL'),
  );
  if (
    config.get<string>('NODE_ENV') === 'production' &&
    publicUrl.protocol !== 'https:'
  ) {
    throw new Error('S3_PUBLIC_BASE_URL must use https:// in production');
  }

  return {
    endpoint: endpointUrl.origin,
    region: requireEnv(config, 'S3_REGION'),
    bucket: requireEnv(config, 'S3_BUCKET'),
    publicBaseUrl: `${publicUrl.origin}${withoutTrailingSlash(publicUrl.pathname)}`,
    accessKeyId: requireEnv(config, 'S3_ACCESS_KEY'),
    secretAccessKey: requireEnv(config, 'S3_SECRET_KEY'),
  };
}

/**
 * Accepts only URLs under the public media base or the internal path-style
 * endpoint for the configured bucket; anything else is not ours to delete.
 */
export function extractObjectKeyFromUrl(
  url: string,
  config: Pick<ObjectStorageConfig, 'endpoint' | 'bucket' | 'publicBaseUrl'>,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const bases = [config.publicBaseUrl, `${config.endpoint}/${config.bucket}`];
  for (const base of bases) {
    const baseUrl = new URL(base);
    const prefix = `${withoutTrailingSlash(baseUrl.pathname)}/`;
    if (
      parsed.origin !== baseUrl.origin ||
      !parsed.pathname.startsWith(prefix)
    ) {
      continue;
    }
    const encodedKey = parsed.pathname.slice(prefix.length);
    if (!encodedKey) return null;
    try {
      return decodeURIComponent(encodedKey);
    } catch {
      return null;
    }
  }
  return null;
}

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly storage: ObjectStorageConfig;

  constructor(config: ConfigService) {
    this.storage = loadObjectStorageConfig(config);
    this.client = new S3Client({
      endpoint: this.storage.endpoint,
      region: this.storage.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.storage.accessKeyId,
        secretAccessKey: this.storage.secretAccessKey,
      },
    });
  }

  extractObjectKey(url: string): string | null {
    return extractObjectKeyFromUrl(url, this.storage);
  }

  publicUrlForKey(key: string): string {
    return `${this.storage.publicBaseUrl}/${encodeKey(key)}`;
  }

  toDisplayUrl(storedUrl: string): Promise<string> {
    const key = this.extractObjectKey(storedUrl);
    return Promise.resolve(key ? this.publicUrlForKey(key) : storedUrl);
  }

  toDisplayUrls(urls: string[]): Promise<string[]> {
    return Promise.all(urls.map((url) => this.toDisplayUrl(url)));
  }

  async uploadPropertyImage(
    propertyId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const ext = extname(file.originalname) || '.jpg';
    const key = `properties/${propertyId}/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.size,
      }),
    );

    return this.publicUrlForKey(key);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );
  }
}
