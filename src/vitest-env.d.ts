/// <reference types="vitest/globals" />

// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveAttribute, ...) on Vitest's Assertion interface for the TypeScript
// compiler. Runtime registration happens separately in vitest.setup.ts.
import '@testing-library/jest-dom/vitest';
