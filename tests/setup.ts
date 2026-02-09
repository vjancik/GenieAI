import { afterAll, beforeAll } from 'bun:test';

// Global setup for tests
beforeAll(() => {
	// This will run before all tests
	// Suitable for setting up global mocks or environment variables if needed
	process.env.NODE_ENV = 'test';
});

afterAll(() => {
	// This will run after all tests
});
