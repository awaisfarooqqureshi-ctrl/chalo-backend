const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

// PROVIDER SELECTION: 'GCS' or 'LOCAL'
const PROVIDER = process.env.STORAGE_PROVIDER || 'GCS';

class StorageService {
    constructor() {
        if (PROVIDER === 'GCS') {
            const storage = new Storage();
            this.publicBucket = storage.bucket(process.env.GCS_PUBLIC_BUCKET || 'chalodrive-assets');
            this.privateBucket = storage.bucket(process.env.GCS_PRIVATE_BUCKET || 'chalodrive-docs');
        }
    }

    async upload(fileBuffer, originalName, mimeType, isSensitive = false) {
        const fileName = `${isSensitive ? 'documents' : 'uploads'}/${Date.now()}_${originalName.replace(/\s+/g, '_')}`;

        if (PROVIDER === 'GCS') {
            return this.uploadToGCS(fileBuffer, fileName, mimeType, isSensitive);
        } else {
            return this.uploadToLocal(fileBuffer, fileName);
        }
    }

    async uploadToGCS(buffer, fileName, mimeType, isSensitive) {
        const bucket = isSensitive ? this.privateBucket : this.publicBucket;
        const blob = bucket.file(fileName);

        await blob.save(buffer, {
            contentType: mimeType,
            resumable: false,
            metadata: { cacheControl: 'public, max-age=31536000' }
        });

        if (isSensitive) {
            return `gs://${bucket.name}/${fileName}`;
        } else {
            return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        }
    }

    async uploadToLocal(buffer, fileName) {
        // For self-hosted servers: Save to local disk
        const localPath = path.join(__dirname, '../public', fileName);
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(localPath, buffer);
        const baseUrl = process.env.LOCAL_BASE_URL || 'http://localhost:8080';
        return `${baseUrl}/public/${fileName}`;
    }

    async getSignedUrl(url, expiresInMinutes = 15) {
        if (!url) return null;
        if (PROVIDER !== 'GCS' || !url.startsWith('gs://')) return url;

        const withoutScheme = url.slice('gs://'.length);
        const separator = withoutScheme.indexOf('/');
        if (separator <= 0) return null;

        const bucketName = withoutScheme.slice(0, separator);
        const fileName = withoutScheme.slice(separator + 1);
        const [signedUrl] = await new Storage().bucket(bucketName).file(fileName).getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + expiresInMinutes * 60 * 1000
        });
        return signedUrl;
    }
}

module.exports = new StorageService();
