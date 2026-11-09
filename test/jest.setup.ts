import { jest } from '@jest/globals';
import { createRequire } from 'module';
import * as path from 'path';

Object.assign(globalThis, {
  jest,
  require: createRequire(path.join(process.cwd(), 'package.json')),
  __dirname: path.join(process.cwd(), 'libs/nestjs-profiler/src/services'),
});
