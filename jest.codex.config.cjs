module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'es2021',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          noImplicitAny: false,
        },
      },
    ],
  },
  testMatch: [
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/api-tokens/api-token.service.spec.ts',
    '<rootDir>/apps/backend/src/services/auth/permissions/scope.guard.spec.ts',
    '<rootDir>/apps/backend/src/services/auth/instance-admin.middleware.spec.ts',
    '<rootDir>/apps/backend/src/public-api/routes/v1/admin/admin.controller.spec.ts',
  ],
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
  },
};
