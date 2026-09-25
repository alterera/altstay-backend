import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3Service, extractObjectKeyFromUrl } from './s3.service';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

const baseEnv: Record<string, string> = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_FORCE_PATH_STYLE: 'true',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'alterstay-images',
  S3_PUBLIC_BASE_URL: 'https://media.alterstay.in/alterstay-images',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
};

function configFor(env: Record<string, string | undefined>): ConfigService {
  return { get: (name: string) => env[name] } as unknown as ConfigService;
}

function createService(overrides: Record<string, string | undefined> = {}) {
  return new S3Service(configFor({ ...baseEnv, ...overrides }));
}

const storage = {
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'alterstay-images',
  publicBaseUrl: 'https://media.alterstay.in/alterstay-images',
};

describe('S3Service (MinIO AIStor)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('client configuration', () => {
    it('targets the AIStor endpoint with path-style requests and explicit credentials', () => {
      createService();

      expect(S3Client).toHaveBeenCalledWith({
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: 'test-access-key',
          secretAccessKey: 'test-secret-key',
        },
      });
    });

    it('normalizes a trailing slash on the endpoint', () => {
      createService({ S3_ENDPOINT: 'http://127.0.0.1:9000/' });

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'http://127.0.0.1:9000' }),
      );
    });

    it.each([
      'S3_ENDPOINT',
      'S3_FORCE_PATH_STYLE',
      'S3_REGION',
      'S3_BUCKET',
      'S3_PUBLIC_BASE_URL',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
    ])('fails fast when %s is missing', (name) => {
      expect(() => createService({ [name]: undefined })).toThrow(name);
      expect(() => createService({ [name]: '   ' })).toThrow(name);
      expect(S3Client).not.toHaveBeenCalled();
    });

    it('does not accept legacy AWS variable names as a fallback', () => {
      expect(
        () =>
          new S3Service(
            configFor({
              AWS_REGION: 'us-east-1',
              AWS_ACCESS_KEY_ID: 'legacy',
              AWS_SECRET_ACCESS_KEY: 'legacy',
              S3_BUCKET: 'alterstay-images',
              S3_PUBLIC_BASE_URL: 'https://media.alterstay.in/alterstay-images',
            }),
          ),
      ).toThrow('S3_ENDPOINT');
    });

    it.each(['false', '1', 'yes'])(
      'rejects S3_FORCE_PATH_STYLE=%s',
      (value) => {
        expect(() => createService({ S3_FORCE_PATH_STYLE: value })).toThrow(
          'S3_FORCE_PATH_STYLE must be true',
        );
      },
    );

    it('accepts S3_FORCE_PATH_STYLE regardless of case', () => {
      expect(() =>
        createService({ S3_FORCE_PATH_STYLE: 'TRUE' }),
      ).not.toThrow();
    });

    it.each(['127.0.0.1:9000', 'not a url', 'ftp://127.0.0.1:9000'])(
      'rejects an invalid S3_ENDPOINT (%s)',
      (value) => {
        expect(() => createService({ S3_ENDPOINT: value })).toThrow(
          'S3_ENDPOINT',
        );
      },
    );

    it('rejects an S3_ENDPOINT with a path', () => {
      expect(() =>
        createService({
          S3_ENDPOINT: 'http://127.0.0.1:9000/alterstay-images',
        }),
      ).toThrow('S3_ENDPOINT must not include a path');
    });

    it.each(['media.alterstay.in/alterstay-images', '/alterstay-images'])(
      'rejects a non-absolute S3_PUBLIC_BASE_URL (%s)',
      (value) => {
        expect(() => createService({ S3_PUBLIC_BASE_URL: value })).toThrow(
          'S3_PUBLIC_BASE_URL',
        );
      },
    );

    it('allows an http public base URL outside production', () => {
      const service = createService({
        S3_PUBLIC_BASE_URL: 'http://localhost:9000/alterstay-images',
      });

      expect(service.publicUrlForKey('properties/p1/a.jpg')).toBe(
        'http://localhost:9000/alterstay-images/properties/p1/a.jpg',
      );
    });

    it('requires an https public base URL in production', () => {
      expect(() =>
        createService({
          NODE_ENV: 'production',
          S3_PUBLIC_BASE_URL: 'http://media.alterstay.in/alterstay-images',
        }),
      ).toThrow('S3_PUBLIC_BASE_URL must use https:// in production');
      expect(() => createService({ NODE_ENV: 'production' })).not.toThrow();
    });
  });

  describe('public URLs', () => {
    it('builds URLs from S3_PUBLIC_BASE_URL', () => {
      expect(createService().publicUrlForKey('properties/123/abc.jpg')).toBe(
        'https://media.alterstay.in/alterstay-images/properties/123/abc.jpg',
      );
    });

    it('handles trailing slashes on S3_PUBLIC_BASE_URL', () => {
      const service = createService({
        S3_PUBLIC_BASE_URL: 'https://media.alterstay.in/alterstay-images///',
      });

      expect(service.publicUrlForKey('properties/123/abc.jpg')).toBe(
        'https://media.alterstay.in/alterstay-images/properties/123/abc.jpg',
      );
    });

    it('encodes key segments but keeps separators', () => {
      expect(
        createService().publicUrlForKey('properties/123/my photo.jpg'),
      ).toBe(
        'https://media.alterstay.in/alterstay-images/properties/123/my%20photo.jpg',
      );
    });

    it('rewrites internal endpoint URLs to public URLs for display', async () => {
      await expect(
        createService().toDisplayUrl(
          'http://127.0.0.1:9000/alterstay-images/properties/123/abc.jpg',
        ),
      ).resolves.toBe(
        'https://media.alterstay.in/alterstay-images/properties/123/abc.jpg',
      );
    });

    it('leaves unrelated URLs untouched for display', async () => {
      const url = 'https://images.unsplash.com/photo-1.jpg';
      await expect(createService().toDisplayUrl(url)).resolves.toBe(url);
    });
  });

  describe('extractObjectKeyFromUrl', () => {
    it.each([
      'https://media.alterstay.in/alterstay-images/properties/123/abc.jpg',
      'http://127.0.0.1:9000/alterstay-images/properties/123/abc.jpg',
      'https://media.alterstay.in/alterstay-images/properties/123/abc.jpg?v=2',
    ])('extracts the key from %s', (url) => {
      expect(extractObjectKeyFromUrl(url, storage)).toBe(
        'properties/123/abc.jpg',
      );
    });

    it('supports a differently configured public base URL', () => {
      expect(
        extractObjectKeyFromUrl(
          'https://cdn.example.test/media/properties/1/a.jpg',
          {
            ...storage,
            publicBaseUrl: 'https://cdn.example.test/media',
          },
        ),
      ).toBe('properties/1/a.jpg');
    });

    it('supports nested keys', () => {
      expect(
        extractObjectKeyFromUrl(
          'https://media.alterstay.in/alterstay-images/properties/123/rooms/deluxe/abc.jpg',
          storage,
        ),
      ).toBe('properties/123/rooms/deluxe/abc.jpg');
    });

    it('decodes URL-encoded keys', () => {
      expect(
        extractObjectKeyFromUrl(
          'https://media.alterstay.in/alterstay-images/properties/123/my%20photo%2B1.jpg',
          storage,
        ),
      ).toBe('properties/123/my photo+1.jpg');
    });

    it.each([
      'not a url',
      'https://media.alterstay.in/alterstay-images/properties/%E0%A4%A.jpg',
      'https://media.alterstay.in/alterstay-images/',
      'https://media.alterstay.in/other-bucket/properties/123/abc.jpg',
      'https://media.alterstay.in/alterstay-images-old/properties/123/abc.jpg',
      'http://127.0.0.1:9000/other-bucket/properties/123/abc.jpg',
      'https://evil.example/alterstay-images/properties/123/abc.jpg',
      'https://alterstay-images.s3.us-east-1.amazonaws.com/properties/123/abc.jpg',
      'https://alterstay-images.s3.amazonaws.com/properties/123/abc.jpg',
    ])('returns null for %s', (url) => {
      expect(extractObjectKeyFromUrl(url, storage)).toBeNull();
    });
  });

  describe('upload', () => {
    it('puts the object in the configured bucket and returns its public URL', async () => {
      mockSend.mockResolvedValueOnce({});
      const file = {
        originalname: 'room.png',
        mimetype: 'image/png',
        size: 3,
        buffer: Buffer.from('abc'),
      } as Express.Multer.File;

      const url = await createService().uploadPropertyImage('prop-1', file);

      const input = jest.mocked(PutObjectCommand).mock.calls[0][0];
      expect(input).toEqual({
        Bucket: 'alterstay-images',
        Key: expect.stringMatching(
          /^properties\/prop-1\/[0-9a-f-]{36}\.png$/,
        ) as string,
        Body: file.buffer,
        ContentType: 'image/png',
        ContentLength: 3,
      });
      expect(input).not.toHaveProperty('ACL');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(url).toBe(
        `https://media.alterstay.in/alterstay-images/${input.Key}`,
      );
    });

    it('defaults the extension to .jpg', async () => {
      mockSend.mockResolvedValueOnce({});
      await createService().uploadPropertyImage('prop-1', {
        originalname: 'image',
        mimetype: 'image/jpeg',
        size: 1,
        buffer: Buffer.from('a'),
      } as Express.Multer.File);

      expect(jest.mocked(PutObjectCommand).mock.calls[0][0].Key).toMatch(
        /\.jpg$/,
      );
    });
  });

  describe('delete', () => {
    it('deletes the key from the configured bucket', async () => {
      mockSend.mockResolvedValueOnce({});

      await createService().deleteObject('properties/123/abc.jpg');

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'alterstay-images',
        Key: 'properties/123/abc.jpg',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('propagates storage failures', async () => {
      mockSend.mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        createService().deleteObject('properties/123/abc.jpg'),
      ).rejects.toThrow('connection refused');
    });
  });
});
