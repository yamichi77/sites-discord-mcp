// Initialize Zod's schema constructors before SDK schemas in a single-file bundle.
// esbuild 0.25 can otherwise defer this shared module behind Better Auth imports.
import './zod-bootstrap.js';
export { default } from './worker.js';
