import { config } from 'zod';

// Run before importing the shared schemas. WeChat runtimes can expose the
// Function constructor while blocking dynamically generated parsers at call time.
config({ jitless: true });
