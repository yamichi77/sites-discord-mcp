import { z } from 'zod/v4';
// Keep this eager initialization before SDK schema modules in the bundled entry.
z.object({}).parse({});
