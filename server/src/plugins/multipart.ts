import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Multipart parsing for the upload route.
 *
 * The limits are the point of this file. `fileSize` has to allow a full-resolution phone photo,
 * which is what forced the nginx vhost's `client_max_body_size` up from the 8 MB the box's other
 * sites use. The two numbers must agree, or the failure is a 413 from nginx that never reaches the
 * server and therefore never appears in its log - see deploy/README.md.
 */

export interface MultipartPluginOptions {
  maxUploadBytes: number;
}

const multipartPlugin: FastifyPluginAsync<MultipartPluginOptions> = async (fastify, options) => {
  await fastify.register(multipart, {
    limits: {
      fileSize: options.maxUploadBytes,
      // One image and one metadata field per request. Anything else is a malformed client.
      files: 1,
      fields: 4,
      fieldSize: 16 * 1024,
    },
  });
};

export default fp(multipartPlugin, { name: 'multipart' });
