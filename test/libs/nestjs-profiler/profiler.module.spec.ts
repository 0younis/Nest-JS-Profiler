import 'reflect-metadata';

jest.mock('pg', () => ({}), { virtual: true });

import { ProfilerModule } from '../../../libs/nestjs-profiler/src/profiler.module';

describe('ProfilerModule.initialize', () => {
  it('does not invoke provider prototype getters while scanning event handlers', () => {
    let getterCalls = 0;
    class QueueLikeProvider {
      get client() {
        getterCalls += 1;
        throw new Error('connection is not initialized');
      }
    }

    const modules = new Map([
      [
        'test',
        {
          providers: new Map([['queue', { instance: new QueueLikeProvider() }]]),
          controllers: new Map(),
        },
      ],
    ]);
    const explorer = { initialize: jest.fn() };
    const eventCollector = { setListenerNames: jest.fn() };
    const app = {
      container: { getModules: () => modules },
      get: jest.fn((token: { name: string }) => {
        if (token.name === 'EventCollector') return eventCollector;
        if (token.name.endsWith('ExplorerService')) return explorer;
        throw new Error('optional provider is unavailable');
      }),
    };

    ProfilerModule.initialize(app);

    expect(getterCalls).toBe(0);
    expect(eventCollector.setListenerNames).toHaveBeenCalledTimes(1);
  });
});
