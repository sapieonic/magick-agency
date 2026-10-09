import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Not `globals: true`: register only the cleanup RTL cannot register itself.
afterEach(() => cleanup());
