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
    testEnvironmentOptions: {
        runScripts: 'unsafe',
    },
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};