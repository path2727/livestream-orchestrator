module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true }],
    },
    moduleNameMapper: {
        '^(\\...+?)\\.js$': '$1',
    },
    globals: {
        'ts-jest': {
            useESM: true,
        },
    },
    runner: 'jest-node',  // Optional, but helps with ESM
    testRunner: 'jest-circus/runner',
    // Add this for experimental-vm-modules
    testEnvironmentOptions: {
        runScripts: 'unsafe',
    },
    // Run with node flags
    testRunner: 'jest-circus/runner',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],  // We'll add this file next
};