/** Image ingestion: blob in, embedded image block out. */

export type { DecodedImage, EncodedImage, ImageEnvironment, ImageSource } from './env.js';
export { base64ToBytes, browserImageEnvironment, bytesToBase64 } from './env.js';

export type { IngestedImage, IngestOptions, IngestWarning, IngestWarningCode } from './ingest.js';
export { dataUri, fit, ingestImage, isEmbedded, parseDataUri } from './ingest.js';
