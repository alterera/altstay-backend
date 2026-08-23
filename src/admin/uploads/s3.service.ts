import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const DISPLAY_URL_TTL_SECONDS = 60 * 60;

function buildCanonicalBaseUrl(bucket: string, region: string): string {
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/**
 * Access Point aliases (`…-s3alias`) are bucket-name substitutes for the S3 API,
 * not public website hostnames. Bare aliases must not be stored as https://alias/key.
 */
function normalizePublicBaseUrl(
  value: string | undefined,
  bucket: string,
  region: string,
): string {
  const fallback = buildCanonicalBaseUrl(bucket, region);
  if (!value) return fallback;

  let trimmed = value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  try {
    const url = new URL(trimmed);
    if (!url.hostname.includes('.')) {
      if (url.hostname.endsWith('-s3alias')) {
        return `https://${url.hostname}.s3-accesspoint.${region}.amazonaws.com`;
      }
      return fallback;
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return fallback;
  }
}

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicBaseUrl: string;
  private readonly signDisplayUrls: boolean;

  constructor(private readonly config: ConfigService) {
    this.region = this.config.getOrThrow<string>('AWS_REGION');
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    this.publicBaseUrl = normalizePublicBaseUrl(
      this.config.get<string>('S3_PUBLIC_BASE_URL'),
      this.bucket,
      this.region,
    );
    this.signDisplayUrls =
      this.config.get<string>('S3_SIGN_DISPLAY_URLS') === 'true';

    this.client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
    });
  }

  extractObjectKey(url: string): string | null {
    const withoutQuery = url.split('?')[0] ?? url;
    const knownPrefixes = [
      `${this.publicBaseUrl}/`,
      `${buildCanonicalBaseUrl(this.bucket, this.region)}/`,
      `https://${this.bucket}.s3.amazonaws.com/`,
    ];
    for (const prefix of knownPrefixes) {
      if (withoutQuery.startsWith(prefix)) {
        return decodeURIComponent(withoutQuery.slice(prefix.length));
      }
    }

    const aliasMatch = withoutQuery.match(
      /^https?:\/\/[^/]+-s3alias(?:\.s3-accesspoint\.[^/]+)?\/(.+)$/i,
    );
    if (aliasMatch?.[1]) return decodeURIComponent(aliasMatch[1]);

    const propertyKey = withoutQuery.match(/\/(properties\/.+)$/);
    return propertyKey?.[1] ? decodeURIComponent(propertyKey[1]) : null;
  }

  async toDisplayUrl(storedUrl: string): Promise<string> {
    const key = this.extractObjectKey(storedUrl);
    if (!key) return storedUrl;

    // Public buckets already serve the object; presigning every image is a
    // round-trip to AWS and is what made admin/search property loads feel stuck.
    if (!this.signDisplayUrls) {
      return `${this.publicBaseUrl}/${key}`;
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: DISPLAY_URL_TTL_SECONDS },
    );
  }

  async toDisplayUrls(urls: string[]): Promise<string[]> {
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
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.size,
      }),
    );

    return `${this.publicBaseUrl}/${key}`;
  }

  async deleteByUrl(url: string): Promise<void> {
    const key = this.extractObjectKey(url);
    if (!key) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
