import { createControlApp } from "./app.js";
import { PublicationResolver } from "./entrypoints/publication-resolver.js";
import type { UploadUrlSigner } from "./storage/index.js";

/**
 * A test-only control entrypoint. It keeps the deployable default Worker
 * signer-free while allowing the real HTTP publication flow to run in
 * workerd without external R2 credentials.
 */
const localTestSigner: UploadUrlSigner = {
  async signUpload(input) {
    return `https://upload.test/${encodeURIComponent(input.key)}`;
  },
};

export { PublicationResolver };

export default createControlApp({
  prepare: { signer: localTestSigner },
  contracts: { signer: localTestSigner },
});
