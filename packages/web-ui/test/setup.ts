import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Not `globals: true`, so RTL's own auto-cleanup never registers (it looks for
// a global `afterEach`): register the one cleanup it cannot.
afterEach(() => cleanup());
