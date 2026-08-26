// S3Adapter.js
// Amazon S3 and MinIO compatible storage adapter

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import StorageAdapter from '../StorageAdapter.js';
import { generateThumbnails, isImageMimeType, getImageMetadata } from '../thumbnail.js';
import mime from 'mime-types';

// S3 metadata values must be printable ASCII (0x20–0x7E). Strip anything else.
const toAsciiMeta = (s) => (s || '').replace(/[^\x20-\x7E]/g, '').trim();

export default class S3Adapter extends StorageAdapter {
  constructor(config = {}) {
    super(config);

    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl; // Optional CDN URL

    if (!this.bucket) {
      throw new Error('S3Adapter requires bucket configuration');
    }

    const credentials = config.accessKeyId
      ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
      : undefined;

    this.client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint, // For MinIO
      credentials,
      forcePathStyle: config.forcePathStyle || false, // Required for MinIO
    });

    // A second client whose endpoint is the *publicly-reachable* host, used
    // only for generating presigned URLs. Without this, signed URLs inherit
    // S3_ENDPOINT (typically localhost) and can't be fetched by phones,
    // remote federation peers, or anyone outside the server's loopback.
    // Falls back to the internal client when no public URL is configured.
    if (this.publicUrl) {
      const publicEndpoint = new URL(this.publicUrl).origin;
      this.presignClient = new S3Client({
        region: config.region || 'us-east-1',
        endpoint: publicEndpoint,
        credentials,
        forcePathStyle: true,
      });
    } else {
      this.presignClient = this.client;
    }
  }

  async upload(buffer, options) {
    const {
      originalFileName,
      actorId,
      title,
      summary,
      contentType,
      generateThumbnail = false,
      thumbnailSizes = [200, 400],
      isPublic = true,
      prefix = '',
    } = options;

    const key = this.generateKey(originalFileName, prefix);
    const mimeType = contentType || mime.lookup(originalFileName) || 'application/octet-stream';

    // File contents under a given storage key are immutable, so the bytes can
    // be cached aggressively — 1 year, private (the proxy enforces visibility).
    const cacheControl = 'private, max-age=31536000, immutable';

    // Upload main file
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        CacheControl: cacheControl,
        ACL: isPublic ? 'public-read' : 'private',
        Metadata: {
          'original-filename': toAsciiMeta(originalFileName),
          'actor-id': toAsciiMeta(actorId),
          title: toAsciiMeta(title),
          summary: toAsciiMeta(summary),
        },
      })
    );

    const result = {
      key,
      url: isPublic ? this.getPublicUrl(key) : null,
      thumbnails: null,
      metadata: {
        size: buffer.length,
        contentType: mimeType,
        originalFileName,
        actorId,
        title,
        summary,
      },
    };

    // Generate and upload thumbnails for images
    if (generateThumbnail && isImageMimeType(mimeType)) {
      try {
        const imageMetadata = await getImageMetadata(buffer);
        result.metadata.width = imageMetadata.width;
        result.metadata.height = imageMetadata.height;

        const thumbnails = await generateThumbnails(buffer, thumbnailSizes);
        result.thumbnails = {};

        for (const [size, thumbBuffer] of Object.entries(thumbnails)) {
          const thumbKey = `thumbnails/${key.replace(/\.[^.]+$/, '')}_${size}.webp`;

          await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: thumbKey,
              Body: thumbBuffer,
              ContentType: 'image/webp',
              CacheControl: cacheControl,
              ACL: isPublic ? 'public-read' : 'private',
            })
          );

          result.thumbnails[size] = this.getPublicUrl(thumbKey);
        }
      } catch (err) {
        console.error('[S3Adapter] Thumbnail generation failed:', err.message);
      }
    }

    return result;
  }

  async uploadStream(stream, options) {
    const {
      originalFileName,
      actorId,
      title,
      summary,
      contentType,
      size,
      isPublic = true,
    } = options;

    const key = this.generateKey(originalFileName);
    const mimeType = contentType || mime.lookup(originalFileName) || 'application/octet-stream';

    // Use multipart upload for streams
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: mimeType,
        ACL: isPublic ? 'public-read' : 'private',
        Metadata: {
          'original-filename': toAsciiMeta(originalFileName),
          'actor-id': toAsciiMeta(actorId),
          title: toAsciiMeta(title),
          summary: toAsciiMeta(summary),
        },
      },
    });

    await upload.done();

    return {
      key,
      url: isPublic ? this.getPublicUrl(key) : null,
      thumbnails: null,
      metadata: {
        size: size || null,
        contentType: mimeType,
        originalFileName,
        actorId,
        title,
        summary,
      },
    };
  }

  async delete(key) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      // Try to delete thumbnails
      const baseName = key.replace(/\.[^.]+$/, '');
      for (const size of [200, 400, 800, 1200]) {
        try {
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: `thumbnails/${baseName}_${size}.webp`,
            })
          );
        } catch {
          // Thumbnail might not exist
        }
      }

      return true;
    } catch (err) {
      if (err.name === 'NoSuchKey') return false;
      throw err;
    }
  }

  async exists(key) {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  getPublicUrl(key) {
    if (this.publicUrl) {
      return `${this.publicUrl}/${key}`;
    }

    // Construct URL from endpoint/bucket
    if (this.config.endpoint) {
      // MinIO style
      return `${this.config.endpoint}/${this.bucket}/${key}`;
    }

    // Standard S3 URL
    const region = this.config.region || 'us-east-1';
    return `https://${this.bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  async getSignedUrl(key, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getS3SignedUrl(this.presignClient, command, { expiresIn });
  }

  async getMetadata(key) {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    return {
      size: response.ContentLength,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      etag: response.ETag,
      metadata: response.Metadata,
    };
  }

  async getStream(key, range = null) {
    const params = { Bucket: this.bucket, Key: key };
    if (range) params.Range = range;
    const response = await this.client.send(new GetObjectCommand(params));
    return response.Body;
  }

  async listAllObjects(prefix = '') {
    const keys = []
    let continuationToken

    do {
      const resp = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }))
      for (const obj of resp.Contents ?? []) {
        keys.push(obj.Key)
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
    } while (continuationToken)

    return keys
  }

  async replace(key, buffer, options = {}) {
    const { contentType = 'application/octet-stream', isPublic = false } = options;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'private, max-age=31536000, immutable',
        ACL: isPublic ? 'public-read' : 'private',
      })
    );
  }
}
